import crypto from "node:crypto";

// Linq webhook signature verification.
// Algorithm: HMAC-SHA256 hex over `{timestamp}.{raw_body}`.
// Headers (lowercased by Express): x-linq-signature, x-linq-timestamp.
// Falls back to x-webhook-* in case Linq uses that naming.

const SIGNATURE_HEADERS = ["x-linq-signature", "x-webhook-signature"];
const TIMESTAMP_HEADERS = ["x-linq-timestamp", "x-webhook-timestamp"];
const MAX_AGE_SECONDS = 5 * 60;

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  candidates: string[],
): string | undefined {
  for (const name of candidates) {
    const v = headers[name];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return undefined;
}

export function verifyLinqSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): SignatureVerifyResult {
  const sig = pickHeader(headers, SIGNATURE_HEADERS);
  const ts = pickHeader(headers, TIMESTAMP_HEADERS);

  if (!sig) return { ok: false, reason: "missing signature header" };
  if (!ts) return { ok: false, reason: "missing timestamp header" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "timestamp not numeric" };
  }
  const ageSec = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSec > MAX_AGE_SECONDS) {
    return { ok: false, reason: `timestamp too old (${Math.round(ageSec)}s)` };
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(ts);
  hmac.update(".");
  hmac.update(rawBody);
  const expected = hmac.digest("hex");

  if (sig.length !== expected.length) {
    return { ok: false, reason: "signature length mismatch" };
  }
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "signature mismatch" };
    }
  } catch {
    return { ok: false, reason: "signature not hex" };
  }
  return { ok: true };
}
