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

// Auto-shrinks a hero/subtitle font when the text is long, so an "A TRIP TO
// NEW YORK"-style title doesn't wrap to 3 lines and dominate the frame. Only
// applies when role's natural size is generous enough to wrap (hero/subtitle);
// body/caption are already small. Curve is a soft step-down keyed to char
// count so short titles keep their punch.
function lengthShrink(role: OverlayRoleId, text: string): number {
  if (role !== "hero" && role !== "subtitle") return 1;
  const n = text.trim().length;
  // Tuned so a hero on a 992px-wide box stays on ≤ 2 lines for typical
  // condensed/bold fonts. Subtitles also shrink a bit so a long tagline
  // doesn't crowd the hero above it.
  if (n <= 8) return 1;            // "MEXICO", "NO DAYS OFF" — full size
  if (n <= 14) return 0.85;        // "TRIP TO NYC" — slight shrink
  if (n <= 20) return 0.70;        // "A TRIP TO NEW YORK" — fits on 1-2 lines
  if (n <= 30) return 0.58;
  return 0.50;                     // truly long (>30 chars) — keep readable
}

// Each rendered line is a fully independent Shotstack clip on its own track,
// positioned via Shotstack's clip-level offset.y. We do NOT pack multiple
// lines into one HTML asset and ask the renderer to stack them — that path
// has bitten us in production across three different layout approaches
// (flex column, block flow, absolute positioning) because Shotstack's
// headless browser doesn't reliably honor within-asset layout. One line per
// asset eliminates the renderer from the layout decision entirely.
type LineSpec = {
  overlay: NormalizedOverlay;
  fontSize: number;
  lineHeightPx: number;
  offsetY: number;       // Shotstack offset.y — fraction of frame height
  assetHeightPx: number; // tight box around the line, with breathing padding
};

const LINE_HEIGHT_RATIO = 1.15;
// Gap between adjacent stacked lines uses the LARGER adjacent font so the gap
// scales with the dominant element. Floor at 36px so even a tiny caption
// can't press up against a hero. The previous "min font × 0.45em" formula
// produced ~18px gaps that were swallowed by glyph descenders/ascenders.
const INTER_LINE_EM = 0.55;
const INTER_LINE_MIN_PX = 36;
// Asset height padding above and below each line's text, so the asset box
// fully contains glyph ascenders/descenders even on fonts with extreme
// metrics (Anton, handwritten markers).
const LINE_ASSET_PAD_PX = 24;

function computeFontSize(o: NormalizedOverlay, minSide: number, fontScale: number): number {
  const sizeFactor = FONT_SIZE_FACTOR[o.size] ?? 1;
  const roleFactor = ROLE_FACTOR[o.role] ?? 1;
  const lengthFactor = lengthShrink(o.role, o.text);
  return Math.max(16, Math.round(minSide * fontScale * roleFactor * sizeFactor * lengthFactor));
}

// Computes the y-coordinate (in Shotstack offset.y units, i.e. fraction of
// frame height from the frame center) for each line in a same-position group.
// Lines are vertically stacked around the group's position-band center,
// preserving the matcher's order. Generous inter-line gap so glyph metrics
// can't push two lines into visual overlap.
function layoutLines(
  group: NormalizedOverlay[],
  outputW: number,
  outputH: number,
  fontScale: number,
): LineSpec[] {
  const minSide = Math.min(outputW, outputH);
  const sized = group.map((o) => {
    const fontSize = computeFontSize(o, minSide, fontScale);
    const lineHeightPx = Math.round(fontSize * LINE_HEIGHT_RATIO);
    return { overlay: o, fontSize, lineHeightPx };
  });
  // Inter-line gaps (length === sized.length - 1).
  const gaps: number[] = [];
  for (let i = 0; i < sized.length - 1; i++) {
    const larger = Math.max(sized[i]!.fontSize, sized[i + 1]!.fontSize);
    gaps.push(Math.max(INTER_LINE_MIN_PX, Math.round(larger * INTER_LINE_EM)));
  }
  // Total stack height (sum of line heights + sum of gaps).
  const totalH = sized.reduce((acc, s, i) => acc + s.lineHeightPx + (i < gaps.length ? gaps[i]! : 0), 0);
  // Band center in absolute frame pixels (e.g. for top: 0.5 * H + (-0.30) * H = 0.20 * H).
  const bandFraction = POSITION_Y_OFFSET[group[0]!.position];
  const bandCenterY = outputH * 0.5 + bandFraction * outputH;
  // Stack top in absolute frame pixels.
  let cursor = bandCenterY - totalH / 2;
  return sized.map((s, i) => {
    const lineTopY = cursor;
    const lineCenterY = lineTopY + s.lineHeightPx / 2;
    cursor += s.lineHeightPx + (i < gaps.length ? gaps[i]! : 0);
    // Convert absolute Y back to Shotstack offset.y fraction.
    const offsetY = (lineCenterY - outputH * 0.5) / outputH;
    return {
      overlay: s.overlay,
      fontSize: s.fontSize,
      lineHeightPx: s.lineHeightPx,
      offsetY,
      assetHeightPx: s.lineHeightPx + LINE_ASSET_PAD_PX * 2,
    };
  });
}

