import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = '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';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
const MAX_MEMORY_TURNS = 200;
const MAX_CONTEXT_LENGTH = 32000;
const SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'system_prompt.json');

class MemoryManager {
  constructor() {
    this.db = new Map();
    this.systemPrompts = new Map();
    this.loadFromDisk();
    this.loadSystemPrompts();
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

  loadSystemPrompts() {
    try {
      if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
        const data = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8');
        const parsed = JSON.parse(data);
        Object.entries(parsed).forEach(([key, value]) => {
          this.systemPrompts.set(key, value);
        });
      }
    } catch (error) {}
  }

  saveSystemPrompts() {
    try {
      const data = Object.fromEntries(this.systemPrompts);
      fs.writeFileSync(SYSTEM_PROMPT_FILE, JSON.stringify(data, null, 2));
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

  getSystemPrompt(convoid) {
    return this.systemPrompts.get(convoid) || null;
  }

  setSystemPrompt(convoid, prompt) {
    this.systemPrompts.set(convoid, prompt);
    this.saveSystemPrompts();
  }

  deleteSystemPrompt(convoid) {
    this.systemPrompts.delete(convoid);
    this.saveSystemPrompts();
  }

  buildMessages(history, currentMessage, systemPromptOverride = null) {
    const messages = [];
    
    let systemPrompt = systemPromptOverride || this.getSystemPrompt('default') || 'You are a helpful, intelligent, and knowledgeable AI assistant. You provide accurate, detailed, and thoughtful responses. You are capable of deep reasoning and maintain context throughout conversations.';
    
    messages.push({
      role: 'system',
      content: systemPrompt
    });

    const recentHistory = history.slice(-MAX_MEMORY_TURNS);
    
    for (const turn of recentHistory) {
      messages.push({
        role: 'user',
        content: turn.user
      });
      messages.push({
        role: 'assistant',
        content: turn.ai
      });
    }

    messages.push({
      role: 'user',
      content: currentMessage
    });

    return messages;
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
      maxContext: MAX_CONTEXT_LENGTH,
      systemPrompts: this.systemPrompts.size
    };
  }
}

const memory = new MemoryManager();

app.get('/', (req, res) => {
  res.json({
    api_name: "NUVI AI API",
    status: "Operational",
    version: "5.0.0",
    instructions: {
      description: "Send requests to the /chat endpoint to interact with NUVI using OpenRouter.",
      method: "GET or POST",
      endpoint: "/chat",
      required_parameters: ["msg"],
      optional_parameters: ["convoid", "stream", "model", "system", "temperature", "max_tokens"],
      example_usage: "/chat?msg=hello&convoid=1234&model=openai/gpt-4o&stream=false"
    }
  });
});

app.get('/chat', async (req, res) => {
  const { msg, convoid, stream = 'false', model = 'openai/gpt-4o', system, temperature = '0.8', max_tokens = '2000' } = req.query;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: '/chat?msg=your_message'
    });
  }

  const currentConvoId = convoid || randomUUID();
  const isStreaming = stream.toLowerCase() === 'true';
  const history = memory.getConversation(currentConvoId);
  
  let systemPrompt = null;
  if (system) {
    const decodedSystem = decodeURIComponent(system);
    memory.setSystemPrompt(currentConvoId, decodedSystem);
    systemPrompt = decodedSystem;
  } else {
    const existingPrompt = memory.getSystemPrompt(currentConvoId);
    if (existingPrompt) {
      systemPrompt = existingPrompt;
    }
  }

  const messages = memory.buildMessages(history, msg, systemPrompt);

  let retryCount = 0;
  const maxRetries = 5;
  let success = false;
  let completeResponse = '';
  let upstreamResponse = null;

  while (retryCount < maxRetries && !success) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const requestBody = {
        model: model,
        messages: messages,
        temperature: parseFloat(temperature),
        max_tokens: parseInt(max_tokens),
        stream: isStreaming,
        top_p: 0.9,
        frequency_penalty: 0.3,
        presence_penalty: 0.3
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://heck.ai',
        'X-Title': 'NUVI AI Assistant'
      };

      if (isStreaming) {
        headers['Accept'] = 'text/event-stream';
      }

      upstreamResponse = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (upstreamResponse.status === 429 || upstreamResponse.status === 503 || upstreamResponse.status === 504) {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status >= 500) {
          retryCount++;
          const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        const errorText = await upstreamResponse.text();
        throw new Error(`Upstream error: ${upstreamResponse.status} - ${errorText}`);
      }

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const reader = upstreamResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
          }

          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() || '');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                break;
              }
              try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                  const token = parsed.choices[0].delta.content;
                  completeResponse += token;
                  res.write(`data: ${JSON.stringify({ token })}\n\n`);
                }
              } catch (e) {}
            }
          }

          if (done) break;
        }

        const cleanResponse = completeResponse.trim();
        const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
        memory.updateConversation(currentConvoId, updatedHistory);

        return res.end();
      } else {
        const responseData = await upstreamResponse.json();
        if (responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
          completeResponse = responseData.choices[0].message.content;
        } else {
          throw new Error('Invalid response format from OpenRouter');
        }

        const cleanResponse = completeResponse.trim();
        const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
        memory.updateConversation(currentConvoId, updatedHistory);

        success = true;

        return res.json({
          convoid: currentConvoId,
          response: cleanResponse,
          model: model,
          tokens: responseData.usage || null
        });
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (retryCount >= maxRetries - 1) {
        if (!res.headersSent) {
          return res.status(500).json({ 
            error: 'Service temporarily unavailable, please try again later',
            details: error.message
          });
        }
      }
      retryCount++;
      const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  if (!success) {
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Service temporarily unavailable, please try again later'
      });
    }
  }
});

