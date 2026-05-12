# Claude project notes

Reference for Claude when working in this repo. Keep it terse — `BUILD_GUIDE.md` has the long-form rationale.

## What this is

iMessage AI video editor. Linq webhook → download user media → Claude picks template → Shotstack renders → reply to user with rendered video. 3-day build.

## Stack

- TypeScript (ESM, `"type": "module"`), Node 20+
- Express, Prisma + Postgres, zod, pino
- `@anthropic-ai/sdk` for the LLM (structured outputs via `output_config` + `zodOutputFormat`)
- Shotstack REST for rendering
- Cloudflare R2 for media storage
- Deployed to Render (single always-on instance, no queue service)

## Project layout

```
src/
  env.ts          # zod-validated env loader (import from anywhere)
  logger.ts       # pino instance — ALWAYS import this, never console.log
  index.ts        # entrypoint: wires Express + worker + recovery sweep
  webhook.ts      # POST /webhook — verify HMAC, validate, insert Job, 200 fast
  admin.ts        # GET /admin/jobs (gated by ADMIN_SECRET), GET /healthz
  state.ts        # advance(job) — pure decision logic, no I/O
  worker.ts       # setInterval loop: claim → advance → persist
  recovery.ts     # boot-time sweep of stale claims
  db.ts           # Prisma client singleton
  stubs/          # fake external API impls for Day 1
prisma/
  schema.prisma   # single Job model
```

Relative imports must end in `.js` (ESM/NodeNext rule), even though source files are `.ts`.

## Job types

`Job.type` is `"video"` (has ≥1 media part) or `"chat"` (text-only message). The webhook decides this; `advance()` branches on it. `Job.chatId` is the Linq chat ID (extracted from the payload), indexed for conversation-history queries.

## State machine

State names are **past-tense** — each describes what's been completed.

**Video pipeline:** `received → downloaded → matched → submitted → rendered → uploaded → delivered`

| State | What advance() does | Next |
|---|---|---|
| `received` | download all media parts, normalize each with ffmpeg (autorotate + H.264 + cap 1280px), upload to R2; store first clip's normalized dims as `outputSize` | `downloaded` |
| `downloaded` | match template via Anthropic | `matched` |
| `matched` | build Shotstack edit (R2 clip URLs, output sized to `outputSize`), submit render | `submitted` |
| `submitted` | poll render status; self-loop (5s) until `done` | `rendered` |
| `rendered` | fetch render output, pre-upload to Linq Attachments | `uploaded` |
| `uploaded` | send video reply via Linq | `delivered` |

**Chat pipeline:** `received → replied` — `advanceChatJob` loads recent chat history + the most recent video job's status for this `chatId`, calls Claude (Sonnet 4.6) for a conversational reply, sends it via `sendTextReply`, stores it in `result.reply`. See `src/services/chat.ts`.

Terminal states: `delivered` (video success), `replied` (chat success), `failed` (error path, `error` populated). The worker's claim SQL and recovery sweep treat all three as terminal.

Self-loop / throttled-poll state: `submitted` — re-claims each tick but only polls Shotstack every 5s (gated by `result.nextPollAt`).

**Media normalization (`src/services/transcode.ts`):** every uploaded media part is normalized to a clean H.264 MP4 clip *before* it touches Shotstack.
- **Videos** → ffmpeg with `-autorotate` (default on) bakes rotation into the pixels (iPhone portrait videos store a landscape frame + a `rotate 90°` display matrix that Shotstack — neither Ingest nor render — applies), transcodes HEVC→H.264, caps the long side at 1280px, faststart.
- **Images** (`image/*`) → `sharp` decodes (including HEIC, which ffmpeg-static can't), auto-rotates from EXIF orientation, resizes to fit within 1280×1280; ffmpeg then loops it into a 6-second clip.

Either way the result is a uniform video clip. The first clip's normalized dimensions size the render output, so output orientation always matches the (first) source — portrait→portrait, landscape→landscape, image or video.

`advance(job)` is in `src/state.ts`. Pure async: takes the job, runs the side effect for the current state, returns next state + a result patch (shallow-merged into `job.result`).

## Hard rules

- Validate at every I/O boundary with zod: webhook body, env, LLM response, Shotstack response. Never trust unparsed JSON.
- Webhook handler returns 200 fast. All real work happens on the worker tick. Linq retries non-2xx up to 10× over ~25 min.
- Idempotency: use Linq's `event_id` as `Job.externalId` (unique constraint). Retries become no-ops.
- HMAC: signature is over `{timestamp}.{raw_body}`. Use `express.raw({ type: 'application/json' })` on the webhook route. Never let `express.json()` touch the body before verification — re-serialization breaks the signature.
- Job claims: `SELECT ... FOR UPDATE SKIP LOCKED` (via Prisma `$queryRaw`). Safe across instances even though v1 is single-instance.
- Every state transition persists to DB before doing anything else. Crash recovery depends on this.
- On boot, run a sweep: release any rows with `claimedAt` older than 60s.

## External APIs

### Linq Partner API v3
- Base URL: `https://api.linqapp.com/api/partner/v3`
- Auth: `Authorization: Bearer $LINQ_API_KEY`
- Webhook signature header: `X-Webhook-Signature`, HMAC-SHA256 hex, over `{timestamp}.{raw_body}`
- Inbound event type: `message.received`. Media in `data.parts[].type === "media"` with presigned `url` (1h TTL).
- Send: `POST /v3/chats/{chatId}/messages` with `{ message: { parts: [{ type: "media", attachment_id }], idempotency_key } }`
- Attach video via pre-upload (Attachments endpoint, 100MB cap), not URL (10MB cap).

### Shotstack
- `callback` field per render request for webhooks; payload `{ id, status, url, error, completed }`. Not signed.
- Day 1 plan: poll, not webhook (one fewer endpoint to test).

### Anthropic
- `client.messages.parse({ output_config: { format: zodOutputFormat(Schema) } })`
- Response in `response.parsed_output` (typed). Models: `claude-opus-4-7` (default), `claude-sonnet-4-6` (cheaper).

## Day 1 scope

End-to-end skeleton with stubs. No real external API calls. Deploy to Render. Smoke test: curl webhook → see job walk every state to `done` via `/admin/jobs`.

## Logging

Always use `logger` from `src/logger.ts`. Always include `jobId` on log lines tied to a job. Pino renders pretty in dev, JSON in prod (Render captures stdout).

## Don't

- Don't use `console.log` — use pino.
- Don't write tests Day 1 (smoke test only).
- Don't add ESLint/Prettier unless asked.
- Don't introduce abstractions for hypothetical future needs.
- Don't catch errors just to re-log them with no recovery — let them bubble and fail the state.
