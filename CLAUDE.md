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
  admin.ts        # GET /healthz, GET /version, GET /admin/jobs[/:id] + GET /admin/contact-card (gated by ADMIN_SECRET)
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
- `transition` — `cut` | `fade` | `zoom` | `slide` (slideLeft) | `carousel` (cycles direction per clip — the "recap reel" look) | `wipe` (wipeLeft) — between clips; multi-clip only; default `cut`
- `motion` — `none` | `zoom` (slow Ken-Burns push, alternating in/out per clip) | `pan` (slow left/right glide per clip) — applied as a clip `effect`. **Default depends on pace:** `none` for `very_fast`/`fast` (too short to read); `pan` for `medium`; `pan`/`zoom` for `slow`/`very_slow`/cinematic (zoom for photos and single-shot intimate framing). The matcher leans toward motion unless the user opts out ("no motion"/"static") — a designed edit feels alive.
- `text_overlays[]` — `{ text, position: top|center|bottom, color, role: hero|subtitle|body|caption, case_style: as_written|uppercase|lowercase, background: "none" | a color (rounded pill), animation_in: OverlayTransitionId, animation_out: OverlayTransitionId, duration_seconds: number | null, font_name: a specific Google Font name or "", font: bold_sans|condensed|serif|handwritten|rounded (fallback category), size: small|medium|large, outline: none|dark|light }`. **`role`** drives the dominant size multiplier — hero ~2.6×, subtitle 1×, body 0.55×, caption 0.4× (on top of `STYLE_PRESETS[style].fontScale`); `size` is a fine-tune (0.72/1.0/1.42×). **Grouping:** consecutive overlays at the SAME `position` are composed into ONE HTML asset by the renderer (`groupByPosition` in `templates/index.ts`) — a hero+subtitle pair at the same position renders as a single stacked block (CSS `flex-direction: column`), each line keeping its own font/color/case. The group's transition pair comes from the **first overlay**; its duration follows the null-priority rule (any line says null → full video). `case_style` is honored at render via CSS `text-transform`. **`animation_in` / `animation_out`** are set separately so the matcher can compose looks (in: `slide_up`, out: `carousel_left` for the recap-reel feel); enum covers `none|fade|slide_up|slide_down|slide_left|slide_right|carousel_up|carousel_down|carousel_left|carousel_right|zoom` mapped to Shotstack's native names in `mapTransition`. `duration_seconds` (0.5–60, null = full video). Fonts: `font_name` (if set) is slugified → `@fontsource/<slug>` CDN `@font-face` (`namedFontFace`); `font` is the always-set category fallback. Proprietary fonts (Helvetica, Times) can't be hosted → matcher leaves `font_name` "" and picks the nearest category. `outline` = CSS `-webkit-text-stroke` (`paint-order:stroke fill`); `none` keeps the default soft drop-shadow. **Backward compat:** `migrateOverlay` in `templates/index.ts` normalizes any old-shape overlay (`uppercase: bool` → `case_style`, single `animation` → both `animation_in`/`animation_out`, missing `role` → derived from `size`) before grouping, so plans stored before the schema bump still render. The estimator counts groups, not raw overlays — `overlayGroupCount` is exported for this.

The renderer (`src/templates/index.ts` → `buildEdit(plan, clips, outputSize, musicUrl, { safe? })`) translates the plan to Shotstack JSON. `STYLE_PRESETS` holds per-style defaults (overlay font scale, a fallback `MusicSpec`); `PACE_TO_CLIP_SECONDS` maps `pace` → montage clip duration (with a 2s floor when there are only 2 clips). The output size is clamped (`clampOutputSize`, `SHOTSTACK_MAX_LONG`/`SHOTSTACK_MAX_SHORT`) so a non-9:16 source (a 3:4 photo → 1440×1920) doesn't exceed Shotstack's sandbox plan limit (long ≤ 1920, **short ≤ 1080**) and 403 the render. The matcher's big system prompt is cached (`cache_control: ephemeral`).

## State machine

State names are **past-tense** — each describes what's been completed.

**Video pipeline:** `received → downloaded → matched → submitted → rendered → uploaded → delivered`, with a possible detour `downloaded → awaiting_clarification → downloaded`.

