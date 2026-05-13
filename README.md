<p align="center">
  <img src="assets/logo.svg" width="150" alt="iEdit logo">
</p>

<h1 align="center">iEdit</h1>

<p align="center">
  <b>An AI video editor that lives in iMessage.</b><br/>
  Text it a few clips and a caption. Get back a TikTok-style edited video with music — the cut, the soundtrack, the text overlays, the color grade, all picked by an LLM that actually understands what you asked for.<br/>
  Don't like it? Text back <i>"make the text yellow"</i> and you get the revised one.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-3C873A?logo=node.js&logoColor=white" alt="Node ≥20">
  <img src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/LLM-Claude%20Opus%204.7-CC785C" alt="Claude Opus 4.7">
  <img src="https://img.shields.io/badge/render-Shotstack-00C2A8" alt="Shotstack">
  <img src="https://img.shields.io/badge/deployed-Render-46E3B7?logo=render&logoColor=white" alt="Render">
  <img src="https://img.shields.io/badge/status-live-brightgreen" alt="Live">
</p>

> *"christmas edit with bold text"* → festive montage, the real "Jingle Bells", red uppercase overlays.
> *"slow-mo cinematic black and white"* → 0.5× speed, dramatic grade, greyscale, moody score, slow push-in.
> *"recap of my trip from these pics"* → snappy carousel cuts, a slow zoom on each photo, chill summer track.
> *(a video, no caption)* → "what's the vibe? hype, chill, sad…?" — then it makes the edit from your answer.
> *(after you get an edit)* "actually make it faster and use the Lobster font" → re-renders with just those changes.

Built as a take-home project — and it's deployed and runs end to end, so **just text the number below and try it.**

---

## 📱 Try it — on your iPhone

1. **Text anything** to **`+1 (650) 468-7059`** in iMessage. *(Demo line — may rotate.)*
2. It replies asking you to **reply `OK`** to opt in (one time). You get a quick rundown + an "Add to Contacts" card.
3. **Send 1+ video clips and/or photos** in one message, with a caption of the vibe you want — `hype gym edit with big bold text`, `chill summer recap, slow mo`, `make it cinematic`, whatever.
4. You get an instant `got it, lemme look at this` → then a confirmation of what it's making + a rough wait → then the finished video.
5. **Don't like it?** Text back a tweak — `make the text yellow`, `swap the music to jazz`, `use the Bebas Neue font`, `make it faster`, `add a caption saying "we made it"` — and you get the revised one. You can also just text it questions: `how's my video coming?`, `what styles can you do?`.

**Demo limits** (it's a demo): 50 edits per person per day, ≥60s between edits, ~200/day total across everyone. Music is royalty-free (Jamendo), so famous tracks aren't available — for themes like Christmas it uses public-domain equivalents (carols, classical). Fonts cover ~all of Google Fonts but not proprietary ones (Helvetica/Arial/Times → the closest open-license match).

### Things it understands

| | |
|---|---|
| **Styles** | hype · sad · chill · funny · cinematic — the rendering scaffold |
| **Music** | matched to the mood: genre, tempo, instrumentation; royalty-free, with curated tracks pinned for iconic themes (christmas → the real "Jingle Bells"). "make it sound like Eye of the Tiger" → driving motivational rock. |
| **Pacing** | cuts per minute — `fast paced` → rapid cuts; `let it breathe` → slow lingering shots |
| **Speed** | slow-motion / sped-up (single clips) |
| **Color** | vibrant · muted/vintage · black & white · dramatic |
| **Transitions** | hard cut (default) · fade · zoom · slide · carousel (the recap-reel look) · wipe |
| **Motion** | a slow Ken-Burns push/pan on the clips — great for photo slideshows so stills aren't frozen |
| **Text overlays** | content, position, color, ALL-CAPS, a colored pill behind it, in/out animation, **any open-license font by name** (Bebas Neue, Lobster, Pacifico, Anton, …), size, outline |
| **Multi-turn** | refine a delivered edit by texting a tweak — it re-renders from the clips it already has, applying only what changed |
| **Edge cases** | asks one clarifying question if a request is too vague; friendly failure messages, never silent; per-sender + system-wide rate limits |

---

## 🧠 How it works

```
iMessage → Linq webhook → download + normalize media (ffmpeg / sharp) → Claude plans the edit
                                                                              │
   reply to user ◀── Linq attachment ◀── Shotstack render ◀── resolve music (Jamendo) + build edit JSON
