import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = 'AQ.Ab8RN6LyGOxxDFKnkxUso0J-uQTUTJ-vIZ9yxlaE-9Wym2gk7A';
const MODEL = 'models/gemini-3-flash-preview';

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
  let context = `System: ${system}\n\n`;
  
  for (const turn of history) {
    context += `${turn.role === 'user' ? 'User' : 'NUVI'}: ${turn.content}\n\n`;
  }
  context += `User: ${msg}`;

  const payload = {
    model: MODEL,
    input: context,
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

  try {
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${API_KEY}`;
    const url = isStreaming ? `${baseUrl}&alt=sse` : baseUrl;

    const response = await fetch(url, {
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (dataStr && dataStr !== '[DONE]') {
              try {
                const dataObj = JSON.parse(dataStr);
                const textPart = dataObj.text || dataObj.output || dataObj.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textPart) {
                  fullAiResponse += textPart;
                }
              } catch (e) {}
            }
          }
        }
      }
      
      memory.updateConversation(convoid, [...history, { role: 'user', content: msg }, { role: 'model', content: fullAiResponse }]);
      res.end();

    } else {
      const data = await response.json();
      const aiResponseText = data.text || data.output || data.candidates?.[0]?.content?.parts?.[0]?.text || (typeof data === 'string' ? data : JSON.stringify(data));

      memory.updateConversation(convoid, [...history, { role: 'user', content: msg }, { role: 'model', content: aiResponseText }]);

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
