import { Readable } from "node:stream";
import { Upload } from "@aws-sdk/lib-storage";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";

export type DownloadResult = {
  key: string;
  size: number;
  contentType: string;
  publicUrl: string | null;
};

// Downloads from a URL (e.g., Linq's presigned media URL) and streams the
// bytes into R2. Returns the R2 key + the public URL if R2_PUBLIC_BASE_URL
// is set (we need a public URL later to hand to Shotstack as a render input).
export async function downloadMedia(
  jobId: string,
  url: string,
  filename: string,
): Promise<DownloadResult> {
  logger.info({ jobId, url, filename }, "downloading media to R2");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `media download failed: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error("media download response has no body");
  }

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const sizeHeader = response.headers.get("content-length");
  const size = sizeHeader ? Number(sizeHeader) : 0;

  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "media";
  const key = `inbound/${jobId}/${safeFilename}`;

  const body = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );

  const upload = new Upload({
    client: getR2Client(),
    params: {
      Bucket: getR2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  });
  await upload.done();

  const publicUrl = r2PublicUrl(key);
  logger.info({ jobId, key, size, contentType, publicUrl }, "media uploaded to R2");
  return { key, size, contentType, publicUrl };
}
