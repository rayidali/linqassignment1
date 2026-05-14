import type {
  EditPlan,
  StyleId,
  PaceId,
  TextOverlay,
  MusicSpec,
  OverlayFontId,
  OverlaySizeId,
  OverlayRoleId,
  OverlayTransitionId,
} from "../schemas.js";

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
// Role does most of the size work; `size` (small/medium/large above) fine-tunes
// on top. A hero is ~6× the size of a caption, which is the visual ratio you
// see in good template work — magazine title vs credit line.
const ROLE_FACTOR: Record<OverlayRoleId, number> = {
  hero: 2.6,
  subtitle: 1.0,
  body: 0.55,
  caption: 0.4,
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

// Map our overlay-transition enum to Shotstack's native transition names.
function mapTransition(t: OverlayTransitionId | undefined): string | undefined {
  switch (t) {
    case "fade": return "fade";
    case "slide_up": return "slideUp";
    case "slide_down": return "slideDown";
    case "slide_left": return "slideLeft";
    case "slide_right": return "slideRight";
    case "carousel_up": return "carouselUp";
    case "carousel_down": return "carouselDown";
    case "carousel_left": return "carouselLeft";
    case "carousel_right": return "carouselRight";
    case "zoom": return "zoom";
    default: return undefined; // "none" / unset → no transition object
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

// A normalized overlay shape: every field is filled in, no nulls except
// duration_seconds. Used after migrateOverlay() so the renderer never has to
// reach for `?? default` again.
type NormalizedOverlay = {
  text: string;
  position: "top" | "center" | "bottom";
  color: string;
  role: OverlayRoleId;
  case_style: "as_written" | "uppercase" | "lowercase";
  background: string;
  animation_in: OverlayTransitionId;
  animation_out: OverlayTransitionId;
  duration_seconds: number | null;
  font_name: string;
  font: OverlayFontId;
  size: OverlaySizeId;
  outline: "none" | "dark" | "light";
};

// Brings any overlay shape we might see at runtime into the current schema
// shape. Three cases this guards against:
//   1) the latest schema (everything present) — passes through
//   2) the prior schema with `uppercase: boolean` + single `animation` —
//      stored in jsonb on older Job rows + reused on refinement
//   3) anything missing fields entirely — pre-1.0 leftovers
// Defaults are picked so an old plan renders the same as it did before this
// pass: role "subtitle" gives a 1× multiplier (matches the old default).
function migrateOverlay(raw: unknown): NormalizedOverlay {
  const o = (raw ?? {}) as Record<string, unknown>;
  const sizeRaw = (o.size as string | undefined) ?? "medium";
  const size: OverlaySizeId = (sizeRaw === "small" || sizeRaw === "medium" || sizeRaw === "large") ? sizeRaw : "medium";
  // For old plans with no `role`, derive from `size` so the visual size lands
  // in roughly the same place: large→hero, medium→subtitle, small→caption.
  const roleRaw = (o.role as string | undefined) ?? (size === "large" ? "hero" : size === "small" ? "caption" : "subtitle");
  const role: OverlayRoleId = (roleRaw === "hero" || roleRaw === "subtitle" || roleRaw === "body" || roleRaw === "caption") ? roleRaw : "subtitle";
  const positionRaw = (o.position as string | undefined) ?? "center";
  const position: "top" | "center" | "bottom" = (positionRaw === "top" || positionRaw === "center" || positionRaw === "bottom") ? positionRaw : "center";
  const fontRaw = (o.font as string | undefined) ?? "bold_sans";
  const font: OverlayFontId = (["bold_sans", "condensed", "serif", "handwritten", "rounded"] as const).includes(fontRaw as OverlayFontId)
    ? (fontRaw as OverlayFontId) : "bold_sans";
  const outlineRaw = (o.outline as string | undefined) ?? "none";
  const outline: "none" | "dark" | "light" = (outlineRaw === "none" || outlineRaw === "dark" || outlineRaw === "light") ? outlineRaw : "none";
  // case_style: prefer the new field; fall back to the old `uppercase: boolean`.
  const caseRaw = (o.case_style as string | undefined)
    ?? (o.uppercase === true ? "uppercase" : "as_written");
  const case_style: "as_written" | "uppercase" | "lowercase" = (caseRaw === "uppercase" || caseRaw === "lowercase" || caseRaw === "as_written") ? caseRaw : "as_written";
  // animation_in/out: prefer the new fields; fall back to the old single `animation` for both sides.
  const oldAnim = o.animation as string | undefined;
  const inRaw = (o.animation_in as string | undefined) ?? oldAnim ?? "none";
  const outRaw = (o.animation_out as string | undefined) ?? oldAnim ?? "none";
  const validTransition = (t: string): OverlayTransitionId => {
    const valid: OverlayTransitionId[] = ["none", "fade", "slide_up", "slide_down", "slide_left", "slide_right", "carousel_up", "carousel_down", "carousel_left", "carousel_right", "zoom"];
    return (valid as string[]).includes(t) ? (t as OverlayTransitionId) : "none";
  };
  const ds = o.duration_seconds;
  const duration_seconds = typeof ds === "number" && ds > 0 ? Math.min(60, Math.max(0.5, ds)) : null;
  return {
    text: typeof o.text === "string" ? o.text : "",
    position,
    color: typeof o.color === "string" ? o.color : "#ffffff",
    role,
    case_style,
    background: typeof o.background === "string" ? o.background : "none",
    animation_in: validTransition(inRaw),
    animation_out: validTransition(outRaw),
    duration_seconds,
    font_name: typeof o.font_name === "string" ? o.font_name : "",
    font,
    size,
    outline,
  };
}

// Groups overlays by position into stacks (hero + subtitle at the same
// position render as one designed HTML block). Grouping is GLOBAL, not just
// consecutive — if the matcher slips and emits [hero@top, body@bottom,
// subtitle@top], we still merge the two top-position items into one stack
// instead of producing two clips that render at the same screen zone and
// visually overlap. Order within each group preserves the matcher's order
// (hero first → it owns the group's transitions).
function groupByPosition(overlays: NormalizedOverlay[]): NormalizedOverlay[][] {
  const buckets = new Map<NormalizedOverlay["position"], NormalizedOverlay[]>();
  // Insertion order on Map preserves first-seen order across positions, so
  // groups come out in the order the matcher introduced each zone.
  for (const o of overlays) {
    const arr = buckets.get(o.position) ?? [];
    arr.push(o);
    buckets.set(o.position, arr);
  }
  return Array.from(buckets.values());
}

// Each logical position maps to an explicit y-offset on a center-anchored box.
// This guarantees the three zones (top / center / bottom) sit at distinct
// vertical centers regardless of box height, so wrapped or stacked content
// in one zone can't bleed into another. Text centers land at:
//   top    → 0.20 × frameH (≈ y=384 on a 1920-tall frame)
//   center → 0.50 × frameH (≈ y=960)
//   bottom → 0.80 × frameH (≈ y=1536)
const POSITION_Y_OFFSET: Record<NormalizedOverlay["position"], number> = {
  top: -0.30,
  center: 0,
  bottom: 0.30,
};

// Builds the per-line CSS for one overlay inside a stacked group. The class
// name is line-N so each line can carry its own font, size, color, case,
// outline, and pill background, all stacked inside one flex column.
function lineCss(
  o: NormalizedOverlay,
  idx: number,
  minSide: number,
  fontScale: number,
): { faceCss: string; ruleCss: string; fontStack: string } {
  const color = sanitizeColor(o.color);
  const bg = o.background && o.background.trim().toLowerCase() !== "none" ? sanitizeColor(o.background) : null;
  const f = FONT_SPECS[o.font] ?? FONT_SPECS.bold_sans;
  const nf = namedFontFace(o.font_name); // optional Google Font by name
  const sizeFactor = FONT_SIZE_FACTOR[o.size] ?? 1;
  const roleFactor = ROLE_FACTOR[o.role] ?? 1;
  const fontSize = Math.max(16, Math.round(minSide * fontScale * roleFactor * sizeFactor));
  const stroke =
    o.outline === "dark" ? `-webkit-text-stroke:0.06em #000;paint-order:stroke fill;` :
    o.outline === "light" ? `-webkit-text-stroke:0.06em #fff;paint-order:stroke fill;` : ``;
  const fontStack = `${nf ? `'${nf.family}',` : ""}'${f.family}','Arial Black','Helvetica Neue',Arial,'Liberation Sans',Helvetica,sans-serif`;
  const caseRule =
    o.case_style === "uppercase" ? `text-transform:uppercase;` :
    o.case_style === "lowercase" ? `text-transform:lowercase;` : ``;
  const faceCss =
    `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-display:swap;src:url('${f.url}') format('woff2')}` +
    (nf ? nf.faceCss : ``);
  const ruleCss =
    `p.line-${idx}{font-family:${fontStack};font-weight:${f.weight};` +
    `font-size:${fontSize}px;color:${color};` +
    caseRule +
    stroke +
    (bg ? `background-color:${bg};border-radius:0.2em;padding:0.08em 0.42em;` : ``) +
    (!bg && !stroke ? `text-shadow:0 3px 14px rgba(0,0,0,0.75);` : ``) +
    `}`;
  return { faceCss, ruleCss, fontStack };
}

function overlayTrack(
  groups: NormalizedOverlay[][],
  outputW: number,
  outputH: number,
  fontScale: number,
  videoSeconds: number,
): ShotstackEdit["timeline"]["tracks"][number] {
  const boxW = Math.round(outputW * 0.92);
  // Box height is generous enough to fit a wrapped hero+subtitle stack but
  // not so big that a single zone visually owns the whole frame. Combined
  // with the per-zone y-offset below, each zone has a clear vertical home.
  const boxH = Math.round(outputH * 0.45);
  const minSide = Math.min(outputW, outputH);
  const fullHold = Math.max(2.5, videoSeconds);
  let cursor = 0;
  return {
    clips: groups.map((group, gIdx) => {
      // Compose per-line CSS for the whole stack. @font-face declarations are
      // deduped by family name so the same font isn't redeclared if multiple
      // lines share it.
      const seenFaces = new Set<string>();
      const faceCsses: string[] = [];
      const ruleCsses: string[] = [];
      const linesHtml: string[] = [];
      group.forEach((o, lineIdx) => {
        const { faceCss, ruleCss } = lineCss(o, lineIdx, minSide, fontScale);
        // Cheap dedupe: a face block starts with @font-face{font-family:'X';
        // — bucket by that prefix.
        const key = faceCss.slice(0, faceCss.indexOf("src:")); // family + weight + display, no src
        if (!seenFaces.has(key)) {
          seenFaces.add(key);
          faceCsses.push(faceCss);
        }
        ruleCsses.push(ruleCss);
        linesHtml.push(`<p class="line-${lineIdx}">${escapeHtml(o.text)}</p>`);
      });
      const css =
        faceCsses.join("") +
        `body{margin:0}` +
        // Flex column: vertically center the stack, horizontally center each line.
        // inline-block lines so pill backgrounds hug their text instead of going edge-to-edge.
        `.stack{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:0 4%;text-align:center}` +
        `.stack p{display:inline-block;margin:0;max-width:100%;line-height:1.15;word-wrap:break-word;overflow-wrap:break-word}` +
        // Generous vertical breathing room between stacked lines (hero +
        // subtitle reads as a designed pair, not a cramped pair). Sized in em
        // of the second line so it scales with the smaller font and keeps
        // proportionality across font sizes.
        `.stack p + p{margin-top:0.45em}` +
        ruleCsses.join("");
      // Group's transition pair comes from the FIRST overlay (the hero, in a
      // hero+subtitle stack). The whole block enters/exits as one unit.
      const head = group[0]!;
      const inName = mapTransition(head.animation_in);
      const outName = mapTransition(head.animation_out);
      const transition = inName || outName ? { ...(inName ? { in: inName } : {}), ...(outName ? { out: outName } : {}) } : undefined;
      // Duration: explicit number wins, with null priority — if ANY overlay in
      // the group says null, the group holds for the full video. Otherwise
      // use the max of the explicit durations (so all lines have time to read).
      const anyNull = group.some((o) => o.duration_seconds === null);
      const explicitMax = group.reduce((m, o) => (typeof o.duration_seconds === "number" ? Math.max(m, o.duration_seconds) : m), 0);
      const length = anyNull
        ? fullHold
        : Math.min(60, Math.max(0.5, explicitMax || 2.7));
      // Start: full-hold groups anchor at 0; explicit-duration groups sequence
      // after the previous group (so a 2s flash card doesn't sit at 0 forever).
      const start = anyNull
        ? (gIdx === 0 ? 0 : Math.min(cursor, Math.max(0, videoSeconds - length)))
        : Math.min(cursor, Math.max(0, videoSeconds - length));
      cursor = start + length + 0.2;
      // Use Shotstack position="center" for every clip and shift each zone via
      // an explicit y-offset. Anchoring boxes to frame edges (the previous
      // approach) made adjacent zones overlap by hundreds of pixels even though
      // text centers were apart — wrapped heroes bled across that overlap zone.
      // Center-anchor + offset gives every zone a guaranteed vertical home.
      const yOffset = POSITION_Y_OFFSET[head.position];
      return {
        asset: {
          type: "html",
          html: `<div class="stack">${linesHtml.join("")}</div>`,
          css,
          width: boxW,
          height: boxH,
        },
        position: "center",
        ...(yOffset !== 0 ? { offset: { x: 0, y: yOffset } } : {}),
        start,
        length,
        ...(transition ? { transition } : {}),
      };
    }),
  };
}

// Exported for the estimator in state.ts so the render-time estimate counts
// HTML asset renders (one per group), not raw overlay count. A hero+subtitle
// pair is one HTML asset, not two.
export function overlayGroupCount(rawOverlays: unknown[]): number {
  if (!Array.isArray(rawOverlays) || rawOverlays.length === 0) return 0;
  return groupByPosition(rawOverlays.map(migrateOverlay)).length;
}

// Safe-mode collapse for an overlay: drop the design flourishes that have
// caused Shotstack render rejections in the past — pill backgrounds, fancy
// transitions, named fonts, duration overrides. Keep the text, position,
// color, role (so size hierarchy survives), case_style, and font category.
function safeOverlay(o: NormalizedOverlay): NormalizedOverlay {
  return {
    ...o,
    background: "none",
    animation_in: "none",
    animation_out: "none",
    duration_seconds: null,
    font_name: "",
    outline: "none",
  };
}

// Builds the Shotstack edit JSON from a mastermind EditPlan + the (already
// normalized) clip URLs + the output dimensions + the resolved music URL.
// `safe: true` strips everything that isn't long-proven (transitions beyond a
// hard cut, clip motion effects, overlay backgrounds/animations/duration
// overrides/named fonts) — a fallback when a fancy edit gets rejected by
// Shotstack, so the user still gets a video.
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

  // Normalize first (so the renderer doesn't have to deal with mixed-schema
  // input from old stored plans), then collapse for safe mode, then group.
  const normalized = (plan.text_overlays ?? []).map((o) => migrateOverlay(o));
  const finalOverlays = safe ? normalized.map(safeOverlay) : normalized;
  const groups = groupByPosition(finalOverlays);

  const totalSeconds = videoDurationSeconds(clips.length, perClipSeconds);
  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  if (groups.length > 0) {
    tracks.push(overlayTrack(groups, size.width, size.height, preset.fontScale, totalSeconds));
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
