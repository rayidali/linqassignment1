import type { EditPlan, StyleId, PaceId, TextOverlay, MusicSpec, OverlayFontId, OverlaySizeId } from "../schemas.js";

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

// Overlay font palette — CDN-hosted display fonts (jsdelivr @fontsource WOFF2:
// stable, Chrome-compatible). The HTML overlay @font-faces the chosen one;
// Shotstack's renderer fetches it. If a URL ever 404s, the overlay just falls
// back to the bold-sans stack — no breakage.
const FONT_SPECS: Record<OverlayFontId, { family: string; weight: number; url: string }> = {
  bold_sans: { family: "iEditBoldSans", weight: 800, url: "https://cdn.jsdelivr.net/npm/@fontsource/montserrat/files/montserrat-latin-800-normal.woff2" },
  condensed: { family: "iEditCondensed", weight: 400, url: "https://cdn.jsdelivr.net/npm/@fontsource/anton/files/anton-latin-400-normal.woff2" },
  serif: { family: "iEditSerif", weight: 700, url: "https://cdn.jsdelivr.net/npm/@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2" },
  handwritten: { family: "iEditHand", weight: 400, url: "https://cdn.jsdelivr.net/npm/@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff2" },
  rounded: { family: "iEditRounded", weight: 700, url: "https://cdn.jsdelivr.net/npm/@fontsource/baloo-2/files/baloo-2-latin-700-normal.woff2" },
};
const FONT_SIZE_FACTOR: Record<OverlaySizeId, number> = { small: 0.72, medium: 1.0, large: 1.42 };

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

// Shotstack's sandbox plan caps render output at the "1080" preset: long side
// ≤ 1920, SHORT side ≤ 1080. A 9:16 phone video (1080×1920) is fine, but a 3:4
// photo (1440×1920) isn't — clamp so a non-9:16 source doesn't get the whole
// render 403'd. (Bump these if you upgrade the Shotstack plan.)
const SHOTSTACK_MAX_LONG = 1920;
const SHOTSTACK_MAX_SHORT = 1080;
function clampOutputSize(sz: OutputSize): OutputSize {
  const longSide = Math.max(sz.width, sz.height) || 1;
  const shortSide = Math.min(sz.width, sz.height) || 1;
  const scale = Math.min(1, SHOTSTACK_MAX_LONG / longSide, SHOTSTACK_MAX_SHORT / shortSide);
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2));
  return { width: even(sz.width), height: even(sz.height) };
}

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

