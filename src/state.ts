import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { downloadMedia, type DownloadResult } from "./services/media.js";
import { planEdit } from "./services/match.js";
import { submitRender, pollRender } from "./services/shotstack.js";
import { resolveMusicUrl } from "./services/music.js";
import { uploadAttachment, sendVideoReply, sendTextReply, startTyping } from "./services/linq.js";
import { generateReply, classifyTweakRequest } from "./services/chat.js";
import { buildEdit, STYLE_PRESETS, PACE_TO_CLIP_SECONDS } from "./templates/index.js";
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
const RENDER_GIVEUP_GRACE_MS = 9 * 60_000;
// Bounds on the render estimate (a render of one of our short montages
// shouldn't legitimately take more than a few minutes; never less than ~20s).
const RENDER_ESTIMATE_MIN_MS = 20_000;
const RENDER_ESTIMATE_MAX_MS = 5 * 60_000;

// Rough estimate of how long Shotstack will take: queue/setup baseline plus a
// few × the output duration (1080p renders run slower than realtime). Loose on
// purpose — drives the "should be ~X" line to the user and scales the
// slow/resubmit/giveup timers off it. Output duration = clips × per-clip
// montage seconds; for a single clip we don't know its length here, so assume
// a short clip.
function estimateRenderMs(plan: EditPlan, clipCount: number): number {
  const outputSeconds = clipCount > 1 ? clipCount * PACE_TO_CLIP_SECONDS[plan.pace] : 12;
  const seconds = 20 + outputSeconds * 4;
  return Math.round(Math.max(RENDER_ESTIMATE_MIN_MS, Math.min(RENDER_ESTIMATE_MAX_MS, seconds * 1000)));
}

function estimatePhrase(ms: number): string {
  const s = ms / 1000;
  if (s <= 45) return "should be quick, under a min";
  if (s <= 90) return "should be about a min";
  if (s <= 180) return "give it a couple mins";
  return "this one's a bit bigger, give it a few mins";
}

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
    text_overlays: (p.text_overlays ?? []).map((o) => ({
      text: o.text,
      position: o.position,
      color: o.color,
      uppercase: o.uppercase,
      background: o.background ?? "none",
      animation: o.animation ?? "none",
    })),
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
      const ack = "k on it, redoing that for u";
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
          plan.confirmation && plan.confirmation !== "on it, making ur edit"
            ? plan.confirmation
            : "hmm i couldn't change that one. i can swap the music, change the speed/pace, edit the text or colors, add transitions or a colored box behind text, that kinda thing. what do u want different?";
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
      const edit = buildEdit(plan, clipUrls, outputSize, musicUrl);
      const renderId = await submitRender(job.id, edit);
      return {
        nextState: "submitted",
        resultPatch: { renderId, renderSubmittedAt: Date.now(), nextPollAt: 0, musicUrl, musicSpec },
      };
    }

    case "submitted": {
      const renderId = result.renderId as string;
      const now = Date.now();
      const nextPollAt = (result.nextPollAt as number | undefined) ?? 0;
      if (now < nextPollAt) {
        return { nextState: "submitted" };
      }
      // Age of this render. Fall back to job creation time for jobs that
      // entered `submitted` before renderSubmittedAt was tracked.
      const submittedAt = (result.renderSubmittedAt as number | undefined) ?? job.createdAt.getTime();
      const ageMs = now - submittedAt;
      // Wait windows scale off the per-edit render estimate, not flat numbers.
      const estMs = Math.max(
        RENDER_ESTIMATE_MIN_MS,
        Math.min(RENDER_ESTIMATE_MAX_MS, (result.estimatedRenderMs as number | undefined) ?? 60_000),
      );
      const giveUpMs = estMs + RENDER_GIVEUP_GRACE_MS;
      const resubmitMs = estMs + RENDER_RESUBMIT_GRACE_MS;
      const slowNoticeMs = estMs + RENDER_SLOW_NOTICE_GRACE_MS;

      // Give up on a wedged render so the user gets a definitive answer.
      if (ageMs > giveUpMs) {
        return { nextState: "failed", error: `render exceeded ~${Math.round(giveUpMs / 60_000)}min, gave up` };
      }

      // One silent resubmit — the sandbox sometimes drops a render but a fresh
      // submit goes straight through. Everything we need is still in `result`.
      if (ageMs > resubmitMs && !result.renderResubmitted) {
        const plan = result.plan as EditPlan | undefined;
        const clips = (result.clips as ClipDownload[] | undefined) ?? [];
        const clipUrls = clips
          .map((c) => c.r2PublicUrl)
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        if (plan && clipUrls.length > 0) {
          const outputSize = result.outputSize as { width: number; height: number } | undefined;
          const musicUrl = (result.musicUrl as string | undefined) ?? FALLBACK_MUSIC_URL;
          const edit = buildEdit(plan, clipUrls, outputSize, musicUrl);
          const newRenderId = await submitRender(job.id, edit);
          log.warn({ jobId: job.id, oldRenderId: renderId, newRenderId, ageMs }, "render slow, resubmitted a fresh one");
          return {
            nextState: "submitted",
            resultPatch: { renderId: newRenderId, renderResubmitted: true, nextPollAt: now + POLL_INTERVAL_MS },
          };
        }
        // Can't resubmit (missing data) — fall through and keep polling the original.
      }

      // Heads-up to the user once if it's running over the estimate.
      if (ageMs > slowNoticeMs && !result.slowNoticeSent) {
        await sendTextReply(
          chatId,
          "k this one's taking a bit longer than i thought, still working on ur edit, hang tight",
          `${job.id}-slow`,
        ).catch(() => {});
        return { nextState: "submitted", resultPatch: { slowNoticeSent: true, nextPollAt: now + POLL_INTERVAL_MS } };
      }

      const status = await pollRender(job.id, renderId);
      if (status.status === "done") {
        return { nextState: "rendered", resultPatch: { videoUrl: status.url } };
      }
      if (status.status === "failed") {
        return { nextState: "failed", error: status.error };
      }
      return { nextState: "submitted", resultPatch: { nextPollAt: now + POLL_INTERVAL_MS } };
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
          ? `here's the updated ${style} edit`
          : "here's the updated one"
        : style
          ? `here's ur ${style} edit`
          : "here u go";
      await sendVideoReply(job.id, chatId, attachmentId, caption);
      return { nextState: "delivered" };
    }

    default:
      throw new Error(`advance() called on unexpected state: ${job.state}`);
  }
}
