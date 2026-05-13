import "dotenv/config";
import { z } from "zod";

// Treat empty strings in .env as "not set" — otherwise `.url()` and similar
// rejects them as invalid when we really mean "leave it blank for now."
const optionalString = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const optionalUrl = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ADMIN_SECRET: z.string().min(8),

  LINQ_API_KEY: optionalString(),
  LINQ_WEBHOOK_SECRET: optionalString(),
  // Our Linq virtual number in E.164 (e.g. "+16504687059") — used for the
  // contact card so opted-in users can save us with a name.
  LINQ_NUMBER: optionalString(),
  SHOTSTACK_API_KEY: optionalString(),
  // "stage" = free sandbox (watermarked, max 1080-short-side, rate-limited);
  // "v1" = production (uses credits, no watermark, higher limits). Defaults to
  // stage; flip to "v1" in the env once you've got Shotstack credits.
  SHOTSTACK_ENV: z.enum(["stage", "v1"]).default("stage"),
  ANTHROPIC_API_KEY: optionalString(),
  R2_ACCOUNT_ID: optionalString(),
  R2_ACCESS_KEY_ID: optionalString(),
  R2_SECRET_ACCESS_KEY: optionalString(),
  R2_BUCKET: optionalString(),
  R2_PUBLIC_BASE_URL: optionalUrl(),

  JAMENDO_CLIENT_ID: optionalString(),

  // Comma-separated handles (E.164 phones / emails) that are auto-opted-in
  // and exempt from the per-minute video rate limit. e.g. "+18647654848"
  ACCESS_ALLOWLIST: optionalString(),

  // Injected automatically by Render at build/deploy time — surfaced by
  // GET /version and the startup log so you can confirm which build is live.
  RENDER_GIT_COMMIT: optionalString(),
  RENDER_GIT_BRANCH: optionalString(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
