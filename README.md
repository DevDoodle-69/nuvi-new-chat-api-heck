# Nuvi Chat API

A free, unlimited GPT-4 chat API with conversation memory and reasoning — powered by [Pollinations AI](https://pollinations.ai). No API key needed.

## Features

- **Unlimited requests** — all requests are queued, none are ever rejected
- **Conversation memory** — each `convoid` keeps its own history (up to 40 turns)
- **System prompt** — set the AI's role/persona once; it applies to all future turns
- **Reasoning included** — every response includes the model's chain-of-thought
- **Auto-retry** — automatically retries on rate limits (up to 15 times with backoff)
- **CORS enabled** — call from any frontend

---

## Deploy to Render.com

1. Fork / clone this repo to your GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Deploy**
5. Your API will be live at `https://nuvi-chat-api.onrender.com`

Or use the Blueprint button if you have `render.yaml` in the repo.

---

## API Reference

### `GET /chat`

```
GET /chat?msg=Hello&convoid=user123&system=You+are+a+helpful+assistant.
```

| Param    | Required | Description |
|----------|----------|-------------|
| `msg`    | ✅        | The user message |
| `convoid`| ✅        | Conversation ID (any string — used to keep history) |
| `system` | ❌        | System prompt (set the AI's role). Applied once, remembered for all future turns |

**Response:**
```json
{
  "ok": true,
  "convoid": "user123",
  "reply": "Hello! How can I help you today?",
  "reasoning": "The user greeted me. I should respond warmly...",
  "turns": 1,
  "model": "gpt-oss-20b",
  "usage": { "prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42 }
}
```

---

### `POST /chat`

```json
POST /chat
Content-Type: application/json

{
  "msg": "What did I say before?",
  "convoid": "user123",
  "system": "You are a helpful assistant."
}
```

Same response shape as GET.

---

### `DELETE /chat/:convoid`

Clear a conversation's history.

```
DELETE /chat/user123
```

---

### `GET /conversations`

List all active sessions (for debugging).

---

### `GET /`

Health check + queue status.

```json
{
  "status": "ok",
  "service": "Nuvi Chat API",
  "model": "openai-fast",
  "queue": { "depth": 0, "active": false }
}
```

---

## Run Locally

```bash
npm install
npm start
# or for auto-reload:
npm run dev
```

Server starts on port `3000` (or `$PORT` env var).

---

## How the Queue Works

Pollinations AI allows one request per IP at a time (free tier). Instead of rejecting extra requests with an error, this API puts them in an **unlimited serial queue**. Every request eventually gets a response — callers never see a 429 error.

The queue processes requests one at a time with a 1.5s gap between calls, and automatically retries up to 15 times on any rate-limit error using exponential backoff (2s → 4s → 8s … capped at 30s).

---

## Stack

- **Node.js 18+** (native `fetch`, no extra HTTP library needed)
- **Express 4**
- **CORS**
- Zero external AI SDKs — raw fetch to Pollinations API
