import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { downloadMedia, type DownloadResult } from "./services/media.js";
import { planEdit } from "./services/match.js";
import { submitRender, pollRender } from "./services/shotstack.js";
import { resolveMusicUrl } from "./services/music.js";
import { uploadAttachment, sendVideoReply, sendTextReply, startTyping } from "./services/linq.js";
import { generateReply, classifyTweakRequest } from "./services/chat.js";
import { buildEdit, STYLE_PRESETS, PACE_TO_CLIP_SECONDS, overlayGroupCount } from "./templates/index.js";
import type { LinqWebhookPayload, EditPlan } from "./schemas.js";

// Used when Jamendo can't resolve a track — there's always a soundtrack.
const FALLBACK_MUSIC_URL =
  "https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/unminus/lit.mp3";

export const STATES = [
  // video pipeline
  "received",
  "downloaded",
  "awaiting_clarification", // waiting on the user's reply to a clarifying question
  "matched",
  "submitted",
  "rendered",
  "uploaded",
  "delivered",
  // chat pipeline
  "replied",
  // shared
  "failed",
] as const;

export type State = (typeof STATES)[number];

// States the worker won't claim: terminal (delivered/replied/failed) plus
// awaiting_clarification (the job is parked until the user replies).
export const WORKER_SKIP_STATES = ["delivered", "replied", "failed", "awaiting_clarification"] as const;

export type JobRow = {
  id: string;
  type: string;
  chatId: string | null;
  state: string;
  payload: unknown;
  result: unknown;
  createdAt: Date;
};

export type AdvanceResult = {
  nextState: State;
  resultPatch?: Record<string, unknown>;
  error?: string;
};

const POLL_INTERVAL_MS = 5000;
// Grace beyond the *estimated* render time before we (1) tell the user it's
// running slow, (2) silently resubmit a fresh render once, (3) give up and
// fail the job. So a genuinely big edit (long estimate) gets proportionally
// more slack — the wait isn't a flat hardcoded number. Shotstack's /stage
// sandbox occasionally wedges a render forever, which is what (3) catches.
const RENDER_SLOW_NOTICE_GRACE_MS = 2 * 60_000;
const RENDER_RESUBMIT_GRACE_MS = 4 * 60_000;
// Second slow notice after the silent resubmit, so the user isn't left in the
// dark for the long stretch between the first slow notice (est+2min) and the
// giveup (est+9min). One-shot, gated on slowNoticeSent (only fires if the
// first one already did) so we never send #2 without #1.
const RENDER_SLOW_NOTICE_2_GRACE_MS = 5 * 60_000;
const RENDER_GIVEUP_GRACE_MS = 9 * 60_000;
// Bounds on the render estimate (a render of one of our short montages
// shouldn't legitimately take more than a few minutes; never less than ~20s).
const RENDER_ESTIMATE_MIN_MS = 20_000;
const RENDER_ESTIMATE_MAX_MS = 5 * 60_000;

// Calibrated estimate of how long Shotstack will take. Each contributor below
// is an empirical guess (no historical data) — what matters is the SHAPE:
// bigger edits get bigger estimates, which then drives the user-facing wait
// phrase, the 25/50/75 progress milestones, AND the slow/resubmit/giveup
// timers. So a small edit doesn't get an inappropriate slow notice and a big
// edit doesn't fire false 75% texts at 8s elapsed.
//
//   baseline                 fixed overhead (Shotstack queue + asset fetch)
//   + outputSec × perSec     proportional to output duration
//   + clips × perClip        per-clip overhead (decode + cut)
//   + overlay × perOverlay   HTML asset render is the slowest contributor
//   + transition × clips     transitions add a small per-clip cost
//   + motion × clips         Ken-Burns effects add a small per-clip cost
//   + filter × clips         color filters add a small per-clip cost
//
// Numbers are seconds at 1080p on Shotstack's stage env (v1 is similar).
const EST_BASELINE_S = 18;            // queue / setup / asset pulls
const EST_PER_OUTPUT_S = 3.2;          // per second of output
const EST_PER_CLIP_S = 1.4;            // per clip
const EST_PER_OVERLAY_S = 5.5;         // per overlay (HTML asset)
const EST_PER_TRANSITION_S = 0.7;      // per clip when transition != cut
const EST_PER_MOTION_S = 0.9;          // per clip when motion != none
const EST_PER_FILTER_S = 0.5;          // per clip when color_filter != none

