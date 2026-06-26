import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = 'xai-gkLBM5O7rEbRbFylNpzvsoSmOVJfpo9zItXb4zWjZ5XSdPL1lUEsdxsGmUJrj9rHBQf0AjT0ngamxFWY';

app.use(cors());
app.use(express.json());

app.all('/chat', async (req, res) => {
  const msg = req.query.msg || req.body.msg;
  const system = req.query.system || req.body.system || "You're NUVI";
  const streamParam = req.query.stream || req.body.stream;
  const isStreaming = String(streamParam).toLowerCase() === 'true';

  if (!msg) {
    return res.status(400).json({ error: 'Missing required parameter: msg' });
  }

  try {
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning',
        instructions: system,
        max_output_tokens: 1000000,
        frequency_penalty: -2,
        text: {
          format: {
            type: 'json_object'
          }
        },
        stream: isStreaming,
        input: msg
      })
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const text = await response.text();
      try {
        res.json(JSON.parse(text));
      } catch (e) {
        res.send(text);
      }
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT);
