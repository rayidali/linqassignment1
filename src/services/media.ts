import { Upload } from "@aws-sdk/lib-storage";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";
import { fetchAndNormalize } from "./transcode.js";

export type DownloadResult = {
  key: string;
  size: number;
  contentType: string;
  publicUrl: string | null;
  width: number;
  height: number;
};

// Fetches the user's media from Linq's presigned URL, normalizes it with
// ffmpeg (autorotate, transcode to H.264, cap at 1280px), and uploads the
// clean MP4 to R2. Returns the R2 key + true display dimensions.
export async function downloadMedia(
  jobId: string,
  url: string,
  filename: string,
): Promise<DownloadResult> {
  logger.info({ jobId, url, filename }, "downloading + normalizing media");
  const { buffer, width, height } = await fetchAndNormalize(jobId, url);

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
