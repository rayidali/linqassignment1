# iEdit — an AI video editor that lives in iMessage

Text a few clips and a caption to a phone number; get back a TikTok-style edited video with music — the cut, the soundtrack, the text overlays, the color grade, all picked by an LLM that actually understands what you asked for. Don't like it? Text back "make the text yellow" and you get the revised one.

> "christmas edit with bold text" → festive montage, "Jingle Bells", red uppercase overlays.
> "slow-mo cinematic black and white" → 0.5× speed, dramatic grade, greyscale, moody music.
> *(a video with no caption)* → "what's the vibe? hype, chill, sad…?" — then it makes the edit from your answer.

Built as a take-home project. It's deployed and runs end to end.

---

## How to try it

1. Text **anything** to the bot's Linq number.
2. It replies asking you to reply **`OK`** to opt in (one time). You'll get a welcome message and an "Add to Contacts" card.
3. Send **1+ video clips and/or photos** in a message, with a caption describing what you want ("hype gym edit", "chill summer vibes, fade between clips", "make it cinematic and slow").
4. You get an instant `got it, lemme look at this`, then a confirmation of what it's making + a rough time estimate, then the finished video a bit later.
5. Text it questions any time ("how's my video coming?", "what styles can you do?") — it's a chatbot too.

**Demo limits:** 50 video edits per person per day, ≥60s between videos, ~200 video edits per day across everyone. Music comes from a royalty-free library (Jamendo), so famous/copyrighted tracks aren't available — for themes like Christmas it uses public-domain equivalents (carols, classical).

---

## How it works

```
Linq webhook ──▶ download + normalize media (ffmpeg / sharp) ──▶ Claude plans the edit
                                                                        │
   reply to user ◀── Linq attachment ◀── Shotstack render ◀── resolve music (Jamendo) + build edit JSON
```

A user's iMessage hits a **Linq** virtual number, which POSTs a signed webhook to this service. The webhook verifies the HMAC, dedups on the event id, runs access/rate-limit checks, creates a `Job` row, and returns `200` immediately. A background worker (a 1s `setInterval` loop, atomic `SELECT … FOR UPDATE SKIP LOCKED` claim) walks the job through a state machine, persisting after every transition so a crash/redeploy resumes cleanly.

**The matcher (`src/services/match.ts` → `planEdit`) is the brain.** Given the caption + clip count (+ a clarification answer on a re-run), Claude Opus returns a structured `EditPlan`:

| Field | What it controls |
|---|---|
| `confirmation` | the casual line texted back ("doing a hype gym edit w bold text") |
| `needs_clarification` / `clarification_question` | set only when the request is genuinely too vague (e.g. no caption) |
| `style` | `hype` \| `sad` \| `chill` \| `funny` \| `cinematic` — the rendering scaffold |
| `music` | a `MusicSpec` (`tags` from a fixed list, `freetext`, `tempo`, `acoustic_or_electric`) — Claude picks the music-search params directly |
| `keep_original_audio` | keep the source audio (ducked under the music) instead of muting it |
| `pace` | `very_fast` \| `fast` \| `medium` \| `slow` \| `very_slow` — cuts-per-minute in a multi-clip montage (≈1s … 6.5s per clip) |
| `speed` | `slow` (≈0.5×) \| `normal` \| `fast` — single-clip edits |
| `color_filter` | `none` \| `vibrant` \| `muted` \| `bw` \| `dramatic` |
| `transition` | `cut` \| `fade` \| `zoom` \| `slide` \| `carousel` \| `wipe` — between clips |
| `motion` | `none` \| `zoom` \| `pan` — slow Ken-Burns move on the clips |
| `text_overlays[]` | `{ text, position, color, uppercase, background, animation }` (font is fixed: Helvetica Bold) |

