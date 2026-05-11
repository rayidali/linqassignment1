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
  SHOTSTACK_API_KEY: optionalString(),
  ANTHROPIC_API_KEY: optionalString(),
  R2_ACCOUNT_ID: optionalString(),
  R2_ACCESS_KEY_ID: optionalString(),
  R2_SECRET_ACCESS_KEY: optionalString(),
  R2_BUCKET: optionalString(),
  R2_PUBLIC_BASE_URL: optionalUrl(),

  JAMENDO_CLIENT_ID: optionalString(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
