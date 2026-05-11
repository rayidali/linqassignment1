import { logger } from "./logger.js";
import * as stubs from "./stubs/index.js";
import { downloadMedia } from "./services/media.js";
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

export async function advance(job: JobRow): Promise<AdvanceResult> {
  const log = logger.child({ jobId: job.id, fromState: job.state });
  log.debug("advancing");

  const payload = job.payload as LinqWebhookPayload;
  const result = (job.result ?? {}) as Record<string, unknown>;

  switch (job.state) {
    case "received": {
      const media = payload.data.parts.find((p) => p.type === "media");
      if (!media || media.type !== "media") {
        return { nextState: "failed", error: "no media in webhook payload" };
      }
      const { key, size, contentType, publicUrl } = await downloadMedia(
        job.id,
        media.url,
        media.filename,
      );
      return {
        nextState: "downloaded",
        resultPatch: {
          r2Key: key,
          r2PublicUrl: publicUrl,
          mediaSize: size,
          mediaContentType: contentType,
          sourceUrl: media.url,
        },
      };
    }

    case "downloaded": {
      const text = payload.data.parts.find((p) => p.type === "text");
      const prompt = text?.value ?? "";
      const choice = await stubs.matchTemplate(job.id, prompt);
      return { nextState: "matched", resultPatch: { choice } };
    }

    case "matched": {
      const choice = result.choice as TemplateChoice;
      const renderId = await stubs.submitRender(job.id, choice);
      return { nextState: "submitted", resultPatch: { renderId } };
    }

    case "submitted": {
      const renderId = result.renderId as string;
      const status = await stubs.pollRender(job.id, renderId);
      if (status.status === "rendering") {
        return { nextState: "submitted" };
      }
      if (status.status === "failed") {
        return { nextState: "failed", error: status.error };
      }
      return { nextState: "rendered", resultPatch: { videoUrl: status.url } };
    }

    case "rendered": {
      const videoUrl = result.videoUrl as string;
      const attachmentId = await stubs.uploadToLinq(job.id, videoUrl);
      return { nextState: "uploaded", resultPatch: { attachmentId } };
    }

    case "uploaded": {
      const chatId = payload.data.chat.id;
      const attachmentId = result.attachmentId as string;
      await stubs.sendReply(job.id, chatId, attachmentId);
      return { nextState: "delivered" };
    }

    default:
      throw new Error(`advance() called on unexpected state: ${job.state}`);
  }
}
