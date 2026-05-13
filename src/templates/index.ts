import type { EditPlan, StyleId, PaceId, TextOverlay, MusicSpec } from "../schemas.js";

// "Style presets" provide the rendering scaffold for each base style: the
// overlay font size relative to the frame, and a fallback music spec used if
// the plan's music is empty. Pacing (clip duration) is a separate plan field
// (`pace`) the matcher sets directly — see PACE_TO_CLIP_SECONDS below.
type StylePreset = {
  fontScale: number; // × min(frameW, frameH)
  fallbackMusic: MusicSpec;
};

export const STYLE_PRESETS: Record<StyleId, StylePreset> = {
  hype: {
    fontScale: 0.085,
    fallbackMusic: { tags: ["rock", "energetic", "motivational"], freetext: "high energy workout rock", tempo: "fast", acoustic_or_electric: "electric" },
  },
  sad: {
    fontScale: 0.05,
    fallbackMusic: { tags: ["sad", "classical"], freetext: "emotional piano", tempo: "slow", acoustic_or_electric: "acoustic" },
  },
  chill: {
    fontScale: 0.045,
    fallbackMusic: { tags: ["chillout", "lounge"], freetext: "mellow lofi chill beats", tempo: "medium", acoustic_or_electric: "any" },
  },
  funny: {
    fontScale: 0.08,
    fallbackMusic: { tags: ["happy", "groovy"], freetext: "quirky playful upbeat", tempo: "medium", acoustic_or_electric: "any" },
  },
  cinematic: {
    fontScale: 0.04,
    fallbackMusic: { tags: ["cinematic", "epic", "soundtrack"], freetext: "cinematic epic orchestral", tempo: "medium", acoustic_or_electric: "any" },
  },
};

// `pace` → seconds each clip plays in a multi-clip montage. Single-clip edits
// ignore this (the clip plays its full length, optionally re-timed by `speed`).
export const PACE_TO_CLIP_SECONDS: Record<PaceId, number> = {
  very_fast: 1.0,
  fast: 1.7,
  medium: 2.8,
  slow: 4.5,
  very_slow: 6.5,
};

// Loose Shotstack edit type. See https://shotstack.io/docs/api/
export type ShotstackEdit = {
  timeline: {
    background?: string;
    soundtrack?: { src: string; effect?: string };
    tracks: Array<{
      clips: Array<{
        asset: Record<string, unknown>;
        start: number;
        length: number | "auto" | "end";
        transition?: { in?: string; out?: string };
        effect?: string; // slow camera move across the clip (zoomIn, slideLeft, …)
        position?: string;
        offset?: { x?: number; y?: number };
        fit?: "cover" | "crop" | "contain" | "none";
        filter?: string;
      }>;
    }>;
  };
  output: {
    format: "mp4" | "gif" | "mp3";
    size?: { width: number; height: number };
    fps?: number;
  };
};

export type OutputSize = { width: number; height: number };

