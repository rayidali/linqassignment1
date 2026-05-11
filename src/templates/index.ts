import type { TemplateChoice } from "../schemas.js";

// Starter template set. The LLM picks one based on the user's caption.
// Add/edit freely — the matcher reads `description` for each template, so
// description quality directly drives match quality.
//
// Each template's buildEdit() returns Shotstack edit JSON. The function
// accepts an ARRAY of clip URLs so multi-clip stitching works by construction
// (slice 4 will pass [url1, url2, …] when the iMessage has multiple media).

export type MusicOption = {
  id: string;
  description: string;
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

export type Template = {
  id: string;
  description: string;
  music_options: MusicOption[];
  text_slot_count: number;
  buildEdit: (clips: string[], choice: TemplateChoice) => ShotstackEdit;
};

// Per-template clip duration when stitching multiple clips. Single clip uses
// the same value (user clip gets trimmed to this length). Total render
// duration = clipDuration * clipCount, plus a small tail for the last overlay.
const HYPE_CLIP_S = 3;
const SAD_CLIP_S = 5;
const CHILL_CLIP_S = 4;
const FUNNY_CLIP_S = 2.5;

function videoTrack(clips: string[], perClipS: number): ShotstackEdit["timeline"]["tracks"][number] {
  const single = clips.length === 1;
  return {
    clips: clips.map((url, i) => ({
      asset: { type: "video", src: url },
      // Single clip: play it in full ("auto" = source's natural length).
      // Multi-clip: trim each to perClipS and sequence them — that's the
      // montage behavior, and Shotstack needs explicit starts to stitch.
      start: single ? 0 : i * perClipS,
      length: single ? "auto" : perClipS,
      // "cover" fills the portrait frame, cropping a landscape source.
      fit: "cover",
      ...(single ? {} : { transition: { in: "fade", out: "fade" } }),
    })),
  };
}

function titleTrack(
  overlays: TemplateChoice["text_overlays"],
  style: string,
  size: string,
): ShotstackEdit["timeline"]["tracks"][number] {
  return {
    clips: overlays.map((o) => ({
      asset: {
        type: "title",
        text: o.text,
        style,
        size,
        position: "center",
        color: "#ffffff",
      },
      // Clamp to a safe window — we may not know the final video length
      // (single clip uses "auto").
      start: Math.max(0, Math.min(o.timestamp, 8)),
      length: 2.5,
      transition: { in: "fade", out: "fade" },
    })),
  };
}

function baseOutput(): ShotstackEdit["output"] {
  // Explicit 9:16 portrait dimensions. Resolution presets force 16:9, so we
  // skip `resolution` and `aspectRatio` and set `size` directly.
  return { format: "mp4", size: { width: 720, height: 1280 }, fps: 30 };
}

function commonBuildEdit(
  clips: string[],
  choice: TemplateChoice,
  perClipS: number,
  titleStyle: string,
  titleSize: string,
): ShotstackEdit {
  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (choice.text_overlays.length > 0) {
    tracks.push(titleTrack(choice.text_overlays, titleStyle, titleSize));
  }
  tracks.push(videoTrack(clips, perClipS));
  return {
    timeline: {
      background: "#000000",
      tracks,
    },
    output: baseOutput(),
  };
}

export const TEMPLATES: Template[] = [
  {
    id: "tmpl_hype_montage",
    description:
      "High-energy montage with fast cuts on the beat, punchy zoom transitions, and bold all-caps text overlays. Pick when the user wants something exciting, hype, intense, action-packed, or 'goes hard' — sports highlights, party clips, gym, workout, dance.",
    music_options: [
      { id: "music_trap_drums", description: "Hard-hitting trap drums with deep 808 bass" },
      { id: "music_edm_drop", description: "EDM build-up with a massive drop" },
    ],
    text_slot_count: 2,
    buildEdit: (clips, choice) =>
      commonBuildEdit(clips, choice, HYPE_CLIP_S, "blockbuster", "large"),
  },
  {
    id: "tmpl_sad_emotional",
    description:
      "Slow, emotional, melancholy edit. Long held shots, soft cross-fade transitions, simple serif text overlay. Pick when the user wants something sad, nostalgic, reflective, missing-someone, heartbreak, anime-style sad edit, or 'in my feelings'.",
    music_options: [
      { id: "music_piano_sad", description: "Soft piano in a minor key" },
      { id: "music_lofi_rain", description: "Lofi beat with rain ambience" },
    ],
    text_slot_count: 1,
    buildEdit: (clips, choice) =>
      commonBuildEdit(clips, choice, SAD_CLIP_S, "minimal", "medium"),
  },
  {
    id: "tmpl_aesthetic_chill",
    description:
      "Aesthetic chill vibes. Slow-mo, warm color grade, minimal handwritten-style overlays. Pick when the user wants something dreamy, soft, cozy, vibey, lifestyle, travel, sunset, coffee, golden hour, scenic.",
    music_options: [
      { id: "music_lofi_chill", description: "Mellow lofi beat" },
      { id: "music_synthwave", description: "Dreamy synthwave instrumental" },
    ],
    text_slot_count: 1,
    buildEdit: (clips, choice) =>
      commonBuildEdit(clips, choice, CHILL_CLIP_S, "future", "small"),
  },
  {
    id: "tmpl_funny_meme",
    description:
      "Quick comedic edit with meme-style impact frames, freeze-frames, and bold caption text with arrows or emoji. Pick when the user wants something funny, meme, prank, absurd, comedic, 'this is so me', or relatable humor.",
    music_options: [
      { id: "music_meme_horn", description: "Classic meme airhorn / sad trombone" },
      { id: "music_funky_bass", description: "Funky bassline groove" },
    ],
    text_slot_count: 2,
    buildEdit: (clips, choice) =>
      commonBuildEdit(clips, choice, FUNNY_CLIP_S, "vogue", "medium"),
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export const ALL_TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const ALL_MUSIC_IDS = TEMPLATES.flatMap((t) =>
  t.music_options.map((m) => m.id),
);