app.post('/chat', async (req, res) => {
  const { msg, convoid, stream = false, model = 'openai/gpt-4o', system, temperature = 0.8, max_tokens = 2000 } = req.body;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: {
        method: 'POST',
        endpoint: '/chat',
        body: {
          msg: 'your_message',
          convoid: 'optional_conversation_id',
          stream: false,
          model: 'openai/gpt-4o',
          system: 'optional_system_prompt',
          temperature: 0.8,
          max_tokens: 2000
        }
      }
    });
  }

  const currentConvoId = convoid || randomUUID();
  const isStreaming = stream;
  const history = memory.getConversation(currentConvoId);
  
  let systemPrompt = null;
  if (system) {
    memory.setSystemPrompt(currentConvoId, system);
    systemPrompt = system;
  } else {
    const existingPrompt = memory.getSystemPrompt(currentConvoId);
    if (existingPrompt) {
      systemPrompt = existingPrompt;
    }
  }

  const messages = memory.buildMessages(history, msg, systemPrompt);

  let retryCount = 0;
  const maxRetries = 5;
  let success = false;
  let completeResponse = '';
  let upstreamResponse = null;

  while (retryCount < maxRetries && !success) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const requestBody = {
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: max_tokens,
        stream: isStreaming,
        top_p: 0.9,
        frequency_penalty: 0.3,
        presence_penalty: 0.3
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://heck.ai',
        'X-Title': 'NUVI AI Assistant'
      };

      if (isStreaming) {
        headers['Accept'] = 'text/event-stream';
      }

      upstreamResponse = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (upstreamResponse.status === 429 || upstreamResponse.status === 503 || upstreamResponse.status === 504) {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status >= 500) {
          retryCount++;
          const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        const errorText = await upstreamResponse.text();
        throw new Error(`Upstream error: ${upstreamResponse.status} - ${errorText}`);
      }

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const reader = upstreamResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
          }

          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() || '');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                break;
              }
              try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                  const token = parsed.choices[0].delta.content;
                  completeResponse += token;
                  res.write(`data: ${JSON.stringify({ token })}\n\n`);
                }
              } catch (e) {}
            }
          }

          if (done) break;
        }

        const cleanResponse = completeResponse.trim();
        const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
        memory.updateConversation(currentConvoId, updatedHistory);

        return res.end();
      } else {
        const responseData = await upstreamResponse.json();
        if (responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
          completeResponse = responseData.choices[0].message.content;
        } else {
          throw new Error('Invalid response format from OpenRouter');
        }

        const cleanResponse = completeResponse.trim();
        const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
        memory.updateConversation(currentConvoId, updatedHistory);

        success = true;

        return res.json({
          convoid: currentConvoId,
          response: cleanResponse,
          model: model,
          tokens: responseData.usage || null
        });
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (retryCount >= maxRetries - 1) {
        if (!res.headersSent) {
          return res.status(500).json({ 
            error: 'Service temporarily unavailable, please try again later',
            details: error.message
          });
        }
      }
      retryCount++;
      const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  if (!success) {
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Service temporarily unavailable, please try again later'
      });
    }
  }
});