const NAMED_COLORS = new Set([
  "white", "black", "red", "blue", "green", "yellow", "gold", "pink",
  "purple", "orange", "cyan", "magenta", "gray", "grey", "silver",
]);
function sanitizeColor(c: string): string {
  const v = (c ?? "").trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  if (NAMED_COLORS.has(v.toLowerCase())) return v.toLowerCase();
  return "#ffffff";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shotstack clip `filter` values: boost, contrast, darken, greyscale, lighten, muted, negative.
function mapColorFilter(f: EditPlan["color_filter"]): string | undefined {
  switch (f) {
    case "vibrant": return "boost";
    case "muted": return "muted";
    case "bw": return "greyscale";
    case "dramatic": return "contrast";
    default: return undefined;
  }
}

// Built-in Shotstack transition names. "carousel" cycles direction per clip
// (the snappy "recap reel" look); the others use one effect for in + out.
const CAROUSEL_DIRS = ["carouselLeft", "carouselRight", "carouselUp", "carouselDown"] as const;
function clipTransition(t: EditPlan["transition"], clipIndex: number): { in?: string; out?: string } | undefined {
  switch (t) {
    case "fade": return { in: "fade", out: "fade" };
    case "zoom": return { in: "zoom", out: "zoom" };
    case "slide": return { in: "slideLeft", out: "slideLeft" };
    case "wipe": return { in: "wipeLeft", out: "wipeLeft" };
    case "carousel": {
      const d = CAROUSEL_DIRS[clipIndex % CAROUSEL_DIRS.length]!;
      return { in: d, out: d };
    }
    default: return undefined; // "cut" → hard cut
  }
}

// Clip `effect` = slow camera move across the clip's duration ("Ken Burns").
const PAN_DIRS = ["slideLeft", "slideRight"] as const;
function clipMotionEffect(m: EditPlan["motion"], clipIndex: number): string | undefined {
  if (m === "zoom") return clipIndex % 2 === 0 ? "zoomIn" : "zoomOut";
  if (m === "pan") return PAN_DIRS[clipIndex % PAN_DIRS.length]!;
  return undefined;
}

function mapSpeed(s: EditPlan["speed"]): number {
  if (s === "slow") return 0.5;
  if (s === "fast") return 1.5;
  return 1.0;
}

function videoTrack(
  clips: string[],
  perClipS: number,
  opts: {
    mute: boolean;
    sourceVolume: number;
    filter?: string;
    speed: number;
    transition: EditPlan["transition"];
    motion: EditPlan["motion"];
  },
): ShotstackEdit["timeline"]["tracks"][number] {
  const single = clips.length === 1;
  return {
    clips: clips.map((url, i) => {
      const asset: Record<string, unknown> = { type: "video", src: url, volume: opts.mute ? 0 : opts.sourceVolume };
      // Speed only applied for single-clip — multi-clip trim math gets fiddly.
      if (single && opts.speed !== 1.0) asset.speed = opts.speed;
      const transition = single ? undefined : clipTransition(opts.transition, i);
      const effect = clipMotionEffect(opts.motion, i); // motion applies to single clips too (a Ken Burns push)
      return {
        asset,
        start: single ? 0 : i * perClipS,
        length: single ? ("auto" as const) : perClipS,
        fit: "crop" as const,
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(transition ? { transition } : {}),
        ...(effect ? { effect } : {}),
      };
    }),
  };
}

function overlayAnimation(a: TextOverlay["animation"] | undefined): { in?: string; out?: string } | undefined {
  switch (a) {
    case "fade": return { in: "fade", out: "fade" };
    case "slide_up": return { in: "slideUp", out: "slideUp" };
    case "slide_down": return { in: "slideDown", out: "slideDown" };
    default: return undefined; // "none" (or unset, for plans made before this field existed) → no transition
  }
}

function overlayTrack(
  overlays: TextOverlay[],
  outputW: number,
  outputH: number,
  fontScale: number,
): ShotstackEdit["timeline"]["tracks"][number] {
  const fontSize = Math.max(18, Math.round(Math.min(outputW, outputH) * fontScale));
  const boxW = Math.round(outputW * 0.92);
  const boxH = Math.round(outputH * 0.5);
  // One overlay clip per overlay, sequenced (so they don't all stack at once).
  // Each shows for 2.5s, starting where the previous left off (capped to a safe window).
  let cursor = 0;
  return {
    clips: overlays.map((o) => {
      const color = sanitizeColor(o.color);
      const bg =
        o.background && o.background.trim().toLowerCase() !== "none" ? sanitizeColor(o.background) : null;
      const css =
        `body{margin:0}` +
        `.wrap{display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:0 4%}` +
        `p{margin:0;max-width:100%;font-family:Helvetica,Arial,sans-serif;font-weight:bold;` +
        `font-size:${fontSize}px;line-height:1.25;color:${color};text-align:center;` +
        `word-wrap:break-word;overflow-wrap:break-word;` +
        (o.uppercase ? `text-transform:uppercase;` : ``) +
        (bg
          ? `background-color:${bg};border-radius:0.18em;padding:0.08em 0.42em;`
          : `text-shadow:0 3px 14px rgba(0,0,0,0.75);`) +
        `}`;
      const start = Math.min(cursor, 8);
      cursor += 2.7; // slight gap between sequential overlays
      const anim = overlayAnimation(o.animation);
      return {
        asset: {
          type: "html",
          html: `<div class="wrap"><p>${escapeHtml(o.text)}</p></div>`,
          css,
          width: boxW,
          height: boxH,
        },
        position: o.position, // "top" | "center" | "bottom"
        start,
        length: 2.5,
        ...(anim ? { transition: anim } : {}),
      };
    }),
  };
}

// Builds the Shotstack edit JSON from a mastermind EditPlan + the (already
// normalized) clip URLs + the output dimensions + the resolved music URL.
// `safe: true` strips everything that isn't long-proven (transitions beyond a
// hard cut, clip motion effects, text backgrounds/animations) — a fallback
// when a fancy edit gets rejected by Shotstack, so the user still gets a video.
export function buildEdit(
  plan: EditPlan,
  clips: string[],
  outputSize: OutputSize | undefined,
  musicUrl: string,
  opts: { safe?: boolean } = {},
): ShotstackEdit {
  const preset = STYLE_PRESETS[plan.style];
  const size = outputSize ?? { width: 1080, height: 1920 };
  const safe = opts.safe === true;

  // Per-clip duration for the montage. With only 2 clips, hold a 2s floor so a
  // very_fast pace doesn't produce a sub-4s blink. (1 clip ignores this — it
  // plays its full length.)
  const perClipSeconds = Math.max(
    PACE_TO_CLIP_SECONDS[plan.pace],
    clips.length <= 2 ? 2.0 : 0,
  );

  const overlays = safe
    ? plan.text_overlays.map((o) => ({ ...o, background: "none", animation: "none" as const }))
    : plan.text_overlays;

  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (overlays.length > 0) {
    tracks.push(overlayTrack(overlays, size.width, size.height, preset.fontScale));
  }
  tracks.push(
    videoTrack(clips, perClipSeconds, {
      mute: !plan.keep_original_audio,
      sourceVolume: 0.3, // when keeping original audio, duck it under the music
      filter: mapColorFilter(plan.color_filter),
      speed: mapSpeed(plan.speed),
      transition: safe ? "cut" : plan.transition,
      motion: safe ? "none" : plan.motion,
    }),
  );

  return {
    timeline: {
      background: "#000000",
      soundtrack: { src: musicUrl, effect: "fadeOut" },
      tracks,
    },
    output: { format: "mp4", size, fps: 30 },
  };
}