function estimateRenderMs(plan: EditPlan, clipCount: number): number {
  const outputSeconds = clipCount > 1 ? clipCount * PACE_TO_CLIP_SECONDS[plan.pace] : 12;
  // Count GROUPS, not raw overlays — the renderer composes consecutive
  // same-position overlays into ONE HTML asset (a hero+subtitle stack is one
  // render, not two). overlayGroupCount() handles old-shape plans too.
  const overlayGroups = overlayGroupCount((plan.text_overlays as unknown[]) ?? []);
  const hasTransition = plan.transition && plan.transition !== "cut";
  const hasMotion = plan.motion && plan.motion !== "none";
  const hasFilter = plan.color_filter && plan.color_filter !== "none";
  const seconds =
    EST_BASELINE_S +
    outputSeconds * EST_PER_OUTPUT_S +
    clipCount * EST_PER_CLIP_S +
    overlayGroups * EST_PER_OVERLAY_S +
    (hasTransition ? clipCount * EST_PER_TRANSITION_S : 0) +
    (hasMotion ? clipCount * EST_PER_MOTION_S : 0) +
    (hasFilter ? clipCount * EST_PER_FILTER_S : 0);
  return Math.round(Math.max(RENDER_ESTIMATE_MIN_MS, Math.min(RENDER_ESTIMATE_MAX_MS, seconds * 1000)));
}

function estimatePhrase(ms: number): string {
  const s = ms / 1000;
  if (s <= 45) return "should be quick, like 30 secs";
  if (s <= 75) return "give it a min";
  if (s <= 120) return "should be like a min and a half";
  if (s <= 180) return "give it a couple mins";
  return "this one's a bit bigger, like 3 to 5 mins";
}

// Progress messages are driven off Shotstack's actual render status — these
// are the ground-truth stages it transitions through (Shotstack has no ETA or
// numeric progress field, so this is the most accurate signal we get):
//
//   queued     - waiting in line, no work happening yet
//   fetching   - pulling our R2 clips + music (~25 % of the way)
//   rendering  - the slow part, frame composition (~50 %)
//   saving     - encoding the final mp4 (~75 %)
//   done       - render complete
//
// We fire ONE milestone text per tick when Shotstack reports it has reached
// that stage. Stages already seen are recorded in `result.progressStages` so
// each fires at most once. Suppressed once `slowNoticeSent` (the render
// already broke the estimate, no need to also reassure with "halfway").
const STAGE_TO_PCT: Record<string, number> = {
  queued: 0,
  fetching: 25,
  rendering: 50,
  saving: 75,
};
const PROGRESS_MILESTONES = [25, 50, 75] as const;

type ClipDownload = {
  r2Key: string;
  r2PublicUrl: string | null;
  size: number;
  contentType: string;
  width: number;
  height: number;
  sourceUrl: string;
  filename: string;
};

function captionOf(payload: LinqWebhookPayload): string {
  const text = payload.data.parts.find((p) => p.type === "text");
  return text && text.type === "text" ? text.value : "";
}

