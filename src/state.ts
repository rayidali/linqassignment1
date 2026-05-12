import { logger } from "./logger.js";
import { downloadMedia } from "./services/media.js";
import { planEdit } from "./services/match.js";
import { submitRender, pollRender } from "./services/shotstack.js";
import { resolveMusicUrl } from "./services/music.js";
import { uploadAttachment, sendVideoReply, sendTextReply } from "./services/linq.js";
import { generateReply } from "./services/chat.js";
import { buildEdit, STYLE_PRESETS } from "./templates/index.js";
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
};

export type AdvanceResult = {
  nextState: State;
  resultPatch?: Record<string, unknown>;
  error?: string;
};

const POLL_INTERVAL_MS = 5000;

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
      const downloads = await Promise.all(
        usable.map((p) => downloadMedia(job.id, p.url, p.filename, p.mime_type)),
      );
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
      const clarificationAnswer = result.clarificationAnswer as string | undefined;
      const clarificationCount = (result.clarificationCount as number | undefined) ?? 0;
      const plan = await planEdit(job.id, {
        caption: captionOf(payload),
        clarificationAnswer,
        clipCount,
      });

      const shouldAskClarification =
        plan.needs_clarification && Boolean(plan.clarification_question) && clarificationCount < 1;
      if (shouldAskClarification) {
        await sendTextReply(chatId, plan.clarification_question, `${job.id}-clarify-${clarificationCount}`);
        return {
          nextState: "awaiting_clarification",
          resultPatch: { plan, clarificationCount: clarificationCount + 1 },
        };
      }

      const estimate = clipCount > 1 ? "should be ~2 min" : "should be ~1 min";
      await sendTextReply(chatId, `${plan.confirmation}, ${estimate}`, `${job.id}-confirm`);
      return { nextState: "matched", resultPatch: { plan } };
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
      const resolvedMusic = await resolveMusicUrl(job.id, musicSpec);
      const musicUrl = resolvedMusic ?? FALLBACK_MUSIC_URL;

      log.info(
        {
          clipCount: clipUrls.length,
          style: plan.style,
          outputSize,
          musicSpec,
          musicResolved: Boolean(resolvedMusic),
          transition: plan.transition,
          colorFilter: plan.color_filter,
          speed: plan.speed,
        },
        "building Shotstack edit",
      );
      const edit = buildEdit(plan, clipUrls, outputSize, musicUrl);
      const renderId = await submitRender(job.id, edit);
      return {
        nextState: "submitted",
        resultPatch: { renderId, nextPollAt: 0, musicUrl, musicSpec },
      };
    }

    case "submitted": {
      const renderId = result.renderId as string;
      const now = Date.now();
      const nextPollAt = (result.nextPollAt as number | undefined) ?? 0;
      if (now < nextPollAt) {
        return { nextState: "submitted" };
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
      const attachmentId = await uploadAttachment(job.id, videoUrl, "edited.mp4");
      return { nextState: "uploaded", resultPatch: { attachmentId } };
    }

    case "uploaded": {
      const attachmentId = result.attachmentId as string;
      const style = (result.plan as EditPlan | undefined)?.style;
      const caption = style ? `here's ur ${style} edit` : "here u go";
      await sendVideoReply(job.id, chatId, attachmentId, caption);
      return { nextState: "delivered" };
    }

    default:
      throw new Error(`advance() called on unexpected state: ${job.state}`);
  }
}
