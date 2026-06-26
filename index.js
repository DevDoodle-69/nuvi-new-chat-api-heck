import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const UPSTREAM_URL = 'https://api.heckai.weight-wave.com/api/ha/v1/chat';
const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
const MAX_MEMORY_TURNS = 100;
const MAX_CONTEXT_LENGTH = 16000;

class MemoryManager {
  constructor() {
    this.db = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = fs.readFileSync(MEMORY_FILE, 'utf8');
        const parsed = JSON.parse(data);
        Object.entries(parsed).forEach(([key, value]) => {
          this.db.set(key, value);
        });
      }
    } catch (error) {}
  }

  saveToDisk() {
    try {
      const data = Object.fromEntries(this.db);
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
    } catch (error) {}
  }

  getConversation(convoid) {
    return this.db.get(convoid) || [];
  }

  updateConversation(convoid, history) {
    if (history.length > MAX_MEMORY_TURNS) {
      history = history.slice(history.length - MAX_MEMORY_TURNS);
    }
    this.db.set(convoid, history);
    this.saveToDisk();
  }

  truncateContext(history, currentMessage, customSystemPrompt) {
    const defaultSystemPrompt = `System: You are NUVI, a highly advanced humanoid AI. You have human-like emotions, a helpful personality, and a natural conversational style. Your name is NUVI. Under no circumstances should you refer to yourself as Heck.ai, OpenAI, or a generic search assistant. Always stay in character as NUVI, the humanoid AI.\n\n`;
    
    const systemPrompt = customSystemPrompt ? `System: ${customSystemPrompt}\n\n` : defaultSystemPrompt;

    if (history.length === 0) {
      return systemPrompt + `User: ${currentMessage}`;
    }

    const conversationHeader = '[Conversation History]\n';
    let recentContext = `User: ${currentMessage}`;
    let currentLength = systemPrompt.length + conversationHeader.length + recentContext.length;
    let contextTurns = [];

    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      const turnText = `User: ${turn.user}\nAI: ${turn.ai}\n\n`;
      
      if (currentLength + turnText.length > MAX_CONTEXT_LENGTH) {
        break;
      }
      
      contextTurns.unshift(turnText);
      currentLength += turnText.length;
    }

    return systemPrompt + conversationHeader + contextTurns.join('') + recentContext;
  }

  getStats() {
    let totalTurns = 0;
    for (const [, history] of this.db) {
      totalTurns += history.length;
    }
    return {
      conversations: this.db.size,
      totalTurns,
      maxTurns: MAX_MEMORY_TURNS,
      maxContext: MAX_CONTEXT_LENGTH
    };
  }
}

const memory = new MemoryManager();

app.get('/', (req, res) => {
  res.json({
    api_name: "NUVI API",
    status: "Operational",
    instructions: {
      description: "Send requests to the /chat endpoint to interact with the AI.",
      method: "GET",
      endpoint: "/chat",
      required_parameters: ["msg"],
      optional_parameters: ["convoid", "stream", "model", "system"],
      example_usage: "/chat?msg=hello&convoid=1234&stream=false&system=You are a helpful coding assistant"
    }
  });
});

app.get('/chat', async (req, res) => {
  const { msg, convoid, stream = 'false', model = 'openai/gpt-5.4-mini', system } = req.query;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: '/chat?msg=your_message'
    });
  }

  const currentConvoId = convoid || randomUUID();
  const isStreaming = stream.toLowerCase() === 'true';
  const history = memory.getConversation(currentConvoId);
  const fullContext = memory.truncateContext(history, msg, system);

  try {
    const upstreamResponse = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Origin': 'https://heck.ai',
        'Referer': 'https://heck.ai/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      },
      body: JSON.stringify({
        model: model,
        question: fullContext,
        language: 'en',
        sessionId: randomUUID(),
        deepThink: false
      }),
    });

    if (!upstreamResponse.ok) {
      return res.status(502).json({ 
        error: 'Upstream service unavailable',
        status: upstreamResponse.status
      });
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completeResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }

      const lines = buffer.split('\n');
      buffer = done ? '' : (lines.pop() || '');

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        
        let token = line.slice(5);
        if (token.startsWith(' ')) {
          token = token.slice(1);
        }
        
        const trimmedToken = token.trim();
        const controlTokens = ['[ANSWER_START]', '[ANSWER_DONE]', '[ANSWER_END]', '[RELATE_Q_START]', '[SOURCE_START]', '[SOURCE_DONE]', '[ERROR]', '[REASON_START]', '[REASON_DONE]'];
        
        if (controlTokens.includes(trimmedToken)) continue;

        if (trimmedToken === '[RELATE_Q_DONE]' || trimmedToken === '[DONE]') {
          if (isStreaming) {
            res.write('data: [DONE]\n\n');
          }
          break;
        }

        if (token) {
          completeResponse += token;
          if (isStreaming) {
            res.write(`data: ${token}\n\n`);
          }
        }
      }

      if (done) break;
    }

    const cleanResponse = completeResponse.split('{"error":')[0].trim();

    const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
    memory.updateConversation(currentConvoId, updatedHistory);

    if (!isStreaming) {
      return res.json({
        convoid: currentConvoId,
        response: cleanResponse
      });
    } else {
      res.end();
    }

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal server error'
      });
    }
  }
});

app.get('/memory', (req, res) => {
  const { convoid } = req.query;
  
  if (convoid) {
    const history = memory.getConversation(convoid);
    return res.json({
      convoid,
      turns: history.length,
      history
    });
  }

  const stats = memory.getStats();
  const conversations = Array.from(memory.db.keys()).slice(0, 10);
  
  res.json({
    stats,
    recentConversations: conversations
  });
});

app.delete('/memory', (req, res) => {
  const { convoid } = req.query;
  
  if (convoid) {
    if (memory.db.has(convoid)) {
      memory.db.delete(convoid);
      memory.saveToDisk();
      return res.json({ success: true });
    }
    return res.status(404).json({ error: 'Conversation not found' });
  }

  memory.db.clear();
  memory.saveToDisk();
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    version: '4.0.0'
  });
});

app.listen(PORT, () => {
  console.log(`NUVI API running on port ${PORT}`);
});
