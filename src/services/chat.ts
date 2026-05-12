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

// Voice rules for ALL user-facing text (chatbot now; the mastermind matcher's
// messages later). Casual, sounds like a real person texting, never like an AI.
const STYLE_RULES = `how you write (strict):
- sound like a real gen z person texting a friend, NOT like an AI assistant or customer service bot
- NO dashes of any kind. no "—", no "–", no "-" used as punctuation
- NO emojis at all
- keep it short, usually one or two lines. lowercase is fine. contractions and light slang (u, rn, tbh, ngl, lowkey, fr) are good but don't overdo it or be cringe
- no markdown, no bullet points, no headers, no formal structure. it's a text message
- no sign-offs, no "let me know if you need anything else", no "feel free to" type filler`;

const SYSTEM = `you run an AI video editor over text. people send u video clips or photos plus a caption of the vibe they want, and u send back a tiktok style edit (hype montages, sad/emotional, aesthetic chill, funny/meme cuts, stitched clips, text overlays, matches the source orientation).

right now ur just texting with someone (they sent text, no media).

${STYLE_RULES}

what to actually say:
- if they ask what u do: tell them quick and say to send a video or photo with a caption of the vibe
- if they go off topic: vibe with it for a sec then bring it back to video editing
- if theres an edit in progress for them (u'll be told): let them know its cooking, usually takes about a min
- if they ask u to change an edit thats already rendering: tell them u cant change that one now but they can resend with new instructions once its done`;

// Belt-and-suspenders: strip em/en dashes and emoji even if the model slips.
function scrubStyle(text: string): string {
  return text
    .replace(/[—–]/g, ", ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

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
    system: `${SYSTEM}\n\ncontext for this reply: ${renderNote}`,
    messages,
  });

  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text.trim() : "";
  if (!raw) {
    throw new Error("Anthropic chat response had no text content");
  }
  const reply = scrubStyle(raw);
  log.info({ replyPreview: reply.slice(0, 80) }, "chat reply generated");
  return reply || "ngl my brain glitched, say that again?";
}