```

A user's iMessage hits a **Linq** virtual number, which POSTs a signed webhook here. The webhook verifies the HMAC, dedups on the event id, runs access/rate-limit checks, creates a `Job` row, and returns `200` immediately. A background worker (a 1s `setInterval` loop, atomic `SELECT … FOR UPDATE SKIP LOCKED` claim) walks the job through a state machine, persisting after every transition so a crash/redeploy resumes cleanly.

**The matcher (`src/services/match.ts` → `planEdit`) is the brain.** Given the caption + clip count (+ a tweak on a re-run), Claude Opus returns a structured `EditPlan`:

| Field | What it controls |
|---|---|
| `confirmation` | the casual line texted back ("doing a fast hype gym edit, hard rock, big bold text") |
| `needs_clarification` / `clarification_question` | set only when the request is genuinely too vague |
| `style` | `hype` \| `sad` \| `chill` \| `funny` \| `cinematic` |
| `music` | a `MusicSpec` — `tags` / `freetext` / `tempo` / `acoustic_or_electric`; Claude picks the search params |
| `keep_original_audio` | keep the source audio (ducked) instead of muting it under the music |
| `pace` | `very_fast` \| `fast` \| `medium` \| `slow` \| `very_slow` — cuts/min in a montage |
| `speed` | `slow` (≈0.5×) \| `normal` \| `fast` — single-clip edits |
| `color_filter` | `none` \| `vibrant` \| `muted` \| `bw` \| `dramatic` |
| `transition` | `cut` \| `fade` \| `zoom` \| `slide` \| `carousel` \| `wipe` |
| `motion` | `none` \| `zoom` \| `pan` — slow Ken-Burns move on the clips |
| `text_overlays[]` | `{ text, position, color, uppercase, background, animation, font_name (any Google Font, or ""), font (fallback category), size, outline }` |

The prompt makes Claude **infer the vibe boldly** (gym → hard rock + fast cuts + bold text; "fast paced" → more cuts/min; "romantic" → slower + soft music; "funny" → playful, not rock/epic; christmas → christmas music + festive text) while staying **coherent and not over-styling** (no fades, filters, or slow-mo the user didn't ask for or imply). If the request is genuinely undirected it asks one clarifying question and parks the job. The (large) system prompt is sent with `cache_control: ephemeral`.

**Refinement (multi-turn):** after a delivered edit, a text-only follow-up that reads as a tweak ("make the text yellow", "use the Lobster font", "different music", "faster") spins up a new render that **reuses the already-normalized clips on R2** (no resend, no re-transcode) — the matcher returns the prior plan with only that change applied; if it can't apply the ask (a proprietary font, an intro card we don't have) it says so honestly instead of silently re-rendering an identical video.

**Music (`src/services/music.ts`):** `resolveMusicUrl` resolves the `MusicSpec` against Jamendo — a hand-curated track id for iconic themes (christmas → the real "Jingle Bells"; halloween/summer/romantic pinned), else a tag-driven ladder (`tags=<all>` → drop to just the genre tag → `fuzzytags`; Jamendo's loose free-text `search` is only a last resort), picking one at random from a candidate pool per level. The track is re-hosted on R2 so Shotstack can fetch it reliably (Jamendo audio URLs expire).

**Rendering (`src/templates/index.ts` → `buildEdit`):** translates the `EditPlan` into a [Shotstack](https://shotstack.io) edit (timeline JSON) — montage timing from `pace`, the music track, muted/ducked source audio, text overlays as wrapping HTML assets (Google Fonts via `@font-face`, optional colored pill, optional stroke), the color filter, the transition, a per-clip Ken-Burns `effect` when `motion` is set. Output size is clamped to fit Shotstack's plan limit. If a render is rejected it retries once with a stripped-down "safe" edit before giving up; renders that drag get a "still cooking" message at ~estimate+2min, a silent resubmit at +4min, and a giveup at +9min.

**Media normalization (`src/services/transcode.ts`):** every uploaded clip is normalized *before* it touches Shotstack — ffmpeg bakes iPhone rotation into the pixels, transcodes HEVC→H.264, caps the long side at 1920px; images (incl. HEIC, via `sharp`) are auto-rotated from EXIF and looped into a short clip. Clips are processed one at a time (parallel ffmpeg thrashes the single CPU core).

**Access control (`src/services/access.ts`):** first-use opt-in (reply `OK`), per-sender video limits, a system-wide daily budget, and an allowlist (the dev's test phone) that skips the per-minute limit. The webhook dedups on the Linq event id so retries don't double-count.

**State machine** (state names are past-tense — each describes what's *done*):

- **Video:** `received → downloaded → matched → submitted → rendered → uploaded → delivered`, with a detour `downloaded → awaiting_clarification → downloaded`.
- **Chat (text-only):** `received → replied` — Claude Sonnet with recent chat history + the sender's most recent video-job status; *or*, if the text is a tweak of a delivered edit, it spawns a refinement video job instead.
- **Terminal:** `delivered`, `replied`, `failed`. On any failure the user gets a friendly message — no silent drops.

**Robustness:** all outbound HTTP has timeouts (a hung connection can't freeze the single-threaded worker); a watchdog exits the process if a tick wedges (Render restarts it; the boot sweep releases stale claims); `GET /version` returns the running git SHA so you can confirm which build is deployed.

See [`CLAUDE.md`](./CLAUDE.md) for the per-state breakdown and conventions, and [`BUILD_GUIDE.md`](./BUILD_GUIDE.md) for the original build narrative.

---

## 🛠 Tech stack

TypeScript (ESM) on Node 20+ · Express · Prisma + Postgres · Zod (validate every I/O boundary) · pino · `@anthropic-ai/sdk` (Opus 4.7 for `planEdit`, Sonnet 4.6 for the chatbot, Haiku for a tweak classifier; structured outputs via `output_config` + `zodOutputFormat`) · Shotstack REST (render) · `ffmpeg-static` + `sharp` (media normalization) · Cloudflare R2 (S3-compatible storage) · Jamendo API (music) · deployed to Render (single always-on instance, no queue service — the worker loop + a boot recovery sweep cover crashes).

---

## 🏃 Running it yourself

```bash
npm install                       # also runs `prisma generate`
cp .env.example .env              # fill in DATABASE_URL + ADMIN_SECRET (and API keys per integration)
npx prisma migrate dev            # apply migrations to your local Postgres
npm run dev                       # tsx watch src/index.ts
```

Then:

```bash
curl localhost:3000/healthz
curl localhost:3000/version                                          # git SHA of the running build
curl -H "Authorization: Bearer $ADMIN_SECRET" localhost:3000/admin/jobs
```

Without the external API keys you can still boot the server and exercise the HTTP surface; the integrations no-op or fall back until their keys are set. Scripts: `npm run typecheck` · `npm run build` (→ `dist/`) · `npm start` · `npx prisma migrate dev --name <name>`.

**Env vars:** `DATABASE_URL`, `ADMIN_SECRET` (required); `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_NUMBER`, `SHOTSTACK_API_KEY`, `SHOTSTACK_ENV` (`stage` default / `v1` for production renders — no watermark, higher res), `ANTHROPIC_API_KEY`, `R2_*` (5), `JAMENDO_CLIENT_ID`, `ACCESS_ALLOWLIST` (optional / per-integration). See `.env.example`.

---

## 📁 Project layout

```
src/
  index.ts        entrypoint: Express + worker + boot recovery sweep
  webhook.ts      POST /webhook — HMAC verify, dedup, access check, clarification/refinement routing, create Job, 200 fast
  admin.ts        GET /healthz, GET /version, GET /admin/jobs[/:id] + /admin/contact-card (Bearer ADMIN_SECRET)
  worker.ts       1s tick: claim a job → advance() → persist; + recovery sweep, watchdog, failure notifications
  state.ts        advance(job) — the state machine (advanceVideoJob / advanceChatJob); refinement, render timeouts/retries
  schemas.ts      zod schemas: LinqWebhookPayload, EditPlan, MusicSpec, …
  http.ts         fetchWithTimeout — all outbound HTTP goes through this
  version.ts      git-SHA resolution (RENDER_GIT_COMMIT, with a local fallback)
  services/
    match.ts          planEdit — the mastermind matcher + its (cached) prompt
    music.ts          resolveMusicUrl — Jamendo tag-ladder + curated tracks
    transcode.ts      ffmpeg / sharp media normalization
    media.ts          downloadMedia — normalize + upload to R2
    shotstack.ts      submitRender / pollRender
    linq.ts           outbound Linq: send text/video replies, upload attachments, typing indicator, share contact card
    access.ts         checkAccess — opt-in + rate limits + budget
    chat.ts           the chatbot reply + the tweak classifier
    contact-card.ts   sets up the Linq contact card (name + logo) on boot
  templates/index.ts  STYLE_PRESETS, PACE_TO_CLIP_SECONDS, FONT_SPECS + buildEdit — EditPlan → Shotstack edit JSON
