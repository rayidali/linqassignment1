import sharp from "sharp";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";

const LINQ_BASE = "https://api.linqapp.com/api/partner/v3";
const LOGO_R2_KEY = "assets/contact-card-logo.png";

// Brand name shown on the contact card (Apple displays "first last").
const CARD_FIRST_NAME = "iMessage Video";
const CARD_LAST_NAME = "Editor";

// Square version of the brand mark (blue speech bubble + play triangle, on white).
const LOGO_SVG =
  `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">` +
  `<defs><linearGradient id="b" x1="50%" y1="0%" x2="50%" y2="100%">` +
  `<stop offset="0%" stop-color="#42A5F5"/><stop offset="100%" stop-color="#1976D2"/></linearGradient></defs>` +
  `<rect width="512" height="512" fill="#ffffff"/>` +
  `<g transform="translate(256,256)">` +
  `<path d="M 0,-140 C 77,-140 140,-77 140,0 C 140,77 77,140 0,140 C -30,140 -58,131 -82,116 C -95,124 -118,132 -135,134 C -128,124 -120,110 -116,96 C -132,76 -140,40 -140,0 C -140,-77 -77,-140 0,-140 Z" fill="url(#b)"/>` +
  `<path d="M -26,-42 L 50,0 L -26,42 Z" fill="#ffffff"/>` +
  `</g></svg>`;

function bearer(): string {
  if (!env.LINQ_API_KEY) throw new Error("LINQ_API_KEY not set");
  return `Bearer ${env.LINQ_API_KEY}`;
}

async function uploadLogo(): Promise<string | null> {
  if (!env.R2_BUCKET) return null;
  const png = await sharp(Buffer.from(LOGO_SVG)).png().toBuffer();
  await new Upload({
    client: getR2Client(),
    params: { Bucket: getR2Bucket(), Key: LOGO_R2_KEY, Body: png, ContentType: "image/png" },
  }).done();
  return r2PublicUrl(LOGO_R2_KEY);
}

// Ensures the contact card for our Linq number is configured (name + logo) so
// opted-in users can save us with a real name instead of a phone number.
// Idempotent: POSTs to create, falls back to PATCH if a card already exists.
// Failures are logged, not thrown — the contact card is a nice-to-have.
export async function setupContactCard(): Promise<void> {
  if (!env.LINQ_NUMBER || !env.LINQ_API_KEY) {
    logger.info("contact card: LINQ_NUMBER or LINQ_API_KEY not set, skipping setup");
    return;
  }
  try {
    const imageUrl = await uploadLogo();
    const body = JSON.stringify({
      phone_number: env.LINQ_NUMBER,
      first_name: CARD_FIRST_NAME,
      last_name: CARD_LAST_NAME,
      ...(imageUrl ? { image_url: imageUrl } : {}),
    });
    const headers = { "Content-Type": "application/json", Authorization: bearer() };
    let res = await fetch(`${LINQ_BASE}/contact_card`, { method: "POST", headers, body });
    if (!res.ok) {
      // Most likely a card already exists for this number — update it instead.
      res = await fetch(`${LINQ_BASE}/contact_card`, { method: "PATCH", headers, body });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: t.slice(0, 300) }, "contact card setup failed");
      return;
    }
    logger.info(
      { name: `${CARD_FIRST_NAME} ${CARD_LAST_NAME}`, imageUrl },
      "contact card configured",
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "contact card setup threw",
    );
  }
}