// Stable, key-order-independent fingerprint of the edit-relevant fields of a
// plan — used to tell whether a refinement actually changed anything (we can't
// just JSON.stringify the raw objects: one side came from jsonb, which doesn't
// preserve key order, so they'd "differ" even when semantically identical).
// Re-builds the Shotstack edit from what's stored on the job and submits it
// again — used both for a slow-render resubmit (same edit) and for a safe-mode
// retry after a render failure (`safe: true` → plain montage, no fancy bits).
// Returns the new renderId, or null if the job is missing what it needs.
async function rebuildAndSubmitRender(
  jobId: string,
  result: Record<string, unknown>,
  opts: { safe?: boolean } = {},
): Promise<string | null> {
  const plan = result.plan as EditPlan | undefined;
  const clips = (result.clips as ClipDownload[] | undefined) ?? [];
  const clipUrls = clips
    .map((c) => c.r2PublicUrl)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  if (!plan || clipUrls.length === 0) return null;
  const outputSize = result.outputSize as { width: number; height: number } | undefined;
  const musicUrl = (result.musicUrl as string | undefined) ?? FALLBACK_MUSIC_URL;
  return submitRender(jobId, buildEdit(plan, clipUrls, outputSize, musicUrl, opts));
}

function planFingerprint(p: EditPlan): string {
  return JSON.stringify({
    style: p.style,
    pace: p.pace,
    speed: p.speed,
    color_filter: p.color_filter,
    transition: p.transition,
    motion: p.motion ?? null,
    keep_original_audio: p.keep_original_audio,
    music: {
      tags: [...(p.music?.tags ?? [])].sort(),
      freetext: p.music?.freetext ?? "",
      tempo: p.music?.tempo ?? "any",
      acoustic_or_electric: p.music?.acoustic_or_electric ?? "any",
    },
    text_overlays: (p.text_overlays ?? []).map((o) => {
      // Robust to old stored plans (uppercase boolean, single `animation`) and
      // new ones — pull each field with its old-shape fallback so an unchanged
      // old plan fingerprints identically before and after the schema bump.
      const raw = o as unknown as Record<string, unknown>;
      const oldAnim = typeof raw.animation === "string" ? (raw.animation as string) : undefined;
      const caseFromOld = raw.uppercase === true ? "uppercase" : "as_written";
      return {
        text: o.text,
        position: o.position,
        color: o.color,
        role: o.role ?? (o.size === "large" ? "hero" : o.size === "small" ? "caption" : "subtitle"),
        case_style: o.case_style ?? caseFromOld,
        background: o.background ?? "none",
        animation_in: o.animation_in ?? oldAnim ?? "none",
        animation_out: o.animation_out ?? oldAnim ?? "none",
        duration_seconds: o.duration_seconds ?? null,
        font_name: o.font_name ?? "",
        font: o.font ?? "bold_sans",
        size: o.size ?? "medium",
        outline: o.outline ?? "none",
      };
    }),
  });
}

export async function advance(job: JobRow): Promise<AdvanceResult> {
  logger.debug({ jobId: job.id, jobType: job.type, fromState: job.state }, "advancing");
  if (job.type === "chat") {
    return advanceChatJob(job);
  }
  return advanceVideoJob(job);
}

async function advanceChatJob(job: JobRow): Promise<AdvanceResult> {
  if (job.state !== "received") {
    throw new Error(`chat job in unexpected state: ${job.state}`);
  }
  const log = logger.child({ jobId: job.id, jobType: "chat" });
  const payload = job.payload as LinqWebhookPayload;
  const chatId = job.chatId ?? payload.data.chat.id;
  const userText = captionOf(payload).trim() || "(empty message)";
  await startTyping(chatId);

  // Is this a tweak of their most recent delivered edit? If so, spin off a
  // refinement video job — it re-renders from the already-normalized clips on
  // R2 (no resend, no re-transcode), with the matcher applying just the change.
  const lastDelivered = await prisma.job.findFirst({
    where: { chatId, type: "video", state: "delivered" },
    orderBy: { createdAt: "desc" },
  });
  if (lastDelivered && (await classifyTweakRequest(userText))) {
    const prev = (lastDelivered.result ?? {}) as Record<string, unknown>;
    const priorPlan = prev.plan as EditPlan | undefined;
    const clips = (prev.clips as ClipDownload[] | undefined) ?? [];
    const usableClips = clips.filter(
      (c) => typeof c.r2PublicUrl === "string" && c.r2PublicUrl.length > 0,
    );
    if (priorPlan && usableClips.length > 0) {
      const ack = "ok on it, redoing that for u bestie";
      const refined = await prisma.job.upsert({
        where: { externalId: `${job.id}-refine` },
        create: {
          externalId: `${job.id}-refine`,
          type: "video",
          chatId,
          state: "downloaded",
          payload: payload as object,
          result: {
            clips: usableClips,
            outputSize: prev.outputSize ?? null,
            refinementOf: lastDelivered.id,
            refinementRequest: userText,
            priorCaption: captionOf(lastDelivered.payload as LinqWebhookPayload),
            priorPlan,
            priorMusicSpec: prev.musicSpec ?? null,
            priorMusicUrl: prev.musicUrl ?? null,
          } as object,
        },
        update: {},
      });
      await sendTextReply(chatId, ack, `${job.id}-refine-ack`).catch((e) =>
        log.warn({ err: e instanceof Error ? e.message : String(e) }, "refine ack send failed"),
      );
      log.info({ refinedJobId: refined.id, refinementOf: lastDelivered.id }, "spawned refinement job");
      return { nextState: "replied", resultPatch: { userText, reply: ack, refinedJobId: refined.id } };
    }
    log.info("classified as tweak but no usable prior edit, falling back to chat");
  }

  const reply = await generateReply(job.id, chatId, userText);
  await sendTextReply(chatId, reply, job.id);
  log.info("chat reply sent");
  return { nextState: "replied", resultPatch: { userText, reply } };
}

