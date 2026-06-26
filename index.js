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
const MAX_MEMORY_TURNS = 20;
const MAX_CONTEXT_LENGTH = 4000;

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
        console.log(`Loaded ${this.db.size} conversations from disk`);
      }
    } catch (error) {
      console.error('Failed to load memory from disk:', error);
    }
  }

  saveToDisk() {
    try {
      const data = Object.fromEntries(this.db);
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save memory to disk:', error);
    }
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

  truncateContext(history, currentMessage) {
    let context = '';
    const systemPrompt = `[System: You are NUVI, a human-like AI. Respond casually, briefly, and naturally. Avoid robotic lists or disclaimers.]\n\n`;

    if (history.length === 0) {
      return systemPrompt + `User: ${currentMessage}`;
    }

    let fullContext = systemPrompt + '[Conversation History]\n';
    for (const turn of history) {
      const turnText = `User: ${turn.user}\nNUVI: ${turn.ai}\n\n`;
      if ((fullContext + turnText + `User: ${currentMessage}`).length > MAX_CONTEXT_LENGTH) {
        break;
      }
      fullContext += turnText;
    }

    fullContext += `User: ${currentMessage}`;
    return fullContext;
  }

  getStats() {
    let totalTurns = 0;
    for (const [, history] of this.db) {
      totalTurns += history.length;
    }
    return {
      conversations: this.db.size,
      totalTurns,
      maxTurns: MAX_MEMORY_TURNS
    };
  }
}

const memory = new MemoryManager();

app.get('/chat', async (req, res) => {
  const { msg, convoid, stream = 'false', model = 'openai/gpt-5.4-mini' } = req.query;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: '/chat?msg=hello&convoid=optional&stream=true/false&model=optional'
    });
  }

  const currentConvoId = convoid || randomUUID();
  const isStreaming = stream.toLowerCase() === 'true';
  const history = memory.getConversation(currentConvoId);
  const fullContext = memory.truncateContext(history, msg);

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
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText
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
        if (!line.startsWith('data: ')) continue;
        
        const token = line.slice(6).trim();
        const controlTokens = ['[ANSWER_START]', '[ANSWER_DONE]', '[ANSWER_END]', '[RELATE_Q_START]', '[SOURCE_START]', '[SOURCE_DONE]', '[ERROR]', '[REASON_START]', '[REASON_DONE]'];
        
        if (controlTokens.includes(token)) continue;

        if (token === '[RELATE_Q_DONE]' || token === '[DONE]') {
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

    const updatedHistory = [...history, { user: msg, ai: completeResponse }];
    memory.updateConversation(currentConvoId, updatedHistory);

    if (!isStreaming) {
      return res.json({
        convoid: currentConvoId,
        response: completeResponse,
        memory: {
          conversationTurns: updatedHistory.length,
          maxTurns: MAX_MEMORY_TURNS
        }
      });
    } else {
      res.end();
    }

  } catch (error) {
    console.error('Proxy Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal server error',
        details: error.message 
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
    recentConversations: conversations,
    memoryFile: MEMORY_FILE
  });
});

app.delete('/memory', (req, res) => {
  const { convoid } = req.query;
  
  if (convoid) {
    if (memory.db.has(convoid)) {
      memory.db.delete(convoid);
      memory.saveToDisk();
      return res.json({ success: true, message: `Deleted conversation: ${convoid}` });
    }
    return res.status(404).json({ error: 'Conversation not found' });
  }

  memory.db.clear();
  memory.saveToDisk();
  res.json({ success: true, message: 'All memory cleared' });
});

app.get('/health', (req, res) => {
  const stats = memory.getStats();
  res.json({
    status: 'online',
    uptime: process.uptime(),
    memory: stats,
    version: '2.0.0'
  });
});

app.listen(PORT, () => {
  console.log(`NUVI API running on port ${PORT}`);
  console.log(`Memory file: ${MEMORY_FILE}`);
  console.log(`Max turns per conversation: ${MAX_MEMORY_TURNS}`);
});
