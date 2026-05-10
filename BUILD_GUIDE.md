# iMessage AI Video Editor — Build Guide

A reference for what we're building, why each tool is in the stack, and how a request flows through the system. Written so you can come back to it cold and remember the plan.

---

## What we're building

Users send media + a text prompt to an iMessage number (handled by Linq). Our service downloads the media, asks Claude to pick the right TikTok-style template and fill in parameters (music, clip order, text overlays), renders the video with Shotstack, and replies to the user with the final video — all automatic.

**Timeline:** 3 days.
- **Day 1:** End-to-end skeleton with stubs. No real external calls. Deployed to Render.
- **Day 2:** Wire real APIs one at a time — Linq verification, R2 download, Anthropic, Shotstack, Linq reply.
- **Day 3:** Reserved for whatever Day 2 testing uncovers.

---

## The cast (and why each piece is here)

### Express
A small library that lets your Node.js program answer HTTP requests. The front desk of the service — when the internet sends a request, Express hands it to a function we wrote.

### Postgres
A database — a spreadsheet that survives crashes and restarts. We use it to remember every job, what stage it's at, and the original payload. Without it, a server restart would mean "what was I doing 10 seconds ago? no idea."

### Prisma
A translator between TypeScript code and Postgres.

Without a translator, you'd write raw SQL strings inside TypeScript:
```ts
db.query("SELECT * FROM Job WHERE id = '...'")
```
Two problems:
1. Typo a column name → bug at 2am, not at compile time.
2. The result is `unknown` — TypeScript doesn't know what columns exist.

With Prisma:
1. Describe tables once in `schema.prisma`.
2. Run `prisma generate` — Prisma writes a fully-typed TypeScript client.
3. Write `await prisma.job.create({ data: { state: "received", payload: ... } })` — TypeScript yells if you misspell `payload`.

Compile errors instead of midnight bugs. That's why Prisma.

### zod
A runtime shape-checker. TypeScript types vanish at runtime — when JSON arrives from a webhook it's just bytes off the wire, and TypeScript can't verify those bytes match your declared type. zod is a bouncer that, at runtime, says "yes this object has these fields with these types" or rejects it.

