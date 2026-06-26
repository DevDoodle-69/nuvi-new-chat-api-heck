import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
const MAX_MEMORY_TURNS = 100;

class MemoryManager {
  constructor() {
    this.db = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = fs.readFileSync(MEMORY_FILE, 'utf8');
        Object.entries(JSON.parse(data)).forEach(([key, value]) => {
          this.db.set(key, value);
        });
      }
    } catch (error) {}
  }

  saveToDisk() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(this.db), null, 2));
    } catch (error) {}
  }

  getConversation(convoid) {
    return this.db.get(convoid) || [];
  }

  updateConversation(convoid, history) {
    if (history.length > MAX_MEMORY_TURNS * 2) {
      history = history.slice(history.length - (MAX_MEMORY_TURNS * 2));
    }
    this.db.set(convoid, history);
    this.saveToDisk();
  }
}

const memory = new MemoryManager();

app.all('/chat', async (req, res) => {
  const msg = req.query.msg || req.body.msg;
  const convoid = req.query.convoid || req.body.convoid || randomUUID();
  const system = req.query.system || req.body.system || "You are NUVI, a highly advanced humanoid AI.";
  const streamParam = req.query.stream || req.body.stream;
  const isStreaming = String(streamParam).toLowerCase() === 'true';

  if (!msg) {
    return res.status(400).json({ error: 'Missing required parameter: msg' });
  }

  const history = memory.getConversation(convoid);
  
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: msg }
  ];

  const payload = {
    model: 'openai-large',
    messages: messages,
    referrer: 'https://g4f.dev/',
    seed: '10352102',
    temperature: 1.0,
    max_tokens: 2048,
    stream: isStreaming
  };

  if (isStreaming) {
    payload.stream_options = { include_usage: true };
  }

  try {
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).send(errorText);
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullAiResponse = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (!done) {
          buffer += decoder.decode(value, { stream: true });
        } else if (buffer.length === 0) {
          break;
        }

        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop();

        for (const line of lines) {
          res.write(line + '\n');
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const chunk = JSON.parse(trimmed.slice(6));
              let textPart = chunk.choices?.[0]?.delta?.content;
              if (!textPart && chunk.response != null) {
                textPart = String(chunk.response);
              }
              if (textPart) {
                fullAiResponse += textPart;
              }
            } catch (e) {}
          }
        }
        if (done) break;
      }

      memory.updateConversation(convoid, [...history, { role: 'user', content: msg }, { role: 'assistant', content: fullAiResponse }]);
      res.end();

    } else {
      const data = await response.json();
      const aiResponseText = data.choices?.[0]?.message?.content ?? '';

      memory.updateConversation(convoid, [...history, { role: 'user', content: msg }, { role: 'assistant', content: aiResponseText }]);

      res.json({
        convoid,
        response: aiResponseText
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT);