// Resolves an open-license / Google Fonts family name to an @fontsource CDN
// @font-face block (covers ~all of Google Fonts; no API key needed). The two
// src urls (700 then 400) let the browser use whichever weight that font
// ships; if neither exists (typo, or a proprietary name we can't host), the
// @font-face yields nothing and the caller's font-family fallback chain kicks
// in. Returns null for an empty/unusable name.
function namedFontFace(rawName: string | undefined): { family: string; faceCss: string } | null {
  const cssName = (rawName ?? "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!cssName) return null;
  const slug = cssName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  const base = `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin`;
  return {
    family: cssName,
    faceCss:
      `@font-face{font-family:'${cssName}';font-weight:100 900;font-display:swap;` +
      `src:url('${base}-700-normal.woff2') format('woff2'),url('${base}-400-normal.woff2') format('woff2')}`,
  };
}

// How long the full video is, used as the "full duration" length when an
// overlay's duration_seconds is null. Floor at the existing min so very short
// edits still get a readable overlay.
function videoDurationSeconds(clipCount: number, perClipS: number): number {
  return Math.max(2.5, clipCount === 1 ? 12 : clipCount * perClipS);
}

function overlayTrack(
  overlays: TextOverlay[],
  outputW: number,
  outputH: number,
  fontScale: number,
  videoSeconds: number,
): ShotstackEdit["timeline"]["tracks"][number] {
  const boxW = Math.round(outputW * 0.92);
  const boxH = Math.round(outputH * 0.5);
  const minSide = Math.min(outputW, outputH);
  // Default per-overlay window when duration_seconds is null: hold for the
  // full video on the first overlay; sequence subsequent overlays so they
  // don't stack on top of each other.
  let cursor = 0;
  const fullHold = Math.max(2.5, videoSeconds);
  return {
    clips: overlays.map((o, idx) => {
      const color = sanitizeColor(o.color);
      const bg = o.background && o.background.trim().toLowerCase() !== "none" ? sanitizeColor(o.background) : null;
      const f = FONT_SPECS[o.font ?? "bold_sans"] ?? FONT_SPECS.bold_sans;
      const nf = namedFontFace(o.font_name); // a specific Google Font, if the user asked for one
      const fontSize = Math.max(16, Math.round(minSide * fontScale * (FONT_SIZE_FACTOR[o.size ?? "medium"] ?? 1)));
      const stroke =
        o.outline === "dark" ? `-webkit-text-stroke:0.07em #000;paint-order:stroke fill;` :
        o.outline === "light" ? `-webkit-text-stroke:0.07em #fff;paint-order:stroke fill;` : ``;
      const fontStack = `${nf ? `'${nf.family}',` : ""}'${f.family}','Arial Black','Helvetica Neue',Arial,'Liberation Sans',Helvetica,sans-serif`;
      const caseRule =
        o.case_style === "uppercase" ? `text-transform:uppercase;` :
        o.case_style === "lowercase" ? `text-transform:lowercase;` : ``;
      const css =
        `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-display:swap;src:url('${f.url}') format('woff2')}` +
        (nf ? nf.faceCss : ``) +
        `body{margin:0}` +
        `.wrap{display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:0 4%}` +
        `p{margin:0;max-width:100%;font-family:${fontStack};font-weight:${f.weight};` +
        `font-size:${fontSize}px;line-height:1.25;color:${color};text-align:center;` +
        `word-wrap:break-word;overflow-wrap:break-word;` +
        caseRule +
        stroke +
        (bg ? `background-color:${bg};border-radius:0.18em;padding:0.08em 0.42em;` : ``) +
        (!bg && !stroke ? `text-shadow:0 3px 14px rgba(0,0,0,0.75);` : ``) +
        `}`;
      // Duration: explicit number from the plan (clamped), or full video for
      // the first overlay / a 2.7s sequenced window for subsequent ones.
      const explicit = typeof o.duration_seconds === "number" && o.duration_seconds > 0;
      const length = explicit
        ? Math.min(60, Math.max(0.5, o.duration_seconds as number))
        : (idx === 0 ? fullHold : 2.7);
      // Start: when explicit, sequence after the previous; when full-hold, anchor at 0.
      const start = explicit ? Math.min(cursor, Math.max(0, videoSeconds - 0.5)) : (idx === 0 ? 0 : Math.min(cursor, Math.max(0, videoSeconds - length)));
      cursor = start + length + 0.2; // small gap before the next overlay
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
        length,
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
  const size = clampOutputSize(outputSize ?? { width: 1080, height: 1920 });
  const safe = opts.safe === true;

  // Per-clip duration for the montage. With only 2 clips, hold a 2s floor so a
  // very_fast pace doesn't produce a sub-4s blink. (1 clip ignores this — it
  // plays its full length.)
  const perClipSeconds = Math.max(
    PACE_TO_CLIP_SECONDS[plan.pace],
    clips.length <= 2 ? 2.0 : 0,
  );

  const overlays = safe
    ? plan.text_overlays.map((o) => ({
        ...o,
        background: "none",
        animation: "none" as const,
        duration_seconds: null,
        font_name: "",
        font: "bold_sans" as const,
        size: "medium" as const,
        outline: "none" as const,
      }))
    : plan.text_overlays;

  const totalSeconds = videoDurationSeconds(clips.length, perClipSeconds);
  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (overlays.length > 0) {
    tracks.push(overlayTrack(overlays, size.width, size.height, preset.fontScale, totalSeconds));
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