The prompt makes Claude **infer the vibe boldly** (gym → hard rock + fast cuts + bold text; "fast paced" → more cuts per minute; "romantic" → slower pace + soft music; "funny" → playful music, not rock/epic; christmas → christmas music + festive text) while staying **coherent and not over-styling** (no fades, filters, or slow-mo the user didn't ask for or imply). Every field has to point the same direction. If the request is genuinely undirected it asks one clarifying question and parks the job; the user's next text reply is routed back to that job and the matcher re-runs with the answer. The system prompt is cached on the Anthropic side (`cache_control: ephemeral`).

**Music (`src/services/music.ts`):** `resolveMusicUrl` resolves the `MusicSpec` against Jamendo — first a hand-curated track id for iconic themes (christmas → the real "Jingle Bells", plus halloween/summer/romantic), then a tag-filtered search (`tags=…&search=…&speed=…&acousticelectric=…`) pulling a pool of candidates and picking one at random (variety), then progressively looser fallbacks, then a hardcoded CDN track as a last resort. The chosen track is re-hosted on R2 so Shotstack can fetch it reliably (Jamendo audio URLs expire).

**Rendering (`src/templates/index.ts` → `buildEdit`):** translates the `EditPlan` into a [Shotstack](https://shotstack.io) edit (timeline JSON) — montage timing from `pace` (`PACE_TO_CLIP_SECONDS`), the music track, muted/ducked source audio, text overlays as wrapping HTML assets (optionally on a colored pill), the color filter, the transition (cut/fade/zoom/slide/carousel/wipe), and a slow Ken-Burns `effect` per clip when `motion` is set. The render is polled until done, the output is pre-uploaded to Linq as an attachment, and the video is texted back with a `here's ur {style} edit` caption.

**Media normalization (`src/services/transcode.ts`):** every uploaded clip is normalized *before* it touches Shotstack — ffmpeg bakes iPhone rotation into the pixels, transcodes HEVC→H.264 (CRF 21), caps the long side at 1920px (1080p output); images (incl. HEIC, via `sharp`) are auto-rotated from EXIF and looped into a short clip. The first clip's dimensions size the output, so a portrait source gives a portrait video.

**Access control (`src/services/access.ts`):** first-use opt-in (reply `OK`), per-sender video limits, a system-wide daily budget, and an allowlist (the dev's test phone) that skips the per-minute limit. Tracked in a `Sender` table; the webhook dedups on the Linq event id so retries don't double-count.

**State machine** (state names are past-tense — each describes what's *done*):

- Video: `received → downloaded → matched → submitted → rendered → uploaded → delivered`, with a detour `downloaded → awaiting_clarification → downloaded`.
- Chat (text-only message): `received → replied` (Claude Sonnet, with recent chat history + the sender's most recent video-job status).
- Terminal: `delivered`, `replied`, `failed`. On any failure the user gets a friendly message — no silent drops.

See [`CLAUDE.md`](./CLAUDE.md) for the per-state breakdown and conventions, and [`BUILD_GUIDE.md`](./BUILD_GUIDE.md) for the original build narrative.

---

## Tech stack

TypeScript (ESM) on Node 20+ · Express · Prisma + Postgres · Zod (validate every I/O boundary) · pino · `@anthropic-ai/sdk` (Opus for `planEdit`, Sonnet for the chatbot; structured outputs via `output_config` + `zodOutputFormat`) · Shotstack REST (render) · `ffmpeg-static` + `sharp` (media normalization) · Cloudflare R2 (S3-compatible storage) · Jamendo API (music) · deployed to Render (single always-on instance, no queue service — the worker loop + a boot recovery sweep cover crashes).

---

## Running locally

```bash
npm install                       # also runs `prisma generate`
cp .env.example .env              # fill in DATABASE_URL + ADMIN_SECRET (and API keys as you wire each integration)
npx prisma migrate dev            # apply migrations to your local Postgres
npm run dev                       # tsx watch src/index.ts
```

Then:

```bash
curl localhost:3000/healthz
curl localhost:3000/version                                   # git SHA of the running build
curl -H "Authorization: Bearer $ADMIN_SECRET" localhost:3000/admin/jobs
```

Without the external API keys you can still boot the server and exercise the HTTP surface; the integrations no-op or use fallbacks until their keys are set.

**Scripts:** `npm run typecheck` · `npm run build` (→ `dist/`) · `npm start` · `npx prisma migrate dev --name <name>`.

**Env vars:** `DATABASE_URL`, `ADMIN_SECRET` (required); `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_NUMBER`, `SHOTSTACK_API_KEY`, `ANTHROPIC_API_KEY`, `R2_*` (5), `JAMENDO_CLIENT_ID`, `ACCESS_ALLOWLIST` (optional / per-integration). See `.env.example`.

---

## Project layout

```
src/
  index.ts        entrypoint: Express + worker + boot recovery sweep
  webhook.ts      POST /webhook — HMAC verify, dedup, access check, clarification routing, create Job, 200 fast
  admin.ts        GET /healthz, GET /version, GET /admin/jobs[/:id] (Bearer ADMIN_SECRET)
  worker.ts       1s tick: claim a job → advance() → persist; + recovery sweep, failure notifications
  state.ts        advance(job) — the state machine (advanceVideoJob / advanceChatJob)
  schemas.ts      zod schemas: LinqWebhookPayload, EditPlan, MusicSpec, …
  services/
    match.ts          planEdit — the mastermind matcher + its prompt
    music.ts          resolveMusicUrl — Jamendo query strategy + curated tracks
    transcode.ts      ffmpeg / sharp media normalization
    media.ts          downloadMedia — normalize + upload to R2
    shotstack.ts      submitRender / pollRender
    linq.ts           outbound Linq: send text/video replies, upload attachments, share contact card
    access.ts         checkAccess — opt-in + rate limits + budget
    chat.ts           the chatbot reply
    contact-card.ts   sets up the Linq contact card (name + logo) on boot
  templates/index.ts  STYLE_PRESETS + buildEdit — EditPlan → Shotstack edit JSON
prisma/schema.prisma  Job + Sender models
render.yaml           Render Blueprint
```

ESM/NodeNext rule: relative imports end in `.js` even though the source is `.ts`.

---

## Deployment

`render.yaml` is a Render Blueprint — connect the repo, paste the secret env vars once, and it auto-deploys on push to `main` (`buildCommand: npm install --include=dev && npm run build`, `startCommand: npx prisma migrate deploy && npm start`). `GET /version` returns the deployed git SHA (Render injects `RENDER_GIT_COMMIT`) so you can confirm which build is live.

---

## Known limitations

- Royalty-free music only — no famous/copyrighted tracks; the matcher names public-domain equivalents for themes. Tag-based matching is good for common cases, not perfect.
- `speed` (slow-mo) applies to single-clip edits only (multi-clip trim math gets fiddly).
- Source audio is all-or-nothing (muted, or kept and ducked to 0.3) — no per-clip audio control.
- Overlay font is Helvetica Bold only (custom display fonts need a hosted `.ttf`).
- Heavy transcoding (e.g. 4K → 1080p) is CPU-bound on a single core, so very long source clips add latency; there's a 150MB input-size cap as a guard.
