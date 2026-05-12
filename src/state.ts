import { logger } from "./logger.js";
import { downloadMedia } from "./services/media.js";
import { matchTemplate } from "./services/match.js";
import { submitRender, pollRender } from "./services/shotstack.js";
import { uploadAttachment, sendVideoReply } from "./services/linq.js";
import { getTemplate } from "./templates/index.js";
import type { LinqWebhookPayload, TemplateChoice } from "./schemas.js";

export const STATES = [
  "received",
  "downloaded",
  "matched",
  "submitted",
  "rendered",
  "uploaded",
  "delivered",
  "failed",
] as const;

export type State = (typeof STATES)[number];

export const TERMINAL_STATES: ReadonlySet<State> = new Set(["delivered", "failed"]);

export type JobRow = {
  id: string;
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

export async function advance(job: JobRow): Promise<AdvanceResult> {
  const log = logger.child({ jobId: job.id, fromState: job.state });
  log.debug("advancing");

  const payload = job.payload as LinqWebhookPayload;
  const result = (job.result ?? {}) as Record<string, unknown>;

  switch (job.state) {
    case "received": {
      type MediaPart = Extract<
        LinqWebhookPayload["data"]["parts"][number],
        { type: "media" }
      >;
      const mediaParts: MediaPart[] = payload.data.parts.filter(
        (p): p is MediaPart => p.type === "media",
      );
      if (mediaParts.length === 0) {
        return { nextState: "failed", error: "no media in webhook payload" };
      }
      log.info({ clipCount: mediaParts.length }, "downloading + normalizing all media parts");
      const downloads = await Promise.all(
        mediaParts.map((p) => downloadMedia(job.id, p.url, p.filename)),
      );
      const clips: ClipDownload[] = downloads.map((d, i) => ({
        r2Key: d.key,
        r2PublicUrl: d.publicUrl,
        size: d.size,
        contentType: d.contentType,
        width: d.width,
        height: d.height,
        sourceUrl: mediaParts[i]!.url,
        filename: mediaParts[i]!.filename,
      }));
      // Output orientation = first clip's normalized dims (ffmpeg already
      // baked in rotation, so these are the true display dimensions).
      const first = clips[0]!;
      return {
        nextState: "downloaded",
        resultPatch: { clips, outputSize: { width: first.width, height: first.height } },
      };
    }

    case "downloaded": {
      const text = payload.data.parts.find((p) => p.type === "text");
      const prompt = text && text.type === "text" ? text.value : "";
      const choice = await matchTemplate(job.id, prompt);
      return { nextState: "matched", resultPatch: { choice } };
    }

    case "matched": {
      const choice = result.choice as TemplateChoice;
      const tpl = getTemplate(choice.template_id);
      if (!tpl) {
        return { nextState: "failed", error: `unknown template_id: ${choice.template_id}` };
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
      log.info(
        { clipCount: clipUrls.length, template: choice.template_id, outputSize },
        "building Shotstack edit",
      );
      const edit = tpl.buildEdit(clipUrls, choice, outputSize);
      const renderId = await submitRender(job.id, edit);
      return { nextState: "submitted", resultPatch: { renderId, nextPollAt: 0 } };
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
      const chatId = payload.data.chat.id;
      const attachmentId = result.attachmentId as string;
      await sendVideoReply(job.id, chatId, attachmentId);
      return { nextState: "delivered" };
    }

    default:
      throw new Error(`advance() called on unexpected state: ${job.state}`);
  }
}
