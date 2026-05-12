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

## Access control (`src/services/access.ts`)

The webhook runs `checkAccess()` before creating a Job. It tracks senders in the `Sender` table (keyed on the Linq `sender_handle.handle` — E.164 phone or email):
- **First-use opt-in:** a brand-new sender gets a "reply OK to start" prompt; replying OK/yes/etc. flips them to `opted_in` and sends a welcome. Until then, no Jobs are created for them.
- **`ACCESS_ALLOWLIST` env var:** comma-separated handles that are auto-`opted_in` on first contact and exempt from the per-minute limit (the dev's test phone goes here so testing isn't interrupted).
- **Per-sender video rate limits:** 50 video edits per UTC day (`videosToday`/`videosTodayDate` on `Sender`), and ≥60s between videos (skipped for allowlisted handles).
- **System-wide budget:** ≤200 video Jobs per UTC day (a `count` query on `Job` where `type=video`).
- Chat messages from opted-in senders are not rate-limited (cheap). All limit replies are static, gen-z-styled strings (no dashes/emoji).

The webhook also dedups on `Job.externalId` (a `findUnique` before `checkAccess`) so Linq's webhook retries don't re-run access checks or double-bump counters.

## The "mastermind" matcher (`src/services/match.ts` → `planEdit`)

`planEdit` is the brain. Given the user's caption + clip count (+ a clarification answer on a re-run), Claude Opus 4.7 returns an `EditPlan` (see `schemas.ts`):
- `confirmation` — short casual line texted to the user ("doing a hype gym edit w bold text"), gen-z styled (scrubbed of dashes/emoji)
- `needs_clarification` + `clarification_question` — set only when the request is genuinely too vague (e.g. no caption)
- `style` — `hype` | `sad` | `chill` | `funny` | `cinematic` (the rendering scaffold — sets text size + a music fallback)
- `music` — a structured `MusicSpec` (see below): `{ tags, freetext, tempo, acoustic_or_electric }`
- `keep_original_audio` — true only if the user asks; else the music plays and source is muted
- `pace` — `very_fast` | `fast` | `medium` | `slow` | `very_slow` (cuts-per-minute in a multi-clip montage; maps to a per-clip duration via `PACE_TO_CLIP_SECONDS` ≈ 1s … 6.5s; ignored for single-clip edits, which use `speed`)
- `speed` — `slow` (≈0.5x slow-mo) | `normal` | `fast` (applied to single-clip edits only)
- `color_filter` — `none` | `vibrant` (Shotstack "boost") | `muted` | `bw` (greyscale) | `dramatic` (contrast)
- `transition` — `cut` | `fade` | `zoom` (between clips; multi-clip only)
- `text_overlays[]` — `{ text, position: top|center|bottom, color: hex/name (sanitized), uppercase }`

The renderer (`src/templates/index.ts` → `buildEdit(plan, clips, outputSize, musicUrl)`) translates the plan to Shotstack JSON. `STYLE_PRESETS` holds per-style defaults (overlay font scale, a fallback `MusicSpec`); `PACE_TO_CLIP_SECONDS` maps `pace` → montage clip duration (with a 2s floor when there are only 2 clips). The matcher's big system prompt is cached (`cache_control: ephemeral`).

## State machine

State names are **past-tense** — each describes what's been completed.

**Video pipeline:** `received → downloaded → matched → submitted → rendered → uploaded → delivered`, with a possible detour `downloaded → awaiting_clarification → downloaded`.

