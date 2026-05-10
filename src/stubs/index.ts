import { logger } from "../logger.js";
import type { TemplateChoice } from "../schemas.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function downloadMedia(jobId: string, url: string): Promise<string> {
  logger.info({ jobId, url }, "stub: downloading media");
  await sleep(300);
  return `r2://fake-bucket/${jobId}/clip.mp4`;
}

export async function matchTemplate(jobId: string, prompt: string): Promise<TemplateChoice> {
  logger.info({ jobId, prompt }, "stub: matching template");
  await sleep(500);
  return {
    template_id: "tmpl_sad_anime",
    music_id: "track_lofi_01",
    clip_order: ["clip_1"],
    text_overlays: [{ text: prompt.slice(0, 40), timestamp: 0 }],
  };
}

export async function submitRender(jobId: string, choice: TemplateChoice): Promise<string> {
  logger.info({ jobId, templateId: choice.template_id, musicId: choice.music_id }, "stub: submitting render");
  await sleep(200);
  return `render_fake_${Date.now()}`;
}

export type RenderStatus =
  | { status: "rendering" }
  | { status: "done"; url: string }
  | { status: "failed"; error: string };

// Stub returns "rendering" for the first 2 polls, then "done" — so the
// `submitted` state self-loops a few ticks before transitioning to `rendered`.
const pollCounts = new Map<string, number>();

export async function pollRender(jobId: string, renderId: string): Promise<RenderStatus> {
  const count = (pollCounts.get(renderId) ?? 0) + 1;
  pollCounts.set(renderId, count);
  logger.info({ jobId, renderId, pollCount: count }, "stub: polling render");
  await sleep(150);
  if (count < 3) return { status: "rendering" };
  return { status: "done", url: `https://fake.cdn/output/${renderId}.mp4` };
}

export async function uploadToLinq(jobId: string, videoUrl: string): Promise<string> {
  logger.info({ jobId, videoUrl }, "stub: uploading to Linq attachments");
  await sleep(300);
  return `att_fake_${Date.now()}`;
}

export async function sendReply(jobId: string, chatId: string, attachmentId: string): Promise<void> {
  logger.info({ jobId, chatId, attachmentId }, "stub: sending reply to Linq");
  await sleep(150);
}
