/**
 * Nuvi Chat API — Standalone Express Server
 *
 * Powered by Pollinations AI (free, no API key needed)
 * Model: openai-fast (GPT-OSS 20B with reasoning)
 *
 * Features:
 *   ✓ Unlimited requests — all queued, none rejected
 *   ✓ Conversation memory per convoid (up to 40 turns)
 *   ✓ System prompt role works every turn
 *   ✓ Chain-of-thought reasoning in every response
 *   ✓ Automatic retry with exponential backoff on rate limits
 *   ✓ CORS enabled (any frontend can call this)
 *
 * Endpoints:
 *   GET  /               → health check + queue status
 *   GET  /chat?msg=&convoid=&system=   → chat with memory
 *   POST /chat           → same, via JSON body  { msg, convoid, system }
 *   DELETE /chat/:convoid → clear conversation history
 *   GET  /conversations  → list active conversations (debug)
 *
 * Example:
 *   curl "https://your-api.onrender.com/chat?msg=Hello&convoid=user1&system=You+are+a+helpful+assistant."
 */

import express from 'express';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Constants ────────────────────────────────────────────────────────────────

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const MODEL            = 'openai-fast';   // GPT-OSS 20B with reasoning (free)
const REFERRER         = 'https://g4f.dev/';
const SEED             = '10352102';
const MAX_HISTORY      = 40;             // max past turns kept per conversation

// ─── Global Request Queue ─────────────────────────────────────────────────────
//
// Every Pollinations request is funnelled through one serial queue.
// Requests NEVER get rejected — they simply wait for earlier ones to finish.
// Pollinations rate-limits by IP; serial processing + auto-retry means the
// caller gets a result every time, no matter how many requests arrive.

class RequestQueue {
  constructor (gapMs = 1500) {
    this._queue = [];
    this._busy  = false;
    this._gapMs = gapMs;   // min gap between consecutive API calls
  }

  enqueue (fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  get depth  () { return this._queue.length; }
  get active () { return this._busy; }

  async _drain () {
    if (this._busy) return;
    this._busy = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try   { resolve(await fn()); }
      catch (err) { reject(err); }
      if (this._queue.length > 0) await sleep(this._gapMs);
    }
    this._busy = false;
  }
}

const queue = new RequestQueue(1500);

// ─── Conversation Store ───────────────────────────────────────────────────────

/**
 * Map<convoid, { systemPrompt: string|null, messages: Array, createdAt, updatedAt }>
 *
 * Data is in-memory → resets on server restart.
 * For persistence across restarts upgrade to a DB-backed store.
 */
const store = new Map();

function getOrCreate (convoid, systemPrompt) {
  if (!store.has(convoid)) {
    store.set(convoid, {
      systemPrompt: null,
      messages    : [],
      createdAt   : Date.now(),
      updatedAt   : Date.now(),
    });
  }
  const conv = store.get(convoid);
  if (systemPrompt && systemPrompt.trim()) {
    conv.systemPrompt = systemPrompt.trim();
  }
  return conv;
}

function buildMessages (convoid, userMsg) {
  const conv = store.get(convoid);
  const out  = [];
  if (conv.systemPrompt) out.push({ role: 'system', content: conv.systemPrompt });
  out.push(...conv.messages);
  out.push({ role: 'user', content: userMsg });
  return out;
}

function recordTurn (convoid, userMsg, assistantReply) {
  const conv = store.get(convoid);
  conv.messages.push(
    { role: 'user',      content: userMsg        },
    { role: 'assistant', content: assistantReply },
  );
  if (conv.messages.length > MAX_HISTORY * 2) {
    conv.messages = conv.messages.slice(-(MAX_HISTORY * 2));
  }
  conv.updatedAt = Date.now();
}

// ─── Pollinations API Client ──────────────────────────────────────────────────

const MAX_RETRIES   = 15;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS  = 30_000;

