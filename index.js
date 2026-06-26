import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = 'AQ.Ab8RN6LyGOxxDFKnkxUso0J-uQTUTJ-vIZ9yxlaE-9Wym2gk7A';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
const MAX_MEMORY_TURNS = 200;
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

  buildInput(history, currentMessage, systemPromptOverride = null) {
    let input = '';
    
    let systemPrompt = systemPromptOverride || this.getSystemPrompt('default') || 'You are NUVI, a highly advanced humanoid AI with human-like emotions, a helpful personality, and a natural conversational style. You are capable of deep reasoning and maintain context throughout conversations. Always respond as NUVI.';
    
    input += `System: ${systemPrompt}\n\n`;
    
    const recentHistory = history.slice(-MAX_MEMORY_TURNS);
    
    for (const turn of recentHistory) {
      input += `User: ${turn.user}\nAssistant: ${turn.ai}\n\n`;
    }
    
    input += `User: ${currentMessage}\nAssistant:`;
    
    return input;
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
      systemPrompts: this.systemPrompts.size
    };
  }
}

const memory = new MemoryManager();

app.get('/', (req, res) => {
  res.json({
    api_name: "NUVI AI API",
    status: "Operational",
    version: "8.0.0",
    provider: "Google Gemini 3 Flash"
  });
});

app.get('/chat', async (req, res) => {
  const { msg, convoid, system } = req.query;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: '/chat?msg=your_message'
    });
  }

  const currentConvoId = convoid || randomUUID();
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

  const input = memory.buildInput(history, msg, systemPrompt);

  let retryCount = 0;
  const maxRetries = 5;
  let success = false;
  let completeResponse = '';

  while (retryCount < maxRetries && !success) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const requestBody = {
        model: "models/gemini-3-flash-preview",
        input: input,
        tools: [
          {
            type: "google_search"
          }
        ],
        generation_config: {
          temperature: 1,
          max_output_tokens: 65536,
          top_p: 0.95,
          thinking_level: "high"
        }
      };

      const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429 || response.status === 503 || response.status === 504) {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        if (response.status >= 500) {
          retryCount++;
          const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        const errorText = await response.text();
        throw new Error(`Upstream error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.output) {
        completeResponse = data.output;
      } else if (data.candidates && data.candidates[0] && data.candidates[0].output) {
        completeResponse = data.candidates[0].output;
      } else if (data.response) {
        completeResponse = data.response;
      } else {
        completeResponse = JSON.stringify(data);
      }

      const cleanResponse = completeResponse.trim();
      const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
      memory.updateConversation(currentConvoId, updatedHistory);

      success = true;

      return res.json({
        convoid: currentConvoId,
        response: cleanResponse,
        model: 'gemini-3-flash-preview'
      });

    } catch (error) {
      if (error.name === 'AbortError') {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (retryCount >= maxRetries - 1) {
        return res.status(500).json({ 
          error: 'Service temporarily unavailable, please try again later',
          details: error.message
        });
      }
      retryCount++;
      const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  if (!success) {
    return res.status(500).json({ 
      error: 'Service temporarily unavailable, please try again later'
    });
  }
});

app.post('/chat', async (req, res) => {
  const { msg, convoid, system } = req.body;

  if (!msg) {
    return res.status(400).json({ 
      error: 'Missing required parameter: msg',
      usage: {
        method: 'POST',
        endpoint: '/chat',
        body: {
          msg: 'your_message',
          convoid: 'optional_conversation_id',
          system: 'optional_system_prompt'
        }
      }
    });
  }

  const currentConvoId = convoid || randomUUID();
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

  const input = memory.buildInput(history, msg, systemPrompt);

  let retryCount = 0;
  const maxRetries = 5;
  let success = false;
  let completeResponse = '';

  while (retryCount < maxRetries && !success) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const requestBody = {
        model: "models/gemini-3-flash-preview",
        input: input,
        tools: [
          {
            type: "google_search"
          }
        ],
        generation_config: {
          temperature: 1,
          max_output_tokens: 65536,
          top_p: 0.95,
          thinking_level: "high"
        }
      };

      const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429 || response.status === 503 || response.status === 504) {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        if (response.status >= 500) {
          retryCount++;
          const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        const errorText = await response.text();
        throw new Error(`Upstream error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.output) {
        completeResponse = data.output;
      } else if (data.candidates && data.candidates[0] && data.candidates[0].output) {
        completeResponse = data.candidates[0].output;
      } else if (data.response) {
        completeResponse = data.response;
      } else {
        completeResponse = JSON.stringify(data);
      }

      const cleanResponse = completeResponse.trim();
      const updatedHistory = [...history, { user: msg, ai: cleanResponse }];
      memory.updateConversation(currentConvoId, updatedHistory);

      success = true;

      return res.json({
        convoid: currentConvoId,
        response: cleanResponse,
        model: 'gemini-3-flash-preview'
      });

    } catch (error) {
      if (error.name === 'AbortError') {
        retryCount++;
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (retryCount >= maxRetries - 1) {
        return res.status(500).json({ 
          error: 'Service temporarily unavailable, please try again later',
          details: error.message
        });
      }
      retryCount++;
      const waitTime = Math.min(2000 * Math.pow(2, retryCount), 30000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  if (!success) {
    return res.status(500).json({ 
      error: 'Service temporarily unavailable, please try again later'
    });
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

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    version: '8.0.0',
    provider: 'Google Gemini 3 Flash',
    model: 'gemini-3-flash-preview'
  });
});

app.listen(PORT, () => {
  console.log(`NUVI AI API running on port ${PORT}`);
  console.log(`Using Google Gemini 3 Flash Preview`);
});
