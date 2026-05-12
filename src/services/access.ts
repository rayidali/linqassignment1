import { prisma } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { sendTextReply, shareContactCard } from "./linq.js";

const DAILY_VIDEO_LIMIT_PER_SENDER = 50;
const MIN_SECONDS_BETWEEN_VIDEOS = 60;
const DAILY_SYSTEM_VIDEO_BUDGET = 200;

const OPT_IN_WORDS = new Set([
  "ok", "okay", "yes", "y", "yeah", "yep", "yup", "sure", "start", "go", "let's go", "lets go",
]);

const MSG = {
  optInPrompt:
    `yo this is an AI video editor demo. u send video clips or pics + a caption like "hype gym edit" ` +
    `and i text back a short edited video with music, text, transitions, the works. reply OK to start`,
  welcome:
    `u good. quick rundown so u know what im about:\n\n` +
    `im an AI video editor. send me video clips and or photos (1 or more, any mix) with a caption of the vibe u want, ` +
    `and i text u back a finished short edit with music, text overlays, color, transitions, all of it.\n\n` +
    `captions that work great:\n` +
    `hype gym edit with big bold text\n` +
    `chill summer recap, slow mo and cinematic\n` +
    `make it sad with emotional piano\n` +
    `christmas edit (i grab festive music + festive text)\n` +
    `funny edit of my dog\n\n` +
    `stuff i can do: pick a style (hype, sad, chill, funny, cinematic), match music to the mood, ` +
    `add text overlays, slow mo, color filters (vibrant, black and white, dramatic), transitions between clips\n\n` +
    `what happens after u send: i say "got it" right away, then i tell u what im making + a rough wait, ` +
    `then a couple mins later the video lands. if ur caption is too vague to nail it ill ask u one quick question first.\n\n` +
    `u can also just text me normally anytime (hows my video, what styles do u have, etc).\n\n` +
    `whenever ur ready, send some clips + a caption`,
  perMinute: "hold up lemme finish the last one, hit me again in a min",
  perDay: `u maxed out today (${DAILY_VIDEO_LIMIT_PER_SENDER} edits). hit me up tomorrow`,
  systemBudget: "the demo's at capacity for today, try again tomorrow",
};

export type AccessResult = { allow: true } | { allow: false; reason: string };

function allowlistSet(): Set<string> {
  return new Set(
    (env.ACCESS_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Gates inbound messages: first-use opt-in for new senders, per-sender video
// rate limits (50/day, 1/min — allowlisted handles skip the per-minute one),
// and a system-wide daily video budget. Sends any user-facing reply itself
// (opt-in prompt, welcome, limit messages) and returns whether the caller
// should proceed to create a Job.
export async function checkAccess(opts: {
  chatId: string;
  handle: string | null;
  service: string | null;
  isMediaMessage: boolean;
  messageText: string;
  eventId: string;
}): Promise<AccessResult> {
  const { chatId, handle, service, isMediaMessage, messageText, eventId } = opts;
  const log = logger.child({ handle, chatId });

  // No handle to track on — process the message but skip access control.
  if (!handle) {
    return { allow: true };
  }

  const isAllowlisted = allowlistSet().has(handle);

  let sender = await prisma.sender.findUnique({ where: { handle } });
  if (!sender) {
    sender = await prisma.sender.create({
      data: {
        handle,
        service: service ?? null,
        status: isAllowlisted ? "opted_in" : "pending_opt_in",
        optedInAt: isAllowlisted ? new Date() : null,
      },
    });
    log.info({ status: sender.status, isAllowlisted }, "new sender created");
  }

  if (sender.status === "blocked") {
    log.warn("blocked sender, ignoring message");
    return { allow: false, reason: "sender blocked" };
  }

  if (sender.status === "pending_opt_in") {
    const text = messageText.toLowerCase().trim();
    if (OPT_IN_WORDS.has(text)) {
      await prisma.sender.update({
        where: { id: sender.id },
        data: { status: "opted_in", optedInAt: new Date() },
      });
      await sendTextReply(chatId, MSG.welcome, eventId);
      // Offer an "Add to Contacts" card so the thread shows our name. Best-effort.
      void shareContactCard(chatId).catch((e) =>
        log.warn({ err: e instanceof Error ? e.message : String(e) }, "share contact card failed"),
      );
      log.info("sender opted in");
      return { allow: false, reason: "just opted in" };
    }
    await sendTextReply(chatId, MSG.optInPrompt, eventId);
    log.info("sent opt-in prompt");
    return { allow: false, reason: "awaiting opt-in" };
  }

  // Opted in. Rate limits + budget apply to video requests only (chat is cheap).
  if (!isMediaMessage) {
    return { allow: true };
  }

  const now = Date.now();
  if (
    !isAllowlisted &&
    sender.lastVideoAt &&
    now - sender.lastVideoAt.getTime() < MIN_SECONDS_BETWEEN_VIDEOS * 1000
  ) {
    await sendTextReply(chatId, MSG.perMinute, eventId);
    return { allow: false, reason: "per-minute rate limit" };
  }

  const today = todayUTC();
  const videosToday = sender.videosTodayDate === today ? sender.videosToday : 0;
  if (videosToday >= DAILY_VIDEO_LIMIT_PER_SENDER) {
    await sendTextReply(chatId, MSG.perDay, eventId);
    return { allow: false, reason: "per-sender daily limit" };
  }

  const systemToday = await prisma.job.count({
    where: { type: "video", createdAt: { gte: startOfTodayUTC() } },
  });
  if (systemToday >= DAILY_SYSTEM_VIDEO_BUDGET) {
    await sendTextReply(chatId, MSG.systemBudget, eventId);
    return { allow: false, reason: "system daily budget" };
  }

  await prisma.sender.update({
    where: { id: sender.id },
    data: {
      lastVideoAt: new Date(),
      videosToday: videosToday + 1,
      videosTodayDate: today,
      totalVideos: { increment: 1 },
    },
  });
  return { allow: true };
}