| State | What advance() does | Next |
|---|---|---|
| `received` | filter media parts to video/image (fail "no editable…" otherwise), normalize each **sequentially** with ffmpeg (autorotate + H.264 + cap long side at 1920px) — parallel transcodes thrash the single CPU core and OOM — upload to R2; store first clip's normalized dims as `outputSize` | `downloaded` |
| `downloaded` | `planEdit`. If it needs clarification (and we haven't asked yet): send the question | `awaiting_clarification` |
| `downloaded` | else: send the confirmation + a render-time estimate derived from the plan (`estimateRenderMs` — baseline + per-output-second + per-clip + per-overlay + small per-clip terms for transition/motion/filter, see the constants in `state.ts`); store it as `estimatedRenderMs` so the progress milestones and slow/resubmit/giveup timers all scale off it | `matched` |
| `awaiting_clarification` | (worker doesn't touch it — parked until the user's text reply, which the webhook routes back here as `result.clarificationAnswer` + state `downloaded`) | — |
| `matched` | resolve the music query via Jamendo (`resolveMusicUrl`, fallback to a Shotstack-CDN track), `buildEdit(plan, …)`, submit render | `submitted` |
| `submitted` | poll render status; self-loop (5s) until `done`. Progress texts (25/50/75 %) fire when **Shotstack itself** reports the render entered the corresponding stage (`fetching` → 25 %, `rendering` → 50 %, `saving` → 75 % — see `SHOTSTACK_PROGRESS_STAGES` + `STAGE_TO_PCT`). The Shotstack API has no ETA or numeric progress field, so stage transitions are the only ground-truth signal; the heuristic `estimatedRenderMs` is used only for the wait phrase and the slow/giveup timers, not the percent texts. Tracked in `result.progressNotified[]` / `result.progressStages[]`; **not** suppressed by slow notices (a real stage transition is still useful info). On render *done*, log `actualMs` vs `estimatedMs` as a calibration sample. On render *failure* (or a 4xx at submit time), retry once with a "safe" edit — `buildEdit(plan, …, { safe: true })` strips everything not long-proven (transitions beyond cut, clip motion, text backgrounds/animations, duration overrides) so the user still gets a (plainer) video. If it's just *slow* (past `estimatedRenderMs` + a grace), the timeline is: **slow notice 1** at +2 min ("taking a sec longer than i thought"), silent resubmit at +4 min, **slow notice 2** at +5 min ("ur edit's being chunky today bb"), give up → `failed` at +9 min. Each slow notice is one-shot (`slowNoticeSent` / `slowNotice2Sent`); slow notice 2 is gated on slow notice 1 having already fired. One render retry total either way (`renderResubmitted` flag). | `rendered` |
| `rendered` | fetch render output, pre-upload to Linq Attachments | `uploaded` |
| `uploaded` | send video reply via Linq with a "here's ur {style} edit" caption | `delivered` |

**Chat pipeline:** `received → replied` — `advanceChatJob` first checks: does the user have a recent `delivered` video edit, and is this message a tweak request (a quick Haiku call, `classifyTweakRequest`)? If yes → it spawns a **refinement** video job (see below) and just sends a "k on it" ack. Otherwise → loads recent chat history + the most recent video job's status, calls Claude (Sonnet 4.6) for a conversational reply, sends it, stores it in `result.reply`. See `src/services/chat.ts`.

**Edit refinement (multi-turn):** after a `delivered` edit, a text-only follow-up like "make the text yellow" / "do it again but faster" / "different music" → `advanceChatJob` creates a new `video` job that starts at `downloaded` (skips `received` — the normalized clips are still on R2), with `result` carrying the prior job's `clips`/`outputSize`, plus `refinementOf`, `refinementRequest` (the user's text), `priorCaption`, `priorPlan`, `priorMusicSpec`/`priorMusicUrl`. The `downloaded` case detects `refinementOf` and calls `planEdit` in TWEAK MODE (passes the prior plan + the requested change → returns the prior plan with only that change applied, never asks for clarification; the prompt also tells it what's NOT controllable — e.g. the font — so it says so honestly instead of pretending). If the returned plan is identical to the prior plan (`planFingerprint` match — the ask couldn't be applied or was already that way), the job goes straight to `replied` with that honest confirmation as a text reply — no pointless re-render. Otherwise `matched` reuses the prior `musicUrl` if the new plan's `music` is unchanged (so a text tweak doesn't also swap the song), and the video comes back captioned "here's the updated {style} edit". Known rough edge: a second tweak while a refinement is still in flight refines off the original `delivered` edit again (you get two updated videos), not off the in-flight one. Replying to a *specific older* edit isn't wired yet — would need Linq's webhook to surface the replied-to message id.

**Status messages the user gets:** instant ack on a video webhook ("ooh ok lemme see what i can do with this"); then either the clarification question or the confirmation+estimate after `planEdit`; then 25/50/75 % progress milestones once the render is in flight (gated on estimate ≥ 45s); then the video with "here's ur {style} edit bestie"; on any failure, a friendly message ("ugh that one broke on me, try again bestie?" or "aw bb i can only do videos and pics rn"). Sent by the webhook handler and the worker (`notifyVideoFailure`). The worker also pokes Linq's typing indicator (`startTyping`, `POST /chats/{id}/typing` — no body, 403 in group chats) before the work behind a wait: at the top of `received`, before `planEdit` in `downloaded`, before `uploadAttachment` in `rendered`, and at the top of `advanceChatJob` — iMessage clears it when the next message lands (or it times out), so there's no "stop". Brand name (contact card + iOS "Maybe: …" suggestion) is "iEdit" — `CARD_FIRST_NAME` in `src/services/contact-card.ts`.