// Builds the HTML asset (one line, one asset) for a single LineSpec. The
// asset is a single <p> centered horizontally; vertical alignment is handled
// by Shotstack's clip position+offset since the asset box height is tight to
// the line height. No flex / no inner positioning math.
function buildLineAsset(spec: LineSpec, boxW: number): Record<string, unknown> {
  const o = spec.overlay;
  const color = sanitizeColor(o.color);
  const bg = o.background && o.background.trim().toLowerCase() !== "none" ? sanitizeColor(o.background) : null;
  const f = FONT_SPECS[o.font] ?? FONT_SPECS.bold_sans;
  const nf = namedFontFace(o.font_name); // optional Google Font by name
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
  // The asset box height = line-height + small padding. The <p> fills it,
  // text-align:center horizontally; line-height equal to the asset height so
  // the text sits at the asset's vertical center. We deliberately keep this
  // CSS minimal — no flex, no absolute positioning, no transforms — because
  // every layout primitive we've leaned on has had a Shotstack rendering
  // failure mode. With a one-line asset, "the text is the box" is enough.
  const css =
    faceCss +
    `html,body{margin:0;padding:0;width:100%;height:100%}` +
    `p.line{margin:0;padding:0;width:100%;height:100%;` +
    `text-align:center;` +
    `font-family:${fontStack};font-weight:${f.weight};` +
    `font-size:${spec.fontSize}px;line-height:${spec.assetHeightPx}px;color:${color};` +
    caseRule +
    stroke +
    (bg ? `background-color:${bg};border-radius:0.2em;` : ``) +
    (!bg && !stroke ? `text-shadow:0 3px 14px rgba(0,0,0,0.75);` : ``) +
    `}`;
  const html = `<p class="line">${escapeHtml(o.text)}</p>`;
  return {
    type: "html",
    html,
    css,
    width: boxW,
    height: spec.assetHeightPx,
  };
}

// Builds the overlay tracks for the timeline. CRITICAL: each overlay group
// gets its OWN track. We previously put all overlay clips on one track, but
// when multiple HTML-asset clips overlap in time on the same Shotstack track,
// the renderer's z-order/occlusion behavior is ambiguous — in production this
// produced visually overlapping text even after groupByPosition correctly
// stacked same-position items into one HTML asset. One group per track gives
// every group a dedicated render layer.
function overlayTracks(
  groups: NormalizedOverlay[][],
  outputW: number,
  outputH: number,
  fontScale: number,
  videoSeconds: number,
): ShotstackEdit["timeline"]["tracks"] {
  const boxW = Math.round(outputW * 0.92);
  const fullHold = Math.max(2.5, videoSeconds);
  const tracks: ShotstackEdit["timeline"]["tracks"] = [];
  let cursor = 0;
  groups.forEach((group, gIdx) => {
    // Group-level timing (start/length/transition shared across all lines in
    // the group so they enter and exit as one designed unit).
    const head = group[0]!;
    const inName = mapTransition(head.animation_in);
    const outName = mapTransition(head.animation_out);
    const transition = inName || outName ? { ...(inName ? { in: inName } : {}), ...(outName ? { out: outName } : {}) } : undefined;
    const anyNull = group.some((o) => o.duration_seconds === null);
    const explicitMax = group.reduce((m, o) => (typeof o.duration_seconds === "number" ? Math.max(m, o.duration_seconds) : m), 0);
    const length = anyNull ? fullHold : Math.min(60, Math.max(0.5, explicitMax || 2.7));
    const start = anyNull
      ? (gIdx === 0 ? 0 : Math.min(cursor, Math.max(0, videoSeconds - length)))
      : Math.min(cursor, Math.max(0, videoSeconds - length));
    cursor = start + length + 0.2;

    // Each line in the group becomes its OWN Shotstack clip on its OWN track,
    // positioned by Shotstack's clip-level offset.y. No within-asset stacking
    // to fail. The lines share the same start/length/transition so they read
    // as a unit. layoutLines() does the y math.
    const lineSpecs = layoutLines(group, outputW, outputH, fontScale);
    for (const spec of lineSpecs) {
      tracks.push({
        clips: [
          {
            asset: buildLineAsset(spec, boxW),
            position: "center",
            ...(spec.offsetY !== 0 ? { offset: { x: 0, y: spec.offsetY } } : {}),
            start,
            length,
            ...(transition ? { transition } : {}),
          },
        ],
      });
    }
  });
  return tracks;
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
    tracks.push(...overlayTracks(groups, size.width, size.height, preset.fontScale, totalSeconds));
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
