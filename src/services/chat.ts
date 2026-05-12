import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { LinqWebhookPayload } from "../schemas.js";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `You are an AI video editor that works over iMessage. Users text you one or more short video clips (or photos) plus a caption describing the vibe they want, and you reply with a TikTok-style edited video — hype montages, emotional edits, chill/aesthetic, funny/meme cuts. You can stitch multiple clips, overlay text, and match the output to the source orientation.

You are CHATTING with a user right now (they sent a text-only message, not media). Respond like a text message: friendly, concise (1–3 short sentences), casual, emoji ok.

- If they ask what you can do: explain briefly and tell them to send a video/photo with a caption.
- If they're off-topic: gently steer back to video editing.
- If there's an edit in progress for this user (you'll be told): share the status. You can't change an edit that's already rendering — tell them to send a new message after it finishes if they want changes.
- Don't be verbose. No markdown, no bullet lists — this is SMS.`;

type HistoryTurn = { role: "user" | "assistant"; content: string };

async function loadContext(jobId: string, chatId: string): Promise<{
  history: HistoryTurn[];
  renderNote: string;
}> {
  // Recent replied chat turns for this chat.
  const pastChats = await prisma.job.findMany({
    where: { chatId, type: "chat", state: "replied", NOT: { id: jobId } },
    orderBy: { createdAt: "asc" },
    take: 12,
  });
  const history: HistoryTurn[] = [];
  for (const j of pastChats) {
    const payload = j.payload as LinqWebhookPayload;
    const userText = payload.data.parts.find((p) => p.type === "text")?.value ?? "";
    const reply = (j.result as { reply?: string } | null)?.reply ?? "";
    if (userText) history.push({ role: "user", content: userText });
    if (reply) history.push({ role: "assistant", content: reply });
  }

  // Most recent video edit for this chat, whatever its state.
  const lastVideo = await prisma.job.findFirst({
    where: { chatId, type: "video" },
    orderBy: { createdAt: "desc" },
  });
  let renderNote = "No video edit has been requested by this user yet.";
  if (lastVideo) {
    const payload = lastVideo.payload as LinqWebhookPayload;
    const caption = payload.data.parts.find((p) => p.type === "text")?.value ?? "(no caption)";
    const stateLabel: Record<string, string> = {
      received: "queued",
      downloaded: "preparing the clips",
      matched: "rendering",
      submitted: "rendering on the video service",
      rendered: "almost done — sending it back",
      uploaded: "almost done — sending it back",
      delivered: "delivered",
      failed: "failed",
    };
    const label = stateLabel[lastVideo.state] ?? lastVideo.state;
    const inProgress = !["delivered", "failed"].includes(lastVideo.state);
    renderNote = inProgress
      ? `There IS an edit in progress for this user right now (caption: "${caption}") — status: ${label}. It usually takes about a minute.`
      : `The user's most recent edit (caption: "${caption}") is ${label}.`;
  }

  return { history, renderNote };
}

// Generates the chatbot's reply to a text-only message. Does NOT send it —
// the caller (state machine) sends via sendTextReply and persists.
export async function generateReply(
  jobId: string,
  chatId: string,
  userText: string,
): Promise<string> {
  const log = logger.child({ jobId, chatId });
  const { history, renderNote } = await loadContext(jobId, chatId);
  log.info({ historyTurns: history.length }, "generating chat reply");

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userText },
  ];

  const response = await getClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: `${SYSTEM}\n\nCurrent context: ${renderNote}`,
    messages,
  });

  const block = response.content.find((b) => b.type === "text");
  const reply = block && block.type === "text" ? block.text.trim() : "";
  if (!reply) {
    throw new Error("Anthropic chat response had no text content");
  }
  log.info({ replyPreview: reply.slice(0, 80) }, "chat reply generated");
  return reply;
}
