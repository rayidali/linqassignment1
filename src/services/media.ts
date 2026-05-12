import { Upload } from "@aws-sdk/lib-storage";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";
import { fetchAndNormalize, fetchAndNormalizeImage } from "./transcode.js";

export type DownloadResult = {
  key: string;
  size: number;
  contentType: string;
  publicUrl: string | null;
  width: number;
  height: number;
};

// Fetches a media part from Linq's presigned URL and normalizes it into a
// clean H.264 MP4 clip uploaded to R2 — videos via ffmpeg (autorotate +
// transcode + cap 1280px), still images via sharp (HEIC decode + EXIF
// auto-rotate + resize) looped into a short clip. Returns R2 key + dims.
export async function downloadMedia(
  jobId: string,
  url: string,
  filename: string,
  mimeType: string,
): Promise<DownloadResult> {
  const isImage = mimeType.toLowerCase().startsWith("image/");
  logger.info({ jobId, url, filename, mimeType, isImage }, "downloading + normalizing media");
  const { buffer, width, height } = isImage
    ? await fetchAndNormalizeImage(jobId, url)
    : await fetchAndNormalize(jobId, url);

  const base =
    filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "media";
  const key = `inbound/${jobId}/${base}.mp4`;

  const upload = new Upload({
    client: getR2Client(),
    params: {
      Bucket: getR2Bucket(),
      Key: key,
      Body: buffer,
      ContentType: "video/mp4",
    },
  });
  await upload.done();

  const publicUrl = r2PublicUrl(key);
  logger.info(
    { jobId, key, size: buffer.length, width, height, publicUrl },
    "normalized media uploaded to R2",
  );
  return { key, size: buffer.length, contentType: "video/mp4", publicUrl, width, height };
}
