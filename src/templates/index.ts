import type { TemplateChoice } from "../schemas.js";

// Starter template set. The LLM picks one based on the user's caption.
// Add/edit freely — the matcher reads `description` for each template, so
// description quality directly drives match quality.
//
// Each template's buildEdit() returns Shotstack edit JSON. It accepts an
// ARRAY of clip URLs (multi-clip stitching), an optional output size (the
// first clip's normalized dims, so the render matches the source
// orientation), and an optional music URL (a royalty-free track to lay over
// the clips; when present the source clips are muted).

export type MusicOption = {
  id: string;
  description: string; // what the matcher reasons over to pick a track
  jamendoQuery: string; // free-text query → an actual track via Jamendo (see services/music.ts)
};

// Loose Shotstack edit type. Shotstack's API accepts much more; we only
// model the fields we actually emit. See https://shotstack.io/docs/api/
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
      }>;
    }>;
  };
  output: {
    format: "mp4" | "gif" | "mp3";
    resolution?: "preview" | "mobile" | "sd" | "hd" | "1080";
    aspectRatio?: "16:9" | "9:16" | "1:1" | "4:5" | "4:3";
    // Custom dimensions. When set, omit resolution/aspectRatio — Shotstack's
    // resolution presets force a 16:9 frame regardless of aspectRatio.
    size?: { width: number; height: number };
    fps?: number;
  };
};

export type OutputSize = { width: number; height: number };

export type Template = {
  id: string;
  description: string;
  music_options: MusicOption[];
  text_slot_count: number;
  buildEdit: (
    clips: string[],
    choice: TemplateChoice,
    outputSize?: OutputSize,
    musicUrl?: string,
  ) => ShotstackEdit;
};

// Per-template clip duration when stitching multiple clips. Single clip uses
// the same value (user clip gets trimmed to this length). Total render
// duration = clipDuration * clipCount, plus a small tail for the last overlay.
const HYPE_CLIP_S = 3;
const SAD_CLIP_S = 5;
const CHILL_CLIP_S = 4;
const FUNNY_CLIP_S = 2.5;

function videoTrack(
  clips: string[],
  perClipS: number,
  mute: boolean,
  transition?: { in?: string; out?: string },
): ShotstackEdit["timeline"]["tracks"][number] {
  const single = clips.length === 1;
  return {
    clips: clips.map((url, i) => ({
      // Mute the source when there's a music track over it.
      asset: mute ? { type: "video", src: url, volume: 0 } : { type: "video", src: url },
      // Single clip: play it in full ("auto" = source's natural length).
      // Multi-clip: trim each to perClipS and sequence them — that's the
      // montage behavior, and Shotstack needs explicit starts to stitch.
      start: single ? 0 : i * perClipS,
      length: single ? "auto" : perClipS,
      // "crop" = scale to fill the frame, preserving aspect ratio, cropping
      // overflow. (NOT "cover" — that one stretches/distorts to fit.)
      fit: "crop",
      // No transition by default = hard cut between clips. A template can
      // opt into fades/zooms via its `transition` field.
      ...(single || !transition ? {} : { transition }),
    })),
  };
}

