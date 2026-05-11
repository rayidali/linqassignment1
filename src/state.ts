import { logger } from "./logger.js";
import * as stubs from "./stubs/index.js";
import { downloadMedia } from "./services/media.js";
import { matchTemplate } from "./services/match.js";
import { submitRender, pollRender } from "./services/shotstack.js";
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
      const clipUrl = result.r2PublicUrl as string | undefined;
      if (!clipUrl) {
        return { nextState: "failed", error: "missing r2PublicUrl for clip" };
      }
      const edit = tpl.buildEdit([clipUrl], choice);
      const renderId = await submitRender(job.id, edit);
      return { nextState: "submitted", resultPatch: { renderId, nextPollAt: 0 } };
    }

    case "submitted": {
      const renderId = result.renderId as string;
      // Throttle Shotstack polls — worker ticks every 1s but renders take
      // 10-60s; polling every tick would hammer the rate limit.
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
      return { nextState: "submitted", resultPatch: { nextPollAt: now + 5000 } };
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