We use zod at every I/O boundary:
- Inbound webhook payload
- Environment variables on startup
- LLM response (Claude's JSON output)
- Shotstack response

### pino
A logger. Instead of `console.log("downloaded media")`, we write:
```ts
logger.info({ jobId, stage: "downloading", bytes: 1234 }, "downloaded media")
```
Structured JSON to stdout, which Render captures. Later you can search `jobId=abc123` and see every line related to that job. Massively better than scrolling unstructured text.

### Cloudflare R2
A giant locker for files. Databases are bad at storing big binary blobs (videos, images). R2 is built for it. We download user media from Linq into R2, then hand R2 URLs to Shotstack to render with.

### Anthropic SDK
Talks to Claude. We use it for one job: take the user's prompt + a list of template descriptions, and return a structured JSON response naming which template to use and how to fill it in.

### Shotstack
The video rendering API. We POST a JSON template (clips, music, overlays) and get back a render ID. Then either we poll for status, or it calls our callback URL when done.

### Render
The cloud host — like a friendlier Heroku. We `git push`, Render builds and runs the server.

---

## End-to-end walkthrough

User Sarah texts our number a clip + "make it sad anime style." Here's what happens:

### 1. Linq POSTs to our `/webhook`
A JSON payload describing the message. Our doorbell.

### 2. Verify it's really Linq
Linq attaches `X-Webhook-Signature` — HMAC-SHA256 over `{timestamp}.{raw_body}` using a shared secret. We recompute and compare. Match → genuine. Mismatch → reject.

**Important detail:** the seal is over **raw bytes**, so the webhook route uses `express.raw({ type: 'application/json' })`. If we let `express.json()` parse first and re-serialize, even one whitespace difference breaks the signature.

### 3. Validate the JSON shape with zod
Bouncer check on the parsed body.

### 4. Insert one row into the `Job` table
Keyed on Linq's `event_id` (a unique ID per webhook delivery). Stores the raw payload and sets `state = "received"`.

If Linq retries (it retries non-2xx up to 10 times over ~25 minutes!), the unique constraint on `event_id` makes the second insert a no-op. That's idempotency.

### 5. Return `200 OK` immediately
Crucial — if we tried to download the video and call Claude inside the webhook, that takes 30+ seconds and Linq would think we'd failed and retry. The webhook does almost nothing: verify, save, return.

### 6. Worker loop ticks
Separately, a `setInterval` runs every second. Each tick asks Postgres:

> "Give me one job that isn't finished and isn't already being worked on, and lock it so nobody else grabs it."

The magic SQL phrase is `SELECT … FOR UPDATE SKIP LOCKED` — claims one row, skips rows already claimed. Single Render instance for v1 makes this overkill today, but it's free insurance.

### 7. `advance(job)` runs
A function that looks at the current state and runs the next step:

State names are past-tense — each describes what's been completed.

| State | Action `advance()` runs | Next state |
|---|---|---|
| `received` | Download media from Linq URL into R2 | `downloaded` |
| `downloaded` | Send prompt + template descriptions to Claude | `matched` |
| `matched` | POST merged template to Shotstack | `submitted` |
| `submitted` | Poll Shotstack render status — stay if still rendering | `submitted` (self-loop) or `rendered` |
| `rendered` | Pre-upload rendered video to Linq's Attachments endpoint | `uploaded` |
| `uploaded` | POST to `/v3/chats/{chatId}/messages` with `attachment_id` | `delivered` |

**Every transition is a separate database write.** That's the whole trick — if Render restarts mid-pipeline, we know exactly which step was next, because Postgres remembers.

### 8. Recovery sweep on startup
On boot, find any job stuck in a "claimed" state with a stale `claimedAt` (e.g., older than 60s — meaning the worker that claimed it died) and unclaim it. The next tick picks it up. This is what makes "single in-process worker" safe across deploys.

### 9. Sarah gets her video
Whole thing happens over ~60 seconds. We can send progress updates between state transitions if we want.

---

## Why a state machine, not one big async function?

Picture the job as a sheet of paper with checkboxes: `[ ] downloading` `[ ] matching` `[ ] rendering`...

A function called `advance(job)` looks at which box is next, does that one thing, ticks it, saves the paper, exits. The next tick, another `advance(job)` picks up the paper and does the next box.

Three properties we get for free:

1. **Restart safety** — the paper lives in Postgres, so a crash doesn't lose progress.
2. **Visibility** — `/admin/jobs` lists every paper and shows which box it's on.
3. **Retry granularity** — if Shotstack errored, we retry only `rendering`, not the download and LLM call.

The alternative — one giant `async function processJob()` that awaits each step — looks simpler in the editor but loses all three properties the moment the server restarts.

---

## API reference (resolved from docs)

### Linq Partner API v3
- **Base URL:** `https://api.linqapp.com/api/partner/v3`
- **Auth:** `Authorization: Bearer $LINQ_API_V3_API_KEY`

**Inbound webhook** (`message.received` event):
```json
{
  "api_version": "...",
  "event_id": "unique-per-delivery",
  "event_type": "message.received",
  "webhook_version": "2026-02-03",
  "data": {
    "id": "message-id",
    "direction": "inbound",
    "sender_handle": { "id": "...", "handle": "+1...", "service": "iMessage" },
    "chat": { "id": "chat-uuid" },
    "parts": [
      { "type": "text", "value": "make it sad anime style" },
      {
        "type": "media",
        "id": "...",
        "filename": "clip.mp4",
        "mime_type": "video/mp4",
        "size_bytes": 1234567,
        "url": "https://signed-download-url"
      }
    ]
  }
}
```
- Media URLs are presigned with **1-hour TTL** — must download before they expire.
- Use `event_id` as the idempotency key on the `Job` table.

**Webhook signature:**
- Header: `X-Webhook-Signature`
- Algorithm: HMAC-SHA256, hex-encoded
- Signed payload: `{timestamp}.{raw_body}` — raw bytes, not re-serialized JSON

**Webhook retries:** up to 10 attempts, exponential backoff with jitter, ~25-minute window. Return 200 fast.

**Send reply:**
```
POST /v3/chats/{chatId}/messages
Authorization: Bearer ...
Content-Type: application/json
```
```json
{
  "message": {
    "parts": [
      { "type": "media", "attachment_id": "att_..." }
    ],
    "idempotency_key": "our-job-id"
  }
}
```
- Media options: `url` (10 MB cap, server downloads it) OR `attachment_id` (pre-uploaded, 100 MB cap). **We use pre-upload** because TikTok-style outputs can exceed 10 MB.

### Shotstack
- **Render submission:** include `callback` field per request to receive a webhook on completion.
- **Webhook payload:** `{ id, status, url, error, completed }`. Status values include `done`, `failed`.
- **No HMAC signature** on Shotstack webhooks. On receipt, do a GET to the render endpoint with our API key to confirm before delivering.
- **Day 1 plan:** use polling, not webhooks — one fewer endpoint to test. Switch to webhooks Day 2 if rendering takes long enough to matter.

### Anthropic structured outputs
Use the GA `output_config` parameter with the zod helper (already in our stack):

```ts
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const TemplateChoice = z.object({
  template_id: z.string(),
  music_id: z.string(),
  clip_order: z.array(z.string()),
  text_overlays: z.array(z.object({
    text: z.string(),
    timestamp: z.number(),
  })),
});

const response = await client.messages.parse({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
  output_config: { format: zodOutputFormat(TemplateChoice) },
});

const choice = response.parsed_output; // fully typed
```

Constrained decoding guarantees the response matches the schema. Preferred over `tools` because we have no actual tool execution — just need a structured JSON response.

---

## Day 1 deliverable

End-to-end skeleton with all external calls stubbed:

- `downloadMedia(url)` → waits 500ms, returns `"r2://fake/clip.mp4"`
- `matchTemplate(prompt)` → returns hardcoded `{ template_id: "tmpl_1", music_id: "track_1", clip_order: ["c1"], text_overlays: [] }`
- `submitRender(template)` → returns `"render_fake_123"`
- `pollRender(id)` → returns `{ status: "rendering" }` for first 2 calls, then `{ status: "done", url: "https://fake.cdn/out.mp4" }`
- `uploadToLinq(url)` → returns `"att_fake_456"`
- `sendReply(chatId, attId)` → just logs

**Test:** POST a fake webhook payload locally, watch logs, hit `GET /admin/jobs`, see a job walk every state and reach `done`. Then deploy to Render, repeat against the live URL.

### Day 1 build order

1. **Repo skeleton:** `package.json`, `tsconfig.json`, `.env.example`, zod env loader, pino logger, Prisma init.
2. **Prisma schema:** `Job` table with `id`, `externalId` (unique, idempotency), `state`, `payload` jsonb, `result` jsonb, `error`, `claimedAt`, `claimedBy`, `createdAt`, `updatedAt`.
3. **Express server:** `POST /webhook` (raw body, zod-validated, idempotent insert), `GET /admin/jobs` (secret-gated), `GET /healthz`.
4. **State machine module:** pure `advance(job) → { nextState, sideEffect }`, no I/O — just decides what to do.
5. **Worker loop:** `setInterval` tick claims one job with `FOR UPDATE SKIP LOCKED`, runs the side effect (stubbed), persists next state.
6. **Boot recovery:** on startup, release any rows stuck in `claimed` older than N seconds.
7. **Render deploy:** start command `prisma migrate deploy && node dist/index.js`, Render Postgres attached, env vars set.
8. **Smoke test:** curl webhook, tail logs, watch a job walk every state to `done` via `/admin/jobs`.

---

## Decisions made

- **Single Render instance for v1.** Keeps the in-process worker simple. Recovery sweep on boot handles deploy restarts.
- **Pre-upload to Linq Attachments**, don't pass URL. 10 MB cap on URL-attach is too tight for TikTok-style output; pre-upload allows 100 MB and is more predictable.
- **Polling Shotstack on Day 1**, not webhooks. One fewer endpoint to test; switch to webhooks Day 2 if needed.
- **Anthropic structured outputs via `output_config` + `zodOutputFormat()`** — not tool-calls. We have no real tools; structured outputs are the cleaner fit.
- **No queue service for v1.** Postgres + a worker tick + `FOR UPDATE SKIP LOCKED` is enough.
- **No tests on Day 1.** Smoke test via curl + admin endpoint. Tests come later if useful.

---

## Open questions

- **How many templates at launch?** <~20 fits descriptions directly in the LLM prompt; more needs a retrieval step. (Pending — you'll get back to me.)
