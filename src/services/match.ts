import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper internally uses zod/v4 (zod 3.25+ ships both APIs);
// importing from "zod/v4" matches what zodOutputFormat expects.
import { z } from "zod/v4";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { scrubStyle } from "./chat.js";
import { EditPlan as EditPlanSchema, STYLE_IDS } from "../schemas.js";
import type { EditPlan } from "../schemas.js";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

// zod/v4 mirror of EditPlan (schemas.ts uses zod v3). Structurally identical.
const PlanSchema = z.object({
  confirmation: z.string(),
  needs_clarification: z.boolean(),
  clarification_question: z.string(),
  style: z.enum([...STYLE_IDS] as [string, ...string[]]),
  music_query: z.string(),
  keep_original_audio: z.boolean(),
  speed: z.enum(["slow", "normal", "fast"]),
  color_filter: z.enum(["none", "vibrant", "muted", "bw", "dramatic"]),
  transition: z.enum(["cut", "fade", "zoom"]),
  text_overlays: z.array(
    z.object({
      text: z.string().max(80),
      position: z.enum(["top", "center", "bottom"]),
      color: z.string(),
      uppercase: z.boolean(),
    }),
  ),
});

const SYSTEM = `You are the brain of an AI video editor that works over iMessage. A user sent some video clips (or photos) and a caption describing what they want. Understand their FULL request and produce an edit plan the renderer turns into a TikTok-style video.

GUIDING PRINCIPLE: be SMART about what a request implies thematically (a "christmas edit" obviously means christmas music + maybe festive text; "birthday" means a happy-birthday vibe), but be CONSERVATIVE about stylistic choices the user didn't actually ask for. Don't add fade transitions, color filters, or slow motion on your own — leave those at the defaults unless the user's wording clearly calls for them. Clean hard cuts and no filter is the right baseline.

Output JSON with these fields:

- confirmation: a SHORT casual confirmation of what you're making, texted back to the user. Sound like a real gen-z person texting (lowercase ok, contractions, light slang). NO dashes ("—", "–", or "-" used as punctuation). NO emojis. No "Got it," / "I'll" / sign-offs. e.g. "doing a hype gym edit with bold text" or "k making this a sad emotional one w that piano vibe".
- needs_clarification: true ONLY if the request is genuinely too vague to make a reasonable edit (no caption at all, or just "edit this" with zero direction). Most requests are clear enough. DON'T over-ask. When in doubt, just make a good edit.
- clarification_question: if needs_clarification, ONE short casual question (same gen-z style, no dashes/emoji). Else "". e.g. "what vibe u going for? hype, chill, sad, funny, or smth specific?"
- style: "hype" (fast cuts, energetic, sports/gym/party/dance), "sad" (slow, emotional, melancholy, missing-someone), "chill" (aesthetic, dreamy, lifestyle, travel, sunsets, vibey), "funny" (snappy comedic, meme), or "cinematic" (slow, dramatic, epic, moody, film-like). Pick the closest. If the caption is empty, default to "chill".
- music_query: ALWAYS set this — a short search query for a ROYALTY-FREE instrumental track. We do NOT have copyrighted/famous music (no John Williams film scores, no Top-40 hits), so:
  * For a theme/occasion with iconic PUBLIC-DOMAIN music, name the actual song(s): "christmas edit" -> "jingle bells instrumental" or "we wish you a merry christmas instrumental" or "deck the halls instrumental"; "wedding" -> "canon in d wedding instrumental" or "wedding march instrumental"; "graduation" -> "pomp and circumstance instrumental".
  * For a request that names a copyrighted song/artist, distill it to a genre/mood: "use Hot in Herre by Nelly" -> "upbeat 2000s hip hop instrumental".
  * For a generic vibe, describe the genre/mood: "upbeat" -> "upbeat energetic instrumental"; "halloween" -> "spooky eerie halloween instrumental"; "workout" -> "high energy gym instrumental".
  * Otherwise, something fitting the style. Always include "instrumental".
- keep_original_audio: true ONLY if the user explicitly asks to keep the original sound ("keep the audio", "don't mute it", "i want them talking"). Otherwise false.
- speed: "normal" by DEFAULT. Only "slow" if the user explicitly wants slow motion / slowed down, "fast" if explicitly sped up. Do not add slow-mo on your own.
- color_filter: "none" by DEFAULT. Only set "bw" (if they say black & white / monochrome), "vibrant" (if they say vibrant/poppy/saturated), "muted" (if they say faded/washed out/vintage/aesthetic), or "dramatic" (if they say moody/dark/dramatic/high contrast). Do not add a filter on your own.
- transition: "cut" by DEFAULT (clean hard cuts — looks best for most edits). Only "fade" if the user asks for smooth/flowy/crossfade transitions, or "zoom" if they ask for punchy/zoom cuts. Do not add fades on your own. (Only matters for multi-clip anyway.)
- text_overlays: the on-screen text. If the user gives exact text ("put 'happy 25th sarah'"), use it verbatim. If a theme, infer it ("birthday edit" -> ["happy birthday"], "christmas" -> ["merry christmas"]). If they want text but didn't say what, write something short fitting the vibe (<= 6 words each). If they clearly don't want text, return []. Usually 1-2 overlays, don't overload. Each overlay: text; position ("top" for a title, "center" for emphasis, "bottom" for a caption); color (a hex like "#ffffff" or a CSS color name — white by default, but theme-fitting like gold "#ffd700" for birthday or red "#c0392b" for christmas, or what the user asks); uppercase (true for bold/hype/funny vibes, false for sad/chill/cinematic — unless the user says otherwise).

Read the whole request. "christmas edit for my family" -> style "chill" or "cinematic", music_query "jingle bells instrumental", color_filter "none" (unless they asked), transition "cut" (unless they asked), text_overlays [{text:"merry christmas",position:"top",color:"#c0392b",uppercase:true}].`;

export async function planEdit(
  jobId: string,
  input: { caption: string; clarificationAnswer?: string; clipCount: number },
): Promise<EditPlan> {
  const log = logger.child({ jobId });
  const { caption, clarificationAnswer, clipCount } = input;
  log.info(
    { captionLen: caption.length, hasClarification: Boolean(clarificationAnswer), clipCount },
    "planning edit via Anthropic",
  );

  const userMessage =
    `The user sent ${clipCount} ${clipCount === 1 ? "clip or photo" : "clips/photos"}.\n` +
    `Caption: ${caption.trim() || "(none)"}` +
    (clarificationAnswer
      ? `\nThe user clarified: ${clarificationAnswer.trim()}\n(You already asked one clarifying question — do NOT ask again, just make your best edit.)`
      : "");

  const response = await getClient().messages.parse({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(PlanSchema as never) },
  });
  if (!response.parsed_output) {
    throw new Error("Anthropic response missing parsed_output");
  }
  const plan = EditPlanSchema.parse(response.parsed_output);

  plan.confirmation = scrubStyle(plan.confirmation) || "on it, making ur edit";
  plan.clarification_question = plan.clarification_question
    ? scrubStyle(plan.clarification_question)
    : "";

  log.info(
    {
      needsClarification: plan.needs_clarification,
      style: plan.style,
      musicQuery: plan.music_query,
      transition: plan.transition,
      colorFilter: plan.color_filter,
      speed: plan.speed,
      keepAudio: plan.keep_original_audio,
      overlays: plan.text_overlays.length,
    },
    "edit planned",
  );
  return plan;
}
