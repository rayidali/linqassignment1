import { z } from "zod";

const TextPart = z.object({
  type: z.literal("text"),
  value: z.string(),
});

const MediaPart = z.object({
  type: z.literal("media"),
  id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  url: z.string().url(),
});

const Part = z.discriminatedUnion("type", [TextPart, MediaPart]);

export const LinqWebhookPayload = z.object({
  event_id: z.string(),
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    chat: z.object({ id: z.string() }),
    sender_handle: z
      .object({
        id: z.string().optional(),
        handle: z.string(),
        service: z.string(),
      })
      .optional(),
    parts: z.array(Part).min(1),
  }),
});

export type LinqWebhookPayload = z.infer<typeof LinqWebhookPayload>;

// What the "mastermind" matcher produces from the user's full request. The
// renderer (src/templates/index.ts buildEdit) translates it to Shotstack JSON.
export const STYLE_IDS = ["hype", "sad", "chill", "funny", "cinematic"] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const TextOverlay = z.object({
  text: z.string().max(80),
  position: z.enum(["top", "center", "bottom"]),
  color: z.string(), // hex like "#ffffff" or a CSS color name; sanitized at render
  uppercase: z.boolean(),
});
export type TextOverlay = z.infer<typeof TextOverlay>;

export const EditPlan = z.object({
  // A short, casual confirmation of what's being made — texted to the user
  // (gen-z styled, no dashes/emoji) and logged. e.g. "doing a hype gym edit w bold text"
  confirmation: z.string(),
  needs_clarification: z.boolean(),
  // If needs_clarification: one short casual question (gen-z styled). Else "".
  clarification_question: z.string(),
  // The edit (meaningful only when needs_clarification is false):
  style: z.enum(STYLE_IDS),
  // Jamendo search query — always set (derived from the request, theme, or style).
  music_query: z.string(),
  keep_original_audio: z.boolean(),
  speed: z.enum(["slow", "normal", "fast"]), // "slow" ≈ 0.5x; only applied to single-clip edits
  color_filter: z.enum(["none", "vibrant", "muted", "bw", "dramatic"]),
  transition: z.enum(["cut", "fade", "zoom"]), // between clips; multi-clip only
  text_overlays: z.array(TextOverlay),
});
export type EditPlan = z.infer<typeof EditPlan>;
