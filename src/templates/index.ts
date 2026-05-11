// Starter template set. The LLM picks one of these based on the user's caption.
// Add/edit freely — the matcher reads `description` for each template, so the
// quality of descriptions directly drives match quality.
//
// What makes a good description:
// - 1-2 sentences capturing mood, pace, visual style
// - End with "Pick when …" listing trigger phrases / situations
// - Differentiate clearly from the other templates (no overlap)
//
// Music IDs are placeholders — we'll wire them to real Shotstack audio URLs
// in slice 3 (render). For now they're just labels the matcher reasons over.

export type MusicOption = {
  id: string;
  description: string;
};

export type Template = {
  id: string;
  description: string;
  music_options: MusicOption[];
  text_slot_count: number;
};

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
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export const ALL_TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const ALL_MUSIC_IDS = TEMPLATES.flatMap((t) =>
  t.music_options.map((m) => m.id),
);