type OverlayStyle = { uppercase: boolean; fontScale: number };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Text overlays as `html` assets (not `title`, which doesn't wrap): a box
// sized relative to the frame, flex-centered, with wrapping text — so a long
// caption never runs off the edges. Font size scales to the frame's short
// side so portrait and landscape look comparable.
function titleTrack(
  overlays: TemplateChoice["text_overlays"],
  outputW: number,
  outputH: number,
  style: OverlayStyle,
): ShotstackEdit["timeline"]["tracks"][number] {
  const fontSize = Math.max(18, Math.round(Math.min(outputW, outputH) * style.fontScale));
  const boxW = Math.round(outputW * 0.92);
  const boxH = Math.round(outputH * 0.5);
  const css =
    `body{margin:0}` +
    `.wrap{display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:0 4%}` +
    `p{margin:0;max-width:100%;font-family:"Montserrat","Open Sans",Helvetica,Arial,sans-serif;` +
    `font-weight:800;font-size:${fontSize}px;line-height:1.15;color:#ffffff;text-align:center;` +
    `text-shadow:0 3px 14px rgba(0,0,0,0.75);word-wrap:break-word;overflow-wrap:break-word;` +
    (style.uppercase ? `text-transform:uppercase;` : ``) +
    `}`;
  return {
    clips: overlays.map((o) => ({
      asset: {
        type: "html",
        html: `<div class="wrap"><p>${escapeHtml(o.text)}</p></div>`,
        css,
        width: boxW,
        height: boxH,
      },
      position: "center",
      // Clamp to a safe window — we may not know the final video length
      // (single clip uses "auto").
      start: Math.max(0, Math.min(o.timestamp, 8)),
      length: 2.5,
      transition: { in: "fade", out: "fade" },
    })),
  };
}

function baseOutput(outputSize?: OutputSize): ShotstackEdit["output"] {
  // Match the source orientation when we probed it; otherwise default to
  // 9:16 portrait. Resolution presets force 16:9, so we always use `size`.
  const size = outputSize ?? { width: 720, height: 1280 };
  return { format: "mp4", size, fps: 30 };
}

function commonBuildEdit(
  clips: string[],
  choice: TemplateChoice,
  perClipS: number,
  overlayStyle: OverlayStyle,
  outputSize?: OutputSize,
  musicUrl?: string,
  // Omit for a hard cut between clips (the default). Pass e.g.
  // { in: "fade", out: "fade" } to opt this template into transitions.
  transition?: { in?: string; out?: string },
): ShotstackEdit {
  const size = outputSize ?? { width: 720, height: 1280 };
  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (choice.text_overlays.length > 0) {
    tracks.push(titleTrack(choice.text_overlays, size.width, size.height, overlayStyle));
  }
  tracks.push(videoTrack(clips, perClipS, Boolean(musicUrl), transition));
  return {
    timeline: {
      background: "#000000",
      ...(musicUrl ? { soundtrack: { src: musicUrl, effect: "fadeOut" } } : {}),
      tracks,
    },
    output: baseOutput(outputSize),
  };
}

export const TEMPLATES: Template[] = [
  {
    id: "tmpl_hype_montage",
    description:
      "High-energy montage with fast cuts on the beat, punchy zoom transitions, and bold all-caps text overlays. Pick when the user wants something exciting, hype, intense, action-packed, or 'goes hard' — sports highlights, party clips, gym, workout, dance.",
    music_options: [
      {
        id: "music_trap_drums",
        description: "Hard-hitting trap drums with deep 808 bass",
        jamendoQuery: "hard trap beat 808 bass instrumental",
      },
      {
        id: "music_edm_drop",
        description: "EDM build-up with a massive drop",
        jamendoQuery: "epic edm electronic drop instrumental",
      },
    ],
    text_slot_count: 2,
    buildEdit: (clips, choice, outputSize, musicUrl) =>
      commonBuildEdit(clips, choice, HYPE_CLIP_S, { uppercase: true, fontScale: 0.085 }, outputSize, musicUrl),
  },
  {
    id: "tmpl_sad_emotional",
    description:
      "Slow, emotional, melancholy edit. Long held shots, soft cross-fade transitions, simple serif text overlay. Pick when the user wants something sad, nostalgic, reflective, missing-someone, heartbreak, anime-style sad edit, or 'in my feelings'.",
    music_options: [
      {
        id: "music_piano_sad",
        description: "Soft piano in a minor key",
        jamendoQuery: "sad emotional piano instrumental melancholic",
      },
      {
        id: "music_lofi_rain",
        description: "Lofi beat with rain ambience",
        jamendoQuery: "lofi sad chill rainy ambient instrumental",
      },
    ],
    text_slot_count: 1,
    buildEdit: (clips, choice, outputSize, musicUrl) =>
      commonBuildEdit(clips, choice, SAD_CLIP_S, { uppercase: false, fontScale: 0.05 }, outputSize, musicUrl),
  },
  {
    id: "tmpl_aesthetic_chill",
    description:
      "Aesthetic chill vibes. Slow-mo, warm color grade, minimal handwritten-style overlays. Pick when the user wants something dreamy, soft, cozy, vibey, lifestyle, travel, sunset, coffee, golden hour, scenic.",
    music_options: [
      {
        id: "music_lofi_chill",
        description: "Mellow lofi beat",
        jamendoQuery: "mellow lofi chill beats instrumental",
      },
      {
        id: "music_synthwave",
        description: "Dreamy synthwave instrumental",
        jamendoQuery: "dreamy synthwave retro chill instrumental",
      },
    ],
    text_slot_count: 1,
    buildEdit: (clips, choice, outputSize, musicUrl) =>
      commonBuildEdit(clips, choice, CHILL_CLIP_S, { uppercase: false, fontScale: 0.045 }, outputSize, musicUrl),
  },
  {
    id: "tmpl_funny_meme",
    description:
      "Quick comedic edit with meme-style impact frames, freeze-frames, and bold caption text with arrows or emoji. Pick when the user wants something funny, meme, prank, absurd, comedic, 'this is so me', or relatable humor.",
    music_options: [
      {
        id: "music_meme_horn",
        description: "Classic meme airhorn / sad trombone",
        jamendoQuery: "funny goofy comedy quirky instrumental",
      },
      {
        id: "music_funky_bass",
        description: "Funky bassline groove",
        jamendoQuery: "funky groovy upbeat bass instrumental",
      },
    ],
    text_slot_count: 2,
    buildEdit: (clips, choice, outputSize, musicUrl) =>
      commonBuildEdit(clips, choice, FUNNY_CLIP_S, { uppercase: true, fontScale: 0.08 }, outputSize, musicUrl),
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export const ALL_TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const ALL_MUSIC_IDS = TEMPLATES.flatMap((t) =>
  t.music_options.map((m) => m.id),
);