app.get('/memory', (req, res) => {
  const { convoid } = req.query;
  
  if (convoid) {
    const history = memory.getConversation(convoid);
    const systemPrompt = memory.getSystemPrompt(convoid);
    return res.json({
      convoid,
      turns: history.length,
      history,
      systemPrompt: systemPrompt || null
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
      memory.deleteSystemPrompt(convoid);
      memory.saveToDisk();
      return res.json({ success: true });
    }
    return res.status(404).json({ error: 'Conversation not found' });
  }

  memory.db.clear();
  memory.systemPrompts.clear();
  memory.saveToDisk();
  memory.saveSystemPrompts();
  res.json({ success: true });
});

app.get('/system', (req, res) => {
  const { convoid } = req.query;
  
  if (convoid) {
    const prompt = memory.getSystemPrompt(convoid);
    if (prompt) {
      return res.json({
        convoid,
        systemPrompt: prompt
      });
    }
    return res.status(404).json({ error: 'No system prompt found for this conversation' });
  }

  const allPrompts = Array.from(memory.systemPrompts.entries()).map(([key, value]) => ({
    convoid: key,
    systemPrompt: value
  }));

  res.json({
    systemPrompts: allPrompts,
    total: allPrompts.length
  });
});

app.post('/system', (req, res) => {
  const { convoid, prompt } = req.body;

  if (!convoid || !prompt) {
    return res.status(400).json({
      error: 'Missing required parameters: convoid and prompt are required',
      usage: {
        method: 'POST',
        endpoint: '/system',
        body: {
          convoid: 'your_conversation_id',
          prompt: 'Your custom system prompt here'
        }
      }
    });
  }

  memory.setSystemPrompt(convoid, prompt);
  res.json({
    success: true,
    convoid,
    systemPrompt: prompt,
    message: 'System prompt updated successfully'
  });
});

app.delete('/system', (req, res) => {
  const { convoid } = req.query;

  if (!convoid) {
    return res.status(400).json({
      error: 'Missing required parameter: convoid',
      usage: '/system?convoid=your_conversation_id'
    });
  }

  if (memory.getSystemPrompt(convoid)) {
    memory.deleteSystemPrompt(convoid);
    return res.json({
      success: true,
      convoid,
      message: 'System prompt deleted successfully'
    });
  }

  return res.status(404).json({ error: 'No system prompt found for this conversation' });
});

app.get('/models', async (req, res) => {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    version: '5.0.0',
    provider: 'OpenRouter',
    memory: {
      conversations: memory.db.size,
      systemPrompts: memory.systemPrompts.size
    }
  });
});

app.listen(PORT, () => {
  console.log(`NUVI AI API running on port ${PORT}`);
  console.log(`Using OpenRouter API with model: openai/gpt-4o`);
});
