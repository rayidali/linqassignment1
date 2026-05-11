import { env } from "../env.js";
import { logger } from "../logger.js";

// Sandbox env. Switch to "v1" for production.
const SHOTSTACK_ENV = "stage";

function shotstackUrl(path: string): string {
  return `https://api.shotstack.io/${SHOTSTACK_ENV}/${path}`;
}

function authHeaders(): Record<string, string> {
  if (!env.SHOTSTACK_API_KEY) {
    throw new Error("SHOTSTACK_API_KEY not set");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": env.SHOTSTACK_API_KEY,
  };
}

export async function submitRender(jobId: string, edit: unknown): Promise<string> {
  const body = JSON.stringify(edit);
  logger.info({ jobId, editBytes: body.length }, "submitting render to Shotstack");

  const res = await fetch(shotstackUrl("render"), {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; response?: { id?: string }; message?: string }
    | null;

  if (!res.ok || !data?.response?.id) {
    throw new Error(
      `Shotstack render submit failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }
  logger.info({ jobId, renderId: data.response.id }, "Shotstack render queued");
  return data.response.id;
}

export type MediaDimensions = { width: number; height: number };

function makeEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

// Scale so the longer side is at most maxLong, keep aspect, round to even
// (Shotstack's encoder requires even dimensions).
function clampDimensions(
  width: number,
  height: number,
  maxLong = 1280,
): MediaDimensions {
  const longSide = Math.max(width, height);
  const scale = longSide > maxLong ? maxLong / longSide : 1;
  return {
    width: Math.max(2, makeEven(width * scale)),
    height: Math.max(2, makeEven(height * scale)),
  };
}

// Probe a media URL via Shotstack's hosted FFprobe. Returns the *display*
// dimensions (accounts for rotation metadata — phones often store a
// landscape frame with a 90° rotation tag so it displays portrait).
// Returns null on any failure — caller should fall back to a default.
export async function probeMedia(jobId: string, url: string): Promise<MediaDimensions | null> {
  try {
    const res = await fetch(shotstackUrl(`probe/${encodeURIComponent(url)}`), {
      headers: { "x-api-key": env.SHOTSTACK_API_KEY ?? "" },
    });
    if (!res.ok) {
      logger.warn({ jobId, url, status: res.status }, "probe request failed");
      return null;
    }
    const data = (await res.json().catch(() => null)) as
      | {
          response?: {
            metadata?: {
              streams?: Array<{
                codec_type?: string;
                width?: number;
                height?: number;
                tags?: { rotate?: string };
                side_data_list?: Array<{ rotation?: number }>;
              }>;
            };
          };
        }
      | null;

    const streams = data?.response?.metadata?.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    if (!video || !video.width || !video.height) {
      logger.warn({ jobId, url }, "probe returned no usable video stream");
      return null;
    }

    let { width, height } = video;
    const rotateTag = video.tags?.rotate ? Number(video.tags.rotate) : 0;
    const rotateSide = video.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? 0;
    const rotation = ((rotateTag || rotateSide) % 360 + 360) % 360;
    if (rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    const dims = clampDimensions(width, height);
    logger.info({ jobId, url, raw: { w: video.width, h: video.height }, rotation, dims }, "probed media dimensions");
    return dims;
  } catch (err) {
    logger.warn({ jobId, url, err: err instanceof Error ? err.message : String(err) }, "probe threw");
    return null;
  }
}

export type ShotstackStatus =
  | { status: "queued" | "fetching" | "rendering" | "saving" }
  | { status: "done"; url: string }
  | { status: "failed"; error: string };

export async function pollRender(jobId: string, renderId: string): Promise<ShotstackStatus> {
  const res = await fetch(shotstackUrl(`render/${renderId}`), {
    headers: { "x-api-key": env.SHOTSTACK_API_KEY ?? "" },
  });
  const data = (await res.json().catch(() => null)) as
    | { response?: { status?: string; url?: string; error?: string } }
    | null;

  if (!res.ok || !data?.response?.status) {
    throw new Error(
      `Shotstack render status failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }
  const status = data.response.status;
  logger.info({ jobId, renderId, shotstackStatus: status }, "polled Shotstack");

  if (status === "done") {
    if (!data.response.url) {
      throw new Error("Shotstack render done but no URL in response");
    }
    return { status: "done", url: data.response.url };
  }
  if (status === "failed") {
    return { status: "failed", error: data.response.error ?? "unknown" };
  }
  return { status: status as "queued" | "fetching" | "rendering" | "saving" };
}
