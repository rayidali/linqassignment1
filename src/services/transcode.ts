import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { logger } from "../logger.js";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "../http.js";

// ffmpeg-static's CJS default export resolves to the binary path at runtime
// under esModuleInterop; the .d.ts/CJS interop confuses tsc's type, so cast.
const FFMPEG_PATH = ffmpegStatic as unknown as string | null;
const TRANSCODE_TIMEOUT_MS = 180_000;
const MAX_INPUT_BYTES = 150 * 1024 * 1024;
// Long-side cap for normalized media — 1080p output. (Was 1280 on the 512MB
// free tier; the Standard instance has the RAM/CPU headroom for 1920.)
const MAX_DIMENSION = 1920;
// libx264 quality: lower = better. ~21 is visually clean; 25 was the
// free-tier "small + fast" compromise.
const X264_CRF = "21";
// How long a still image plays as a clip. Multi-clip montages trim each clip
// to the template's per-clip duration anyway; a single image plays the full
// duration. 6s comfortably exceeds our longest template clip (5s).
const IMAGE_CLIP_DURATION_S = 6;

export type NormalizedVideo = {
  buffer: Buffer;
  width: number;
  height: number;
};

function makeEven(n: number): number {
  return n % 2 === 0 ? n : Math.max(2, n - 1);
}

// Downloads a video from a URL into a temp file, then runs ffmpeg to:
//  - apply rotation metadata (autorotate is ON by default — fixes iPhone
//    portrait videos that store a landscape frame + a "rotate 90°" matrix
//    that Shotstack does NOT apply)
//  - transcode to H.264 / yuv420p (universal compatibility, drops HEVC)
//  - cap the long side at MAX_DIMENSION (1080p)
//  - faststart (moov atom at the front, for streaming playback)
// Returns the normalized MP4 bytes plus its true display dimensions.
export async function fetchAndNormalize(
  jobId: string,
  sourceUrl: string,
): Promise<NormalizedVideo> {
  if (!FFMPEG_PATH) {
    throw new Error("ffmpeg-static binary not available");
  }
  const dir = await mkdtemp(join(tmpdir(), `vid-${jobId.slice(0, 8)}-`));
  const inPath = join(dir, "in");
  const outPath = join(dir, "out.mp4");
  try {
    const res = await fetchWithTimeout(sourceUrl, {}, MEDIA_TIMEOUT_MS);
    if (!res.ok || !res.body) {
      throw new Error(`fetch source failed: ${res.status} ${res.statusText}`);
    }
    const lenHeader = res.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_INPUT_BYTES) {
      throw new Error(`source too large: ${lenHeader} bytes (max ${MAX_INPUT_BYTES})`);
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(inPath),
    );
    logger.info({ jobId, sourceUrl }, "source downloaded, transcoding with ffmpeg");

    const args = [
      "-y",
      "-i", inPath,
      // First scale: fit within a MAX_DIMENSION box, preserving aspect, only
      // shrinking (decrease). Second: round to even dims (H.264 requires it).
      "-vf", `scale=${MAX_DIMENSION}:${MAX_DIMENSION}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", X264_CRF, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ];
    const stderr = await runFfmpeg(FFMPEG_PATH, args);
    const dims = parseOutputDims(stderr);
    if (!dims) {
      throw new Error(`could not parse output dimensions from ffmpeg stderr: ${stderr.slice(-1000)}`);
    }

    const buffer = await readFileToBuffer(outPath);
    logger.info(
      { jobId, width: dims.width, height: dims.height, bytes: buffer.length },
      "transcode complete",
    );
    return { buffer, width: dims.width, height: dims.height };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Turns a still image (JPEG/PNG/HEIC/etc.) into a clean MP4 clip:
//  - sharp decodes (including HEIC, which ffmpeg-static can't), auto-rotates
//    from EXIF orientation, resizes to fit within MAX_DIMENSION (no enlarging),
//    re-encodes as JPEG
//  - ffmpeg loops that JPEG into an IMAGE_CLIP_DURATION_S-second H.264 video
// Returns the MP4 bytes + dims (matching the resized image's orientation).
export async function fetchAndNormalizeImage(
  jobId: string,
  sourceUrl: string,
): Promise<NormalizedVideo> {
  if (!FFMPEG_PATH) {
    throw new Error("ffmpeg-static binary not available");
  }
  const dir = await mkdtemp(join(tmpdir(), `img-${jobId.slice(0, 8)}-`));
  const jpgPath = join(dir, "img.jpg");
  const outPath = join(dir, "out.mp4");
  try {
    const res = await fetchWithTimeout(sourceUrl, {}, MEDIA_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`fetch image failed: ${res.status} ${res.statusText}`);
    }
    const inputBuf = Buffer.from(await res.arrayBuffer());
    if (inputBuf.length > MAX_INPUT_BYTES) {
      throw new Error(`image too large: ${inputBuf.length} bytes`);
    }
    const { data, info } = await sharp(inputBuf)
      .rotate() // auto-rotate from EXIF orientation tag
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    await writeFile(jpgPath, data);
    const width = makeEven(info.width);
    const height = makeEven(info.height);
    logger.info({ jobId, sourceUrl, width, height }, "image decoded + rotated + resized, building clip");

    const args = [
      "-y",
      "-loop", "1",
      "-i", jpgPath,
      "-t", String(IMAGE_CLIP_DURATION_S),
      "-r", "30",
      "-vf", `scale=${width}:${height},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", X264_CRF,
      "-movflags", "+faststart",
      outPath,
    ];
    await runFfmpeg(FFMPEG_PATH, args);

    const buffer = await readFileToBuffer(outPath);
    logger.info({ jobId, width, height, bytes: buffer.length }, "image clip built");
    return { buffer, width, height };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, TRANSCODE_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Pull the OUTPUT video stream's WxH from ffmpeg's stderr (the section after
// "Output #0", line "... Video: ... 1280x720 ...").
function parseOutputDims(stderr: string): { width: number; height: number } | null {
  const outIdx = stderr.lastIndexOf("Output #0");
  const section = outIdx >= 0 ? stderr.slice(outIdx) : stderr;
  const m = section.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function readFileToBuffer(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
