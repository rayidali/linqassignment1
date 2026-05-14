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

// Visual hierarchy role. Drives the FONT-SIZE multiplier on top of `size`;
// also tells the renderer how to compose multi-line title blocks (a "hero"
// with a "subtitle" at the same position get stacked as a unit). One hero
// per edit is the norm.
export const OVERLAY_ROLE_IDS = ["hero", "subtitle", "body", "caption"] as const;
export type OverlayRoleId = (typeof OVERLAY_ROLE_IDS)[number];

// How a text overlay enters and leaves. Supports the full Shotstack transition
// vocabulary so the matcher can compose recap-reel choreography
// (in: slide_up, out: carousel_left). Both fields are required; the matcher
// sets them per overlay (and the renderer takes the first overlay's pair as
// the group's transition when overlays are stacked).
export const OVERLAY_TRANSITION_IDS = [
  "none",
  "fade",
  "slide_up", "slide_down", "slide_left", "slide_right",
  "carousel_up", "carousel_down", "carousel_left", "carousel_right",
  "zoom",
] as const;
export type OverlayTransitionId = (typeof OVERLAY_TRANSITION_IDS)[number];

// Overlay typeface — a small palette (we can't host every licensed font, so
// the matcher maps a request to the nearest of these). Each → a real CDN font.
export const OVERLAY_FONT_IDS = ["bold_sans", "condensed", "serif", "handwritten", "rounded"] as const;
export type OverlayFontId = (typeof OVERLAY_FONT_IDS)[number];
export const OVERLAY_SIZE_IDS = ["small", "medium", "large"] as const;
export type OverlaySizeId = (typeof OVERLAY_SIZE_IDS)[number];
// Text outline: "none" = soft drop-shadow (default), "dark"/"light" = a stroke.
export const OVERLAY_OUTLINE_IDS = ["none", "dark", "light"] as const;
export type OverlayOutlineId = (typeof OVERLAY_OUTLINE_IDS)[number];
// Letter case applied at render. "as_written" leaves the matcher's text alone.
export const OVERLAY_CASE_IDS = ["as_written", "uppercase", "lowercase"] as const;
export type OverlayCaseId = (typeof OVERLAY_CASE_IDS)[number];

export const TextOverlay = z.object({
  text: z.string().max(80),
  position: z.enum(["top", "center", "bottom"]),
  color: z.string(), // hex like "#ffffff" or a CSS color name; sanitized at render
  // Visual hierarchy. Drives a strong size multiplier (hero ~2.6×, subtitle 1×,
  // body 0.55×, caption 0.4×) AND tells the renderer how to stack overlays:
  // consecutive overlays at the same `position` are composed into one HTML
  // block (hero + subtitle as a designed unit). Match a typographic role to
  // the text's intent: one hero per edit, optional subtitle below it.
  role: z.enum(OVERLAY_ROLE_IDS),
  // Letter case: "as_written" keeps the text as typed; "uppercase"/"lowercase"
  // force it. User can ask: "make the text all caps", "lowercase title", etc.
  case_style: z.enum(OVERLAY_CASE_IDS),
  // "none", or a hex/CSS color — when a color, the text sits on a rounded pill of that color.
  background: z.string(),
  // Entrance and exit transitions, set separately so the matcher can compose
  // looks like (in: slide_up, out: carousel_left) — the recap-reel choreography.
  // Within a stacked group the group as a whole inherits the FIRST overlay's
  // pair (the hero's), since the whole block enters/exits together.
  animation_in: z.enum(OVERLAY_TRANSITION_IDS),
  animation_out: z.enum(OVERLAY_TRANSITION_IDS),
  // How long the overlay stays on screen, in seconds. null = full video.
  // Use a number when the user asks for a specific window ("show the title for
  // 2 seconds", "intro card 3 sec"). 0 < n ≤ 60. Within a stacked group, null
  // wins over any number (the group holds for the full video).
  duration_seconds: z.number().positive().max(60).nullable(),
  // A specific open-license / Google Fonts family name (e.g. "Bebas Neue"), or
  // "" to just use the `font` category. Resolved via @fontsource at render;
  // falls back to `font` then a bold-sans stack if the name doesn't resolve.
  font_name: z.string().max(50),
  font: z.enum(OVERLAY_FONT_IDS), // fallback category (also used for vibe-only requests)
  size: z.enum(OVERLAY_SIZE_IDS), // fine-tune on top of role's multiplier
  outline: z.enum(OVERLAY_OUTLINE_IDS),
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