prisma/schema.prisma  Job + Sender models
render.yaml           Render Blueprint
```

ESM/NodeNext rule: relative imports end in `.js` even though the source is `.ts`.

---

## 🚀 Deployment

`render.yaml` is a Render Blueprint — connect the repo, paste the secret env vars once, and it auto-deploys on push to `main` (`buildCommand: npm install --include=dev && npm run build`, `startCommand: npx prisma migrate deploy && npm start`). Live at `https://linq-video-editor.onrender.com` (`/healthz`, `/version`). Set `SHOTSTACK_ENV=v1` once you have Shotstack credits — production renders have no watermark, a higher resolution cap, and no rate limits.

---

## Known limitations

- Royalty-free music only — no famous/copyrighted tracks; the matcher names public-domain equivalents for themes. Tag-based matching is good for common cases, not perfect.
- `speed` (slow-mo) applies to single-clip edits only (multi-clip trim math gets fiddly).
- Source audio is all-or-nothing (muted, or kept and ducked to 0.3) — no per-clip audio control.
- Fonts cover ~all of Google Fonts (by name, via the `@fontsource` CDN) plus a 5-category fallback — but not *proprietary* fonts (literal Helvetica, Arial, Times), which can't legally be hosted, so those map to the nearest open-license match. Wider per-glyph control (stroke widths, gradients) would mean switching overlays to Shotstack's `text` asset.
- Heavy transcoding (e.g. 4K → 1080p) is CPU-bound on a single core, so very long source clips add latency; there's a 150MB input-size cap as a guard.
- Demo runs on Shotstack's free `stage` env until `SHOTSTACK_ENV=v1` is set — that env watermarks output and caps resolution at 1080p.

---

Built with [Claude Code](https://claude.com/claude-code).
