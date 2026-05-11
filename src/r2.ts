import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

let _client: S3Client | null = null;

function isR2Configured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET,
  );
}

export function getR2Client(): S3Client {
  if (_client) return _client;
  if (!isR2Configured()) {
    throw new Error(
      "R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET",
    );
  }
  _client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

export function getR2Bucket(): string {
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET not set");
  return env.R2_BUCKET;
}

export function r2PublicUrl(key: string): string | null {
  if (!env.R2_PUBLIC_BASE_URL) return null;
  return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}