| State | What advance() does | Next |
|---|---|---|
| `received` | filter media parts to video/image (fail "no editable…" otherwise), normalize each **sequentially** with ffmpeg (autorotate + H.264 + cap long side at 1920px) — parallel transcodes thrash the single CPU core and OOM — upload to R2; store first clip's normalized dims as `outputSize` | `downloaded` |
| `downloaded` | `planEdit`. If it needs clarification (and we haven't asked yet): send the question | `awaiting_clarification` |
| `downloaded` | else: send the confirmation + a rough time estimate | `matched` |
| `awaiting_clarification` | (worker doesn't touch it — parked until the user's text reply, which the webhook routes back here as `result.clarificationAnswer` + state `downloaded`) | — |
| `matched` | resolve the music query via Jamendo (`resolveMusicUrl`, fallback to a Shotstack-CDN track), `buildEdit(plan, …)`, submit render | `submitted` |
| `submitted` | poll render status; self-loop (5s) until `done`. If the render drags: text the user "still working on it" at ~4 min, silently resubmit a fresh render once at ~6 min, give up → `failed` at ~9 min (Shotstack's sandbox occasionally wedges a render forever) | `rendered` |
| `rendered` | fetch render output, pre-upload to Linq Attachments | `uploaded` |
| `uploaded` | send video reply via Linq with a "here's ur {style} edit" caption | `delivered` |

**Chat pipeline:** `received → replied` — `advanceChatJob` loads recent chat history + the most recent video job's status, calls Claude (Sonnet 4.6) for a conversational reply, sends it, stores it in `result.reply`. See `src/services/chat.ts`.

**Status messages the user gets:** instant ack on a video webhook ("got it, lemme look at this"); then either the clarification question or the confirmation+estimate after `planEdit`; then the video with "here's ur {style} edit"; on any failure, a friendly message ("ah that one broke on me, mind trying again?" or "i can only edit videos and photos rn"). Sent by the webhook handler and the worker (`notifyVideoFailure`).

**Clarification multi-turn:** if `planEdit` parks the job in `awaiting_clarification`, the user's next text-only message is routed to that job by the webhook (not the chatbot) — it sets `result.clarificationAnswer` and state back to `downloaded`, so `planEdit` re-runs with the answer (and won't ask again). A new video supersedes a pending clarification (old job → `failed`).

Terminal states: `delivered` (video success), `replied` (chat success), `failed` (error path). `awaiting_clarification` is parked, not terminal. The worker's claim SQL + recovery sweep skip all of `delivered`/`replied`/`failed`/`awaiting_clarification`.

Self-loop / throttled-poll state: `submitted` — only polls Shotstack every 5s (gated by `result.nextPollAt`); the worker's claim SQL skips a `submitted` job whose next poll isn't due yet, so an in-progress render doesn't starve newer jobs.

All outbound HTTP goes through `fetchWithTimeout` (`src/http.ts`) — Node's `fetch` has no default timeout, and a hung connection would otherwise freeze the worker via its single-tick-in-flight guard. There's also a watchdog: a tick still running after 20 min → `process.exit(1)` for a clean Render restart.

**Media normalization (`src/services/transcode.ts`):** every uploaded media part is normalized to a clean H.264 MP4 clip *before* it touches Shotstack.
- **Videos** → ffmpeg with `-autorotate` (default on) bakes rotation into the pixels (iPhone portrait videos store a landscape frame + a `rotate 90°` display matrix that Shotstack — neither Ingest nor render — applies), transcodes HEVC→H.264 (CRF 21), caps the long side at 1920px, faststart.
- **Images** (`image/*`) → `sharp` decodes (including HEIC, which ffmpeg-static can't), auto-rotates from EXIF orientation, resizes to fit within 1920×1920; ffmpeg then loops it into a 6-second clip.

Either way the result is a uniform video clip. The first clip's normalized dimensions size the render output, so output orientation always matches the (first) source — portrait→portrait, landscape→landscape, image or video.

**Music (`src/services/music.ts`):** every render gets a soundtrack and the source clips are muted (unless `keep_original_audio`, then ducked to 0.3). The matcher returns a structured `MusicSpec` in the plan: `tags` (0-3 from `JAMENDO_TAGS` in schemas.ts — genre + mood + occasion), `freetext` (a backup query / a named public-domain piece like "jingle bells instrumental"), `tempo` (slow/medium/fast/any → Jamendo `speed`), `acoustic_or_electric`. `resolveMusicUrl(spec)` resolves it: (1) curated track ID for iconic themes (`CURATED_BY_TAG` / `CURATED_KEYWORDS` — e.g. christmas → the real "Jingle Bells" track 478677, halloween/summer/romantic also pinned); (2) Jamendo `tags=…&search=…&speed=…&acousticelectric=…` (the `tags` filter is far sharper than free-text search) — each query pulls a pool of ~20 candidates and picks one at random for variety; (3) progressively looser fallbacks — drop speed/acoustic, then drop tags (search only), then `fuzzytags`. The chosen track is downloaded and re-hosted on R2 (`music/jamendo-<id>.mp3` — Jamendo audio URLs carry an expiring token). If nothing resolves, falls back to a hardcoded Shotstack-CDN track. If the plan's music is empty, the style preset's `fallbackMusic` spec is used. Jamendo's free tier is non-commercial — fine for the demo. NOTE: copyrighted/famous music (film scores, Top-40) isn't in any royalty-free library and never will be — the matcher names public-domain pieces (carols, classical) instead.

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
