import type { EditPlan, StyleId, TextOverlay, MusicSpec } from "../schemas.js";

// "Style presets" provide the rendering scaffold for each base style: how long
// each clip plays in a multi-clip montage, the overlay font size relative to
// the frame, and a fallback music spec used if the plan's music is empty. The
// mastermind matcher picks a style and then layers the rest of the plan
// (transition, color filter, speed, music, per-overlay styling) on top.
type StylePreset = {
  clipDurationS: number;
  fontScale: number; // × min(frameW, frameH)
  fallbackMusic: MusicSpec;
};

export const STYLE_PRESETS: Record<StyleId, StylePreset> = {
  hype: {
    clipDurationS: 3,
    fontScale: 0.085,
    fallbackMusic: { tags: ["energetic", "electronic"], freetext: "high energy hype", tempo: "fast", acoustic_or_electric: "any" },
  },
  sad: {
    clipDurationS: 5,
    fontScale: 0.05,
    fallbackMusic: { tags: ["sad", "classical"], freetext: "emotional piano", tempo: "slow", acoustic_or_electric: "acoustic" },
  },
  chill: {
    clipDurationS: 4,
    fontScale: 0.045,
    fallbackMusic: { tags: ["chillout", "lounge"], freetext: "mellow lofi chill beats", tempo: "medium", acoustic_or_electric: "any" },
  },
  funny: {
    clipDurationS: 2.5,
    fontScale: 0.08,
    fallbackMusic: { tags: ["funk", "happy"], freetext: "funny quirky upbeat", tempo: "medium", acoustic_or_electric: "any" },
  },
  cinematic: {
    clipDurationS: 6,
    fontScale: 0.04,
    fallbackMusic: { tags: ["cinematic", "epic", "soundtrack"], freetext: "cinematic epic orchestral", tempo: "medium", acoustic_or_electric: "any" },
  },
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

function mapTransition(t: EditPlan["transition"]): { in?: string; out?: string } | undefined {
  if (t === "fade") return { in: "fade", out: "fade" };
  if (t === "zoom") return { in: "zoom", out: "zoom" };
  return undefined; // "cut" → hard cut
}

function mapSpeed(s: EditPlan["speed"]): number {
  if (s === "slow") return 0.5;
  if (s === "fast") return 1.5;
  return 1.0;
}

function videoTrack(
  clips: string[],
  perClipS: number,
  opts: { mute: boolean; sourceVolume: number; filter?: string; speed: number; transition?: { in?: string; out?: string } },
): ShotstackEdit["timeline"]["tracks"][number] {
  const single = clips.length === 1;
  return {
    clips: clips.map((url, i) => {
      const asset: Record<string, unknown> = { type: "video", src: url, volume: opts.mute ? 0 : opts.sourceVolume };
      // Speed only applied for single-clip — multi-clip trim math gets fiddly.
      if (single && opts.speed !== 1.0) asset.speed = opts.speed;
      return {
        asset,
        start: single ? 0 : i * perClipS,
        length: single ? ("auto" as const) : perClipS,
        fit: "crop" as const,
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(single || !opts.transition ? {} : { transition: opts.transition }),
      };
    }),
  };
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
      const css =
        `body{margin:0}` +
        `.wrap{display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:0 4%}` +
        `p{margin:0;max-width:100%;font-family:Helvetica,Arial,sans-serif;font-weight:bold;` +
        `font-size:${fontSize}px;line-height:1.15;color:${color};text-align:center;` +
        `text-shadow:0 3px 14px rgba(0,0,0,0.75);word-wrap:break-word;overflow-wrap:break-word;` +
        (o.uppercase ? `text-transform:uppercase;` : ``) +
        `}`;
      const start = Math.min(cursor, 8);
      cursor += 2.7; // slight gap between sequential overlays
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
        transition: { in: "fade", out: "fade" },
      };
    }),
  };
}

// Builds the Shotstack edit JSON from a mastermind EditPlan + the (already
// normalized) clip URLs + the output dimensions + the resolved music URL.
export function buildEdit(
  plan: EditPlan,
  clips: string[],
  outputSize: OutputSize | undefined,
  musicUrl: string,
): ShotstackEdit {
  const preset = STYLE_PRESETS[plan.style];
  const size = outputSize ?? { width: 720, height: 1280 };

  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (plan.text_overlays.length > 0) {
    tracks.push(overlayTrack(plan.text_overlays, size.width, size.height, preset.fontScale));
  }
  tracks.push(
    videoTrack(clips, preset.clipDurationS, {
      mute: !plan.keep_original_audio,
      sourceVolume: 0.3, // when keeping original audio, duck it under the music
      filter: mapColorFilter(plan.color_filter),
      speed: mapSpeed(plan.speed),
      transition: mapTransition(plan.transition),
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
