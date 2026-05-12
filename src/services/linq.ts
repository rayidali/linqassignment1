import { env } from "../env.js";
import { logger } from "../logger.js";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "../http.js";

const LINQ_BASE = "https://api.linqapp.com/api/partner/v3";

function bearer(): string {
  if (!env.LINQ_API_KEY) throw new Error("LINQ_API_KEY not set");
  return `Bearer ${env.LINQ_API_KEY}`;
}

type CreateAttachmentResponse = {
  attachment_id: string;
  upload_url: string;
  http_method?: string;
  expires_at?: string;
  required_headers?: Record<string, string>;
};

// Two-step flow: POST /v3/attachments returns a presigned upload URL +
// attachment_id; we then PUT the bytes to that URL. The attachment_id is what
// we pass to send-message later.
export async function uploadAttachment(
  jobId: string,
  sourceUrl: string,
  filename: string,
): Promise<string> {
  const log = logger.child({ jobId });

  log.info({ sourceUrl }, "fetching render output for re-upload");
  const fetchRes = await fetchWithTimeout(sourceUrl, {}, MEDIA_TIMEOUT_MS);
  if (!fetchRes.ok || !fetchRes.body) {
    throw new Error(
      `fetch render output failed: ${fetchRes.status} ${fetchRes.statusText}`,
    );
  }
  const contentType = fetchRes.headers.get("content-type") ?? "video/mp4";
  const buffer = Buffer.from(await fetchRes.arrayBuffer());
  const sizeBytes = buffer.length;
  log.info({ sizeBytes, contentType }, "render output downloaded into memory");

  // Step 1: POST /v3/attachments — request a presigned upload URL.
  const createRes = await fetchWithTimeout(`${LINQ_BASE}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify({
      filename,
      content_type: contentType,
      size_bytes: sizeBytes,
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Linq attachment create failed: ${createRes.status} ${body}`);
  }
  const created = (await createRes.json()) as CreateAttachmentResponse;
  log.info({ attachmentId: created.attachment_id }, "Linq attachment slot created");

  // Step 2: PUT bytes to the presigned URL.
  const method = (created.http_method ?? "PUT").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...(created.required_headers ?? {}),
  };
  const uploadRes = await fetchWithTimeout(created.upload_url, {
    method,
    headers,
    body: buffer,
  }, MEDIA_TIMEOUT_MS);
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new Error(`Linq attachment upload failed: ${uploadRes.status} ${body}`);
  }
  log.info({ attachmentId: created.attachment_id }, "Linq attachment uploaded");

  return created.attachment_id;
}

// Send the rendered video back to a chat, optionally with a short text caption
// in the same message.
export async function sendVideoReply(
  jobId: string,
  chatId: string,
  attachmentId: string,
  caption?: string,
): Promise<void> {
  const log = logger.child({ jobId, chatId });
  const parts: Array<Record<string, unknown>> = [];
  if (caption && caption.trim()) parts.push({ type: "text", value: caption.trim() });
  parts.push({ type: "media", attachment_id: attachmentId });
  const res = await fetchWithTimeout(`${LINQ_BASE}/chats/${chatId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify({
      message: {
        parts,
        idempotency_key: jobId,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linq send video reply failed: ${res.status} ${body}`);
  }
  log.info({ attachmentId }, "Linq video reply sent");
}

// Send a text-only reply (used by the chatbot mode in slice 4d).
export async function sendTextReply(
  chatId: string,
  text: string,
  idempotencyKey: string,
): Promise<void> {
  const res = await fetchWithTimeout(`${LINQ_BASE}/chats/${chatId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify({
      message: {
        parts: [{ type: "text", value: text }],
        idempotency_key: idempotencyKey,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linq send text reply failed: ${res.status} ${body}`);
  }
  logger.info({ chatId, textPreview: text.slice(0, 60) }, "Linq text reply sent");
}

// Shares the partner's configured contact card (see services/contact-card.ts)
// into a chat — an Apple-native "Add to Contacts" card so the user can save us
// with a name instead of a bare phone number.
export async function shareContactCard(chatId: string): Promise<void> {
  const res = await fetchWithTimeout(`${LINQ_BASE}/chats/${chatId}/share_contact_card`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify(env.LINQ_NUMBER ? { phone_number: env.LINQ_NUMBER } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linq share contact card failed: ${res.status} ${body}`);
  }
  logger.info({ chatId }, "shared contact card");
}