**Voice across all user-facing text:** ur excited best friend who happens to be a video editor — warm, hyped, playfully sassy, never mean or robotic. Lowercase, contractions, light slang ("ok bestie", "ooh", "bb", "ngl"); ZERO dashes (`—`, `–`, or `-` as punctuation); ZERO emojis. The `scrubStyle()` belt-and-suspenders in `chat.ts` strips em/en dashes and emoji even if a model slips. Applies equally to: the matcher's `confirmation` and `clarification_question`, the chatbot reply, opt-in/welcome/rate-limit messages in `access.ts`, the webhook ack, `notifyVideoFailure`, the video reply caption, and the slow-notice in the `submitted` state.

**Clarification multi-turn:** if `planEdit` parks the job in `awaiting_clarification`, the user's next text-only message is routed to that job by the webhook (not the chatbot) — it sets `result.clarificationAnswer` and state back to `downloaded`, so `planEdit` re-runs with the answer (and won't ask again). A new video supersedes a pending clarification (old job → `failed`).

Terminal states: `delivered` (video success), `replied` (chat success), `failed` (error path). `awaiting_clarification` is parked, not terminal. The worker's claim SQL + recovery sweep skip all of `delivered`/`replied`/`failed`/`awaiting_clarification`.

Self-loop / throttled-poll state: `submitted` — only polls Shotstack every 5s (gated by `result.nextPollAt`); the worker's claim SQL skips a `submitted` job whose next poll isn't due yet, so an in-progress render doesn't starve newer jobs.

All outbound HTTP goes through `fetchWithTimeout` (`src/http.ts`) — Node's `fetch` has no default timeout, and a hung connection would otherwise freeze the worker via its single-tick-in-flight guard. There's also a watchdog: a tick still running after 20 min → `process.exit(1)` for a clean Render restart.

**Media normalization (`src/services/transcode.ts`):** every uploaded media part is normalized to a clean H.264 MP4 clip *before* it touches Shotstack.
- **Videos** → ffmpeg with `-autorotate` (default on) bakes rotation into the pixels (iPhone portrait videos store a landscape frame + a `rotate 90°` display matrix that Shotstack — neither Ingest nor render — applies), transcodes HEVC→H.264 (CRF 21), caps the long side at 1920px, faststart.
- **Images** (`image/*`) → `sharp` decodes (including HEIC, which ffmpeg-static can't), auto-rotates from EXIF orientation, resizes to fit within 1920×1920; ffmpeg then loops it into a 6-second clip.

Either way the result is a uniform video clip. The first clip's normalized dimensions size the render output, so output orientation always matches the (first) source — portrait→portrait, landscape→landscape, image or video.

**Music (`src/services/music.ts`):** every render gets a soundtrack and the source clips are muted (unless `keep_original_audio`, then ducked to 0.3). The matcher returns a structured `MusicSpec` in the plan: `tags` (0-3 from `JAMENDO_TAGS` in schemas.ts — genre + mood + occasion), `freetext` (a backup query / a named public-domain piece like "jingle bells instrumental"), `tempo` (slow/medium/fast/any → Jamendo `speed`), `acoustic_or_electric`. `resolveMusicUrl(spec)` resolves it: (1) curated track ID for iconic themes (`CURATED_BY_TAG` / `CURATED_KEYWORDS` — e.g. christmas → the real "Jingle Bells" track 478677, halloween/summer/romantic also pinned); (2) **tag-driven ladder** — `tags=<all>&speed&acousticelectric` → `tags=<all>` → `tags=<first tag only>` (the core genre) → `fuzzytags=<all>` → and only as a LAST resort `search=<freetext>` (Jamendo's free-text search is famously loose — "popular-ish" tracks, not genre matches — so it's never the primary filter). Each level pulls ~20 candidates by `popularity_total` and picks one at random for variety; we stop at the first non-empty level. If nothing resolves, falls back to a hardcoded Shotstack-CDN track. The chosen track is downloaded and re-hosted on R2 (`music/jamendo-<id>.mp3` — Jamendo audio URLs carry an expiring token). If the plan's music is empty, the style preset's `fallbackMusic` spec is used. Jamendo's free tier is non-commercial — fine for the demo. NOTE: copyrighted/famous music (film scores, Top-40) isn't in any royalty-free library and never will be — the matcher names public-domain pieces (carols, classical) instead.

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
- Env: `SHOTSTACK_ENV` selects `stage` (free sandbox — watermarked output, max 1080-short-side, rate-limited) vs `v1` (production — uses account credits, no watermark, higher limits). Defaults to `stage`; set `SHOTSTACK_ENV=v1` in Render once there are credits.
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