async function callPollinations (messages) {
  const payload = {
    model      : MODEL,
    messages,
    referrer   : REFERRER,
    seed       : SEED,
    temperature: 1.0,
    max_tokens : 2048,
  };

  let lastErr = new Error('Max retries exceeded');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;

    try {
      res = await fetch(POLLINATIONS_URL, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(payload),
      });
    } catch (netErr) {
      lastErr = netErr;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
      console.warn(`[api] Network error, retrying in ${delay}ms — ${netErr.message}`);
      await sleep(delay);
      continue;
    }

    if (res.status === 429) {
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
      lastErr = new Error(`429 rate limit`);
      console.warn(`[api] Rate limited, waiting ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pollinations [${res.status}]: ${body}`);
    }

    const data = await res.json();

    const msgObj    = data.choices?.[0]?.message ?? {};
    const reply     = msgObj.content ?? '';
    const reasoning = msgObj.reasoning ?? msgObj.reasoning_content ?? null;

    return {
      reply,
      reasoning,
      model: (data.model ?? MODEL).replace('models/', ''),
      usage: data.usage ?? null,
    };
  }

  throw lastErr;
}

// ─── Shared Chat Handler ──────────────────────────────────────────────────────

async function handleChat (msg, convoid, system, res) {
  if (!msg?.trim()) {
    return res.status(400).json({ ok: false, error: '`msg` is required.' });
  }
  if (!convoid?.trim()) {
    return res.status(400).json({ ok: false, error: '`convoid` is required.' });
  }

  getOrCreate(convoid, system);
  const messages = buildMessages(convoid, msg.trim());

  let result;
  try {
    result = await queue.enqueue(() => callPollinations(messages));
  } catch (err) {
    console.error('[chat] API failure:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }

  recordTurn(convoid, msg.trim(), result.reply);

  const conv  = store.get(convoid);
  const turns = Math.floor(conv.messages.length / 2);

  return res.json({
    ok       : true,
    convoid,
    reply    : result.reply,
    reasoning: result.reasoning ?? null,
    turns,
    model    : result.model,
    usage    : result.usage,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.json({
  status   : 'ok',
  service  : 'Nuvi Chat API',
  model    : MODEL,
  endpoints: {
    chat : 'GET /chat?msg=...&convoid=...&system=...',
    chatP: 'POST /chat  { msg, convoid, system }',
    del  : 'DELETE /chat/:convoid',
    list : 'GET /conversations',
  },
  queue: {
    depth : queue.depth,
    active: queue.active,
  },
}));

app.get('/chat',  (req, res) => handleChat(req.query.msg,  req.query.convoid,  req.query.system,  res));
app.post('/chat', (req, res) => handleChat(req.body?.msg,  req.body?.convoid,  req.body?.system,  res));

app.delete('/chat/:convoid', (req, res) => {
  if (store.delete(req.params.convoid)) {
    res.json({ ok: true, message: 'Conversation cleared.' });
  } else {
    res.status(404).json({ ok: false, error: `No conversation for convoid "${req.params.convoid}".` });
  }
});

app.get('/conversations', (_req, res) => {
  const list = [...store.entries()].map(([convoid, c]) => ({
    convoid,
    turns    : Math.floor(c.messages.length / 2),
    hasSystem: !!c.systemPrompt,
    createdAt: new Date(c.createdAt).toISOString(),
    updatedAt: new Date(c.updatedAt).toISOString(),
  }));
  res.json({ count: list.length, conversations: list });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep (ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  Nuvi Chat API  —  port ${PORT}`);
  console.log(`   Model    : ${MODEL}  (Pollinations AI, free)`);
  console.log(`   Queue    : unlimited depth, serial, auto-retry up to ${MAX_RETRIES}x`);
  console.log(`   GET  /chat?msg=Hello&convoid=1&system=You+are+helpful`);
  console.log(`   POST /chat  { "msg":"Hello", "convoid":"1", "system":"..." }\n`);
});
