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

// Jamendo genre + mood/theme tags that we've verified return instrumental
// results. The matcher picks up to 3; the resolver queries Jamendo's `tags`
// filter with them (much sharper than free-text search).
export const JAMENDO_TAGS = [
  // genres
  "pop", "rock", "electronic", "hiphop", "classical", "jazz", "lounge",
  "soundtrack", "ambient", "chillout", "dance", "funk", "folk", "world", "metal",
  // moods
  "happy", "sad", "relaxing", "energetic", "dark", "nostalgic", "mysterious",
  "dramatic", "uplifting", "cinematic", "epic", "motivational", "corporate",
  "romantic", "love", "groovy", "calm", "aggressive",
  // occasions / seasons
  "christmas", "halloween", "summer", "party",
] as const;
export type JamendoTag = (typeof JAMENDO_TAGS)[number];

export const MusicSpec = z.object({
  tags: z.array(z.enum(JAMENDO_TAGS)).max(3), // 0-3 Jamendo tags
  freetext: z.string(), // backup free-text query (can be ""), e.g. "jingle bells instrumental"
  tempo: z.enum(["slow", "medium", "fast", "any"]),
  acoustic_or_electric: z.enum(["acoustic", "electric", "any"]),
});
export type MusicSpec = z.infer<typeof MusicSpec>;

export const TRANSITION_IDS = ["cut", "fade", "zoom", "slide", "carousel", "wipe"] as const;
export type TransitionId = (typeof TRANSITION_IDS)[number];

// Slow camera move applied across each clip ("Ken Burns").
export const MOTION_IDS = ["none", "zoom", "pan"] as const;
export type MotionId = (typeof MOTION_IDS)[number];

export const TextOverlay = z.object({
  text: z.string().max(80),
  position: z.enum(["top", "center", "bottom"]),
  color: z.string(), // hex like "#ffffff" or a CSS color name; sanitized at render
  uppercase: z.boolean(),
  // "none", or a hex/CSS color — when a color, the text sits on a rounded pill of that color.
  background: z.string(),
});
export type TextOverlay = z.infer<typeof TextOverlay>;

export const PACE_IDS = ["very_fast", "fast", "medium", "slow", "very_slow"] as const;
export type PaceId = (typeof PACE_IDS)[number];

export const EditPlan = z.object({
  // A short, casual confirmation of what's being made — texted to the user
  // (gen-z styled, no dashes/emoji) and logged. e.g. "doing a hype gym edit w bold text"
  confirmation: z.string(),
  needs_clarification: z.boolean(),
  // If needs_clarification: one short casual question (gen-z styled). Else "".
  clarification_question: z.string(),
  // The edit (meaningful only when needs_clarification is false):
  style: z.enum(STYLE_IDS),
  music: MusicSpec,
  keep_original_audio: z.boolean(),
  // Cuts-per-minute feel for multi-clip montages — maps to a per-clip duration
  // (very_fast ≈ 1s … very_slow ≈ 6.5s). Ignored for single-clip edits, where
  // `speed` does the pacing instead.
  pace: z.enum(PACE_IDS),
  speed: z.enum(["slow", "normal", "fast"]), // "slow" ≈ 0.5x; only applied to single-clip edits
  color_filter: z.enum(["none", "vibrant", "muted", "bw", "dramatic"]),
  transition: z.enum(TRANSITION_IDS), // between clips; multi-clip only
  motion: z.enum(MOTION_IDS), // slow Ken-Burns move on the clips
  text_overlays: z.array(TextOverlay),
});
export type EditPlan = z.infer<typeof EditPlan>;
