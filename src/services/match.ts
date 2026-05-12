import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper internally uses zod/v4 (zod 3.25+ ships both APIs).
// Importing from "zod/v4" here matches what zodOutputFormat expects — using
// the default "zod" path gives the v3 API and the helper crashes with
// "Cannot read properties of undefined (reading 'def')" on .toJSONSchema.
import { z } from "zod/v4";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  TEMPLATES,
  ALL_TEMPLATE_IDS,
  ALL_MUSIC_IDS,
} from "../templates/index.js";
import type { TemplateChoice } from "../schemas.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `You are a video editing assistant for a TikTok-style video editor. The user texted a short video clip (or photo) with an optional caption. Pick the template whose description best matches the mood of the caption, pick a music track from that template's music_options, decide if the user requested specific music, and write text overlays.

Rules:
- music_id MUST come from the chosen template's music_options. Never mix.
- requested_music_query: if the user explicitly asks for music (a specific song, artist, genre, or vibe like "upbeat", "lofi", "sad piano", "use Hot in Herre by Nelly"), put a SHORT search query here that captures the genre/mood — we only have royalty-free music, so famous songs aren't available; distill "use Hot in Herre by Nelly" to e.g. "upbeat 2000s hip hop instrumental". Add "instrumental" if it fits. If the user does NOT mention music at all, set requested_music_query to null and the template's default track is used.
- Write text overlays the user would actually want on screen. Each overlay <= 6 words, punchy. Match the count to the chosen template's text_slot_count.
- timestamp is seconds from video start; first overlay at 0.
- clip_order is just ["clip_1"] (single user clip for now).
- If the caption is empty or unclear, default to tmpl_aesthetic_chill — that's the safest match for a generic short clip.`;

// We use a fresh schema (stricter than the one in schemas.ts) to constrain
// the LLM to known template_ids and music_ids via enum. Cross-checked below.
const MatchSchema = z.object({
  template_id: z.enum(ALL_TEMPLATE_IDS as [string, ...string[]]),
  music_id: z.enum(ALL_MUSIC_IDS as [string, ...string[]]),
  requested_music_query: z.string().nullable(),
  clip_order: z.array(z.string()),
  text_overlays: z.array(
    z.object({
      text: z.string().max(80),
      timestamp: z.number().min(0),
    }),
  ),
});

export async function matchTemplate(
  jobId: string,
  prompt: string,
): Promise<TemplateChoice> {
  const log = logger.child({ jobId });
  log.info({ promptLength: prompt.length }, "matching template via Anthropic");

  const templatesContext = TEMPLATES.map((t) => ({
    id: t.id,
    description: t.description,
    music_options: t.music_options.map((m) => ({ id: m.id, description: m.description })),
    text_slot_count: t.text_slot_count,
  }));

  const userMessage = `User caption: ${prompt.trim() || "(none)"}

Available templates (JSON):
${JSON.stringify(templatesContext, null, 2)}`;

  const response = await getClient().messages.parse({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    // Cast: zodOutputFormat's TypeScript types reference zod v3 while its
    // runtime uses zod/v4. Pass our v4 schema through; we re-parse below for
    // type safety since parsed_output ends up as `any`.
    output_config: { format: zodOutputFormat(MatchSchema as never) },
  });

  if (!response.parsed_output) {
    throw new Error("Anthropic response missing parsed_output");
  }
  const choice = MatchSchema.parse(response.parsed_output);

  // Cross-check music belongs to the chosen template — the global enum lets
  // the LLM pick any music_id, but we want music tied to template choice.
  const tpl = TEMPLATES.find((t) => t.id === choice.template_id);
  if (!tpl) {
    throw new Error(`LLM picked unknown template_id: ${choice.template_id}`);
  }
  if (!tpl.music_options.some((m) => m.id === choice.music_id)) {
    log.warn(
      {
        template: choice.template_id,
        chosenMusic: choice.music_id,
        validForTemplate: tpl.music_options.map((m) => m.id),
      },
      "music_id not in chosen template's options — patching to first option",
    );
    choice.music_id = tpl.music_options[0]!.id;
  }

  log.info(
    {
      template: choice.template_id,
      music: choice.music_id,
      requestedMusic: choice.requested_music_query,
      overlayCount: choice.text_overlays.length,
    },
    "template matched",
  );

  return choice as TemplateChoice;
}