async function advanceVideoJob(job: JobRow): Promise<AdvanceResult> {
  const log = logger.child({ jobId: job.id, jobType: "video", fromState: job.state });
  const payload = job.payload as LinqWebhookPayload;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const chatId = job.chatId ?? payload.data.chat.id;

  switch (job.state) {
    case "received": {
      type MediaPart = Extract<LinqWebhookPayload["data"]["parts"][number], { type: "media" }>;
      const usable: MediaPart[] = payload.data.parts.filter(
        (p): p is MediaPart =>
          p.type === "media" &&
          (p.mime_type.toLowerCase().startsWith("video/") ||
            p.mime_type.toLowerCase().startsWith("image/")),
      );
      if (usable.length === 0) {
        return { nextState: "failed", error: "no editable video or photo in the message" };
      }
      log.info({ clipCount: usable.length }, "downloading + normalizing all media parts");
      await startTyping(chatId);
      // Sequentially, NOT in parallel: each ffmpeg transcode is CPU- and
      // memory-heavy and the instance is a single core — running them
      // concurrently just thrashes the CPU and risks an OOM kill.
      const downloads: DownloadResult[] = [];
      for (const p of usable) {
        downloads.push(await downloadMedia(job.id, p.url, p.filename, p.mime_type));
      }
      const clips: ClipDownload[] = downloads.map((d, i) => ({
        r2Key: d.key,
        r2PublicUrl: d.publicUrl,
        size: d.size,
        contentType: d.contentType,
        width: d.width,
        height: d.height,
        sourceUrl: usable[i]!.url,
        filename: usable[i]!.filename,
      }));
      const first = clips[0]!;
      return {
        nextState: "downloaded",
        resultPatch: { clips, outputSize: { width: first.width, height: first.height } },
      };
    }

    case "downloaded": {
      const clipCount = (result.clips as ClipDownload[] | undefined)?.length ?? 1;
      const refinementOf = result.refinementOf as string | undefined;
      const isRefinement = Boolean(refinementOf);
      const clarificationAnswer = result.clarificationAnswer as string | undefined;
      const clarificationCount = (result.clarificationCount as number | undefined) ?? 0;
      const priorPlan = result.priorPlan as EditPlan | undefined;

      await startTyping(chatId);
      const plan = await planEdit(job.id, {
        caption: isRefinement
          ? (result.priorCaption as string | undefined) ?? ""
          : captionOf(payload),
        clarificationAnswer: isRefinement ? undefined : clarificationAnswer,
        clipCount,
        refinement:
          isRefinement && priorPlan
            ? { priorPlan, request: (result.refinementRequest as string | undefined) ?? "" }
            : undefined,
      });

      // A refinement that came back unchanged — the matcher couldn't apply the
      // ask (no field for it) or it was already that way. Re-rendering an
      // identical video is pointless and reads as "it did nothing"; send the
      // (honest) confirmation and stop instead.
      if (isRefinement && priorPlan && planFingerprint(plan) === planFingerprint(priorPlan)) {
        const msg =
          plan.confirmation && plan.confirmation !== "ok on it bestie, making ur edit"
            ? plan.confirmation
            : "hmm bb i couldn't change that one. i can swap the music, change the speed or pace, edit the text or its color and case (caps or lowercase), how long it shows, transitions, add a colored pill behind it, that kinda thing. what do u want different?";
        await sendTextReply(chatId, msg, `${job.id}-noop`);
        log.info({ jobId: job.id, refinementOf }, "refinement was a no-op, replied instead of re-rendering");
        return { nextState: "replied", resultPatch: { plan, refinementNoop: true } };
      }

      const shouldAskClarification =
        !isRefinement && plan.needs_clarification && Boolean(plan.clarification_question) && clarificationCount < 1;
      if (shouldAskClarification) {
        await sendTextReply(chatId, plan.clarification_question, `${job.id}-clarify-${clarificationCount}`);
        return {
          nextState: "awaiting_clarification",
          resultPatch: { plan, clarificationCount: clarificationCount + 1 },
        };
      }

      const estimatedRenderMs = estimateRenderMs(plan, clipCount);
      await sendTextReply(chatId, `${plan.confirmation}, ${estimatePhrase(estimatedRenderMs)}`, `${job.id}-confirm`);
      return { nextState: "matched", resultPatch: { plan, estimatedRenderMs } };
    }

    case "matched": {
      const plan = result.plan as EditPlan | undefined;
      if (!plan) {
        return { nextState: "failed", error: "missing edit plan" };
      }
      const clips = (result.clips as ClipDownload[] | undefined) ?? [];
      const clipUrls = clips
        .map((c) => c.r2PublicUrl)
        .filter((u): u is string => typeof u === "string" && u.length > 0);
      if (clipUrls.length === 0) {
        return { nextState: "failed", error: "no clip URLs for render" };
      }
      const outputSize =
        (result.outputSize as { width: number; height: number } | undefined) ?? undefined;

      const hasMusicSpec = plan.music.tags.length > 0 || plan.music.freetext.trim().length > 0;
      const musicSpec = hasMusicSpec ? plan.music : STYLE_PRESETS[plan.style].fallbackMusic;
      // Refinement that didn't touch the music → reuse the exact same track
      // (so "make the text yellow" doesn't also swap the song).
      const priorPlan = result.priorPlan as EditPlan | undefined;
      const priorMusicUrl = result.priorMusicUrl as string | undefined;
      const musicUnchanged = priorPlan
        ? JSON.stringify(plan.music) === JSON.stringify(priorPlan.music)
        : false;
      const resolvedMusic =
        musicUnchanged && priorMusicUrl ? priorMusicUrl : await resolveMusicUrl(job.id, musicSpec);
      const musicUrl = resolvedMusic ?? FALLBACK_MUSIC_URL;

      log.info(
        {
          clipCount: clipUrls.length,
          style: plan.style,
          outputSize,
          musicSpec,
          musicResolved: Boolean(resolvedMusic),
          transition: plan.transition,
          motion: plan.motion,
          colorFilter: plan.color_filter,
          speed: plan.speed,
        },
        "building Shotstack edit",
      );
      try {
        const renderId = await submitRender(job.id, buildEdit(plan, clipUrls, outputSize, musicUrl));
        return {
          nextState: "submitted",
          resultPatch: { renderId, renderSubmittedAt: Date.now(), nextPollAt: 0, musicUrl, musicSpec },
        };
      } catch (err) {
        // Shotstack rejected the edit (likely a value it didn't like in an
        // optional bit). Retry once with a stripped-down "safe" edit so the
        // user still gets a video; if even that fails, let it bubble.
        log.warn(
          { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
          "render submit rejected, retrying in safe mode",
        );
        const safeRenderId = await rebuildAndSubmitRender(job.id, { ...result, musicUrl }, { safe: true });
        if (!safeRenderId) throw err;
        return {
          nextState: "submitted",
          resultPatch: {
            renderId: safeRenderId,
            renderResubmitted: true, // used our one retry
            renderSubmittedAt: Date.now(),
            nextPollAt: 0,
            musicUrl,
            musicSpec,
          },
        };
      }
    }

    case "submitted": {
      const renderId = result.renderId as string;
      const now = Date.now();
      const nextPollAt = (result.nextPollAt as number | undefined) ?? 0;
      if (now < nextPollAt) {
        return { nextState: "submitted" };
      }

      // Poll Shotstack FIRST so the rest of this branch can use the actual
      // render status. (The terminal-state handling, the giveup/resubmit
      // timers, the progress milestone — all benefit from a fresh poll.)
      const status = await pollRender(job.id, renderId);
      if (status.status === "done") {
        // Log the wall-clock delta vs our heuristic estimate so we can
        // recalibrate the constants in estimateRenderMs from real data over
        // time. (No DB persistence — just structured logs.)
        const submittedAtForLog = (result.renderSubmittedAt as number | undefined) ?? job.createdAt.getTime();
        const estMsForLog = (result.estimatedRenderMs as number | undefined) ?? 0;
        log.info(
          {
            renderId,
            actualMs: now - submittedAtForLog,
            estimatedMs: estMsForLog,
            ratio: estMsForLog > 0 ? (now - submittedAtForLog) / estMsForLog : null,
            shotstackCreated: status.created,
            shotstackUpdated: status.updated,
          },
          "render completed — estimator calibration sample",
        );
        return { nextState: "rendered", resultPatch: { videoUrl: status.url } };
      }
      if (status.status === "failed") {
        if (!result.renderResubmitted) {
          const newRenderId = await rebuildAndSubmitRender(job.id, result, { safe: true });
          if (newRenderId) {
            log.warn(
              { jobId: job.id, oldRenderId: renderId, newRenderId, renderError: status.error },
              "render failed, retrying in safe mode",
            );
            return {
              nextState: "submitted",
              resultPatch: { renderId: newRenderId, renderResubmitted: true, nextPollAt: now + POLL_INTERVAL_MS },
            };
          }
        }
        return { nextState: "failed", error: status.error };
      }

      // Still in flight (queued / fetching / rendering / saving). Compute the
      // age-based timers (these are the only flow-control signals we have —
      // Shotstack gives us no ETA).
      const submittedAt = (result.renderSubmittedAt as number | undefined) ?? job.createdAt.getTime();
      const ageMs = now - submittedAt;
      const estMs = Math.max(
        RENDER_ESTIMATE_MIN_MS,
        Math.min(RENDER_ESTIMATE_MAX_MS, (result.estimatedRenderMs as number | undefined) ?? 60_000),
      );
      const giveUpMs = estMs + RENDER_GIVEUP_GRACE_MS;
      const resubmitMs = estMs + RENDER_RESUBMIT_GRACE_MS;
      const slowNoticeMs = estMs + RENDER_SLOW_NOTICE_GRACE_MS;
      const slowNotice2Ms = estMs + RENDER_SLOW_NOTICE_2_GRACE_MS;

      // Give up on a wedged render so the user gets a definitive answer.
      if (ageMs > giveUpMs) {
        return { nextState: "failed", error: `render exceeded ~${Math.round(giveUpMs / 60_000)}min, gave up` };
      }

      // One silent resubmit — the sandbox sometimes drops a render but a fresh
      // submit goes straight through.
      if (ageMs > resubmitMs && !result.renderResubmitted) {
        const newRenderId = await rebuildAndSubmitRender(job.id, result);
        if (newRenderId) {
          log.warn({ jobId: job.id, oldRenderId: renderId, newRenderId, ageMs }, "render slow, resubmitted a fresh one");
          return {
            nextState: "submitted",
            resultPatch: { renderId: newRenderId, renderResubmitted: true, nextPollAt: now + POLL_INTERVAL_MS },
          };
        }
      }

      // Progress milestone — fire when Shotstack itself reports it reached a
      // new stage. One per tick (the lowest unsent milestone we've crossed),
      // tracked in result.progressNotified. Runs even AFTER a slow notice
      // has fired, because a Shotstack stage transition is fresh real-world
      // info (e.g. "75 percent, just saving it" remains useful even if the
      // overall render is already overdue).
      const stagePct = STAGE_TO_PCT[status.status] ?? 0;
      const notified = (result.progressNotified as number[] | undefined) ?? [];
      const stagesSeen = (result.progressStages as string[] | undefined) ?? [];
      const stagesPatch = stagesSeen.includes(status.status)
        ? undefined
        : { progressStages: [...stagesSeen, status.status] };

      if (notified.length < PROGRESS_MILESTONES.length) {
        for (const pct of PROGRESS_MILESTONES) {
          if (notified.includes(pct)) continue;
          if (stagePct < pct) break; // Shotstack hasn't reached this stage yet
          const text =
            pct === 25 ? "25 percent done bestie, pulling ur clips" :
            pct === 50 ? "halfway there, rendering it now" :
                         "75 percent, almost there, just saving it";
          await sendTextReply(chatId, text, `${job.id}-progress-${pct}`).catch(() => {});
          return {
            nextState: "submitted",
            resultPatch: {
              progressNotified: [...notified, pct],
              ...(stagesPatch ?? {}),
              nextPollAt: now + POLL_INTERVAL_MS,
            },
          };
        }
      }

      // Slow-notice 1 — fires once at ~est+2min so the user knows we haven't
      // ghosted them.
      if (ageMs > slowNoticeMs && !result.slowNoticeSent) {
        await sendTextReply(
          chatId,
          "ok this one's taking a sec longer than i thought, still cooking ur edit, hang on bb",
          `${job.id}-slow`,
        ).catch(() => {});
        return {
          nextState: "submitted",
          resultPatch: { slowNoticeSent: true, ...(stagesPatch ?? {}), nextPollAt: now + POLL_INTERVAL_MS },
        };
      }

      // Slow-notice 2 — fires once at ~est+5min (after the silent resubmit at
      // est+4min, before the giveup at est+9min) so the long stretch isn't
      // silent. Gated on slowNoticeSent so we never send #2 without #1.
      if (ageMs > slowNotice2Ms && result.slowNoticeSent && !result.slowNotice2Sent) {
        await sendTextReply(
          chatId,
          "ok ur edit's being chunky today bb, still on it, almost there i promise",
          `${job.id}-slow-2`,
        ).catch(() => {});
        return {
          nextState: "submitted",
          resultPatch: { slowNotice2Sent: true, ...(stagesPatch ?? {}), nextPollAt: now + POLL_INTERVAL_MS },
        };
      }

      return {
        nextState: "submitted",
        resultPatch: { ...(stagesPatch ?? {}), nextPollAt: now + POLL_INTERVAL_MS },
      };
    }

    case "rendered": {
      const videoUrl = result.videoUrl as string;
      await startTyping(chatId);
      const attachmentId = await uploadAttachment(job.id, videoUrl, "edited.mp4");
      return { nextState: "uploaded", resultPatch: { attachmentId } };
    }

    case "uploaded": {
      const attachmentId = result.attachmentId as string;
      const style = (result.plan as EditPlan | undefined)?.style;
      const isRefinement = Boolean(result.refinementOf);
      const caption = isRefinement
        ? style
          ? `here's the updated ${style} edit bestie`
          : "here's the updated one bestie"
        : style
          ? `here's ur ${style} edit bestie`
          : "here u go bestie";
      await sendVideoReply(job.id, chatId, attachmentId, caption);
      return { nextState: "delivered" };
    }

    default:
      throw new Error(`advance() called on unexpected state: ${job.state}`);
  }
}
