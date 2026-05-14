import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "../http.js";
import type { MusicSpec } from "../schemas.js";

const JAMENDO_API = "https://api.jamendo.com/v3.0";
const MAX_TRACK_BYTES = 20 * 1024 * 1024;

// Hand-picked track IDs for cases where Jamendo's default ordering isn't the
// obvious choice (e.g. we want the actual "Jingle Bells" carol for christmas,
// not a generic christmas-tagged instrumental). Keyed by a tag name; checked
// against the spec's tags and freetext.
const CURATED_BY_TAG: Record<string, string> = {
  christmas: "478677", // "Jingle Bells" — Maya Filipič (clean instrumental cover)
  halloween: "2208341", // "Cinematic Mystery" — Top Flow
  summer: "350990", // "Summer Breeze" — SONIC MYSTERY
  romantic: "5790", // "Not Alone" — Rob Costlow
};
// Extra keyword patterns (in tags or freetext) that map to a curated tag.
const CURATED_KEYWORDS: Array<{ match: RegExp; tag: keyof typeof CURATED_BY_TAG }> = [
  { match: /christmas|xmas|jingle bell|merry christmas|santa|carol of the bell|deck the hall|o come all|silent night|winter wonderland/i, tag: "christmas" },
  { match: /halloween|spooky|haunted|creepy/i, tag: "halloween" },
  { match: /\bsummer\b|beach vibe|tropical/i, tag: "summer" },
  { match: /valentine|romantic date|anniversary/i, tag: "romantic" },
];

type JamendoTrack = { id?: string; name?: string; artist_name?: string; audio?: string };

function tempoToSpeed(tempo: MusicSpec["tempo"]): string | null {
  if (tempo === "slow") return "low";
  if (tempo === "medium") return "medium";
  if (tempo === "fast") return "high";
  return null;
}

// How many candidates to pull for a tag/search query before picking one — a
// random choice among the top-N gives variety (no more "always the same most-
// popular track for these tags"). Curated-ID lookups stay at limit 1.
const CANDIDATE_POOL = 20;
// Per-query pool size for the multi-signal scorer. Wider than CANDIDATE_POOL
// because we INTERSECT pools — a track needs to appear in multiple queries to
// score well, so individual pools can be generous without sacrificing quality.
const SCORE_POOL = 40;
// How many top-scored tracks to pick from at random. Big enough for variety,
// small enough that we're always picking from the "robustly good" tier.
const SCORE_PICK_TOP_K = 10;

// In-process recent-picks penalty: the SAME track for the same spec
// repeatedly is boring. Track IDs we've picked recently get a temporary score
// penalty so the next pick rolls a different (still-high-scoring) candidate.
// Resets on process restart, which is fine — Render restarts every few hours.
const RECENT_PICK_TTL_MS = 60 * 60 * 1000; // 1 hour
const RECENT_PICK_MAX_PENALTY = 4; // matches the score weights below
const recentPicks = new Map<string, number>(); // trackId -> picked-at epoch ms

function recordRecentPick(trackId: string): void {
  recentPicks.set(trackId, Date.now());
  // Opportunistic prune so the map can't grow unbounded.
  if (recentPicks.size > 256) {
    const cutoff = Date.now() - RECENT_PICK_TTL_MS;
    for (const [id, t] of recentPicks) {
      if (t < cutoff) recentPicks.delete(id);
    }
  }
}

function recentPickPenalty(trackId: string): number {
  const last = recentPicks.get(trackId);
  if (!last) return 0;
  const ageMs = Date.now() - last;
  if (ageMs >= RECENT_PICK_TTL_MS) return 0;
  // Linear decay from full penalty (just picked) to 0 (after the TTL).
  return -RECENT_PICK_MAX_PENALTY * (1 - ageMs / RECENT_PICK_TTL_MS);
}

function buildUrl(extra: Record<string, string>, limit = 1): string {
  const url = new URL(`${JAMENDO_API}/tracks/`);
  url.searchParams.set("client_id", env.JAMENDO_CLIENT_ID ?? "");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("vocalinstrumental", "instrumental");
  url.searchParams.set("order", "popularity_total");
  for (const [k, v] of Object.entries(extra)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

async function fetchTracks(u: string): Promise<JamendoTrack[]> {
  const res = await fetchWithTimeout(u);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { results?: JamendoTrack[] } | null;
  return (data?.results ?? []).filter((t): t is JamendoTrack => Boolean(t?.audio && t?.id));
}

async function fetchTrack(u: string): Promise<JamendoTrack | null> {
  return (await fetchTracks(u))[0] ?? null;
}

// Defensive name filter for obviously mournful tracks. The matcher's prompt
// now maps R&B / hip-hop / country / latin / disco etc. to groove tags
// (`funk`/`groovy`/`hiphop`/etc.) and never to `love`/`romantic`/`sad`, but if
// it slips and we end up querying Jamendo's "popular" pool with mood-leaning
// tags, the candidate list can still surface tracks literally titled "Funeral
// March", "Requiem", etc. Strip those unless the spec is explicitly sad
// (`tags` includes `sad`, or freetext mentions a death-y word — in which case
// the user actually wants this and we keep them in the pool).
const MOURNFUL_NAME = /funeral|requiem|elegy|dirge|mournful|weeping|funerale/i;
const SPEC_SAYS_SAD = /sad|funeral|memorial|mourning|elegy|requiem|grief|in memoriam|tribute|farewell/i;
function isSadSpec(spec: MusicSpec): boolean {
  if (spec.tags.includes("sad")) return true;
  return SPEC_SAYS_SAD.test(spec.freetext);
}
function filterTracks(spec: MusicSpec, tracks: JamendoTrack[]): JamendoTrack[] {
  if (isSadSpec(spec)) return tracks;
  return tracks.filter((t) => !(t.name && MOURNFUL_NAME.test(t.name)));
}

function pickOne(tracks: JamendoTrack[]): JamendoTrack | null {
  if (tracks.length === 0) return null;
  return tracks[Math.floor(Math.random() * tracks.length)] ?? tracks[0] ?? null;
}

function curatedTrackId(spec: MusicSpec): string | undefined {
  for (const t of spec.tags) {
    if (CURATED_BY_TAG[t]) return CURATED_BY_TAG[t];
  }
  const hay = `${spec.tags.join(" ")} ${spec.freetext}`;
  for (const c of CURATED_KEYWORDS) {
    if (c.match.test(hay)) return CURATED_BY_TAG[c.tag];
  }
  return undefined;
}

async function findTrack(spec: MusicSpec): Promise<JamendoTrack | null> {
  if (!env.JAMENDO_CLIENT_ID) return null;

  // 1) Curated track wins — these are hand-picked and known good.
  const curatedId = curatedTrackId(spec);
  if (curatedId) {
    const t = await fetchTrack(buildUrl({ id: curatedId }));
    if (t) {
      recordRecentPick(t.id!);
      return t;
    }
  }

  // 2) Multi-signal scored selection — works for ANY genre. See pickByScore().
  const scored = await pickByScore(spec);
  if (scored) {
    recordRecentPick(scored.id!);
    return scored;
  }

  // 3) Last-resort fallback: Jamendo's loose `search` against the matcher's
  // freetext. Only triggers when scoring produced no candidates at all
  // (extremely rare — only an empty/invalid genre + no freetext gets here).
  const search = spec.freetext.trim();
  if (search) {
    const pool = filterTracks(spec, await fetchTracks(buildUrl({ search }, CANDIDATE_POOL)));
    const t = pickOne(pool);
    if (t) {
      recordRecentPick(t.id!);
      return t;
    }
  }
  return null;
}

// Multi-signal scored selector. Issues several Jamendo queries in PARALLEL with
// different ranking signals (lifetime popularity, current-month trending) and
// filter intensities (with/without tempo, with/without instrumentation), then
// scores each track by how many queries it appears in and how high it ranks
// in each. A track that's "robustly good" — popular long-term AND currently
// listened to AND matches the user's tempo AND instrumentation — scores
// highest. Filters BOOST instead of EXCLUDING, so we never end up with an
// empty pool. Then picks randomly from the top-K for variety.
//
// Genre-agnostic by design: this same algorithm is the fix for jazz, R&B,
// country, indie, lofi, anything. The previous single-query selector
// over-narrowed any time the matcher added a tempo + acoustic filter,
// surfacing whichever 3-5 obscure tracks happened to match all filters.
async function pickByScore(spec: MusicSpec): Promise<JamendoTrack | null> {
  const tags = spec.tags.map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return null;

  const allTags = tags.join(",");
  const firstTag = tags[0]!;
  const speed = tempoToSpeed(spec.tempo) ?? "";
  const ae = spec.acoustic_or_electric === "any" ? "" : spec.acoustic_or_electric;

  // Build the parallel query plan. Weights reflect signal strength:
  //  - Lifetime popularity: 3 (most reliable signal)
  //  - Recent (monthly) popularity: 2 (currently relevant)
  //  - Tempo / instrumentation match: 2 each (vibe match boost)
  // A track hitting all four signals scores ~9, dominating any track hitting
  // only one or two.
  type Q = { q: Record<string, string>; weight: number; name: string };
  const queries: Q[] = [
    { q: { tags: allTags, order: "popularity_total" }, weight: 3, name: "lifetime_full_tags" },
    { q: { tags: allTags, order: "popularity_month" }, weight: 2, name: "trending_full_tags" },
  ];
  // If the matcher used multiple tags, ALSO query just the genre tag (the
  // first tag) — surfaces tracks that match the core sound but not the
  // narrower mood combo. Keeps quality without strict tag-AND requirement.
  if (tags.length > 1) {
    queries.push({ q: { tags: firstTag, order: "popularity_total" }, weight: 2, name: "lifetime_genre_only" });
  }
  // Filter-as-boost queries: the user's tempo + instrumentation preferences
  // are signal, but not exclusionary — a track that matches them gets a
  // score bump rather than being the only candidate.
  if (speed) {
    queries.push({ q: { tags: firstTag, speed, order: "popularity_total" }, weight: 2, name: "tempo_match" });
  }
  if (ae) {
    queries.push({ q: { tags: firstTag, acousticelectric: ae, order: "popularity_total" }, weight: 2, name: "instr_match" });
  }

  const results = await Promise.all(
    queries.map(async ({ q, weight, name }) => {
      const tracks = filterTracks(spec, await fetchTracks(buildUrl(q, SCORE_POOL)));
      return { tracks, weight, name };
    }),
  );

  // Score each unique track. Position decay: top-of-pool tracks get the full
  // weight; bottom-of-pool tracks get 0.3× — so the algorithm prefers the
  // genuinely top picks of each query rather than rewarding any-appearance.
  type Scored = { track: JamendoTrack; score: number; sources: string[] };
  const scoreMap = new Map<string, Scored>();
  for (const { tracks, weight, name } of results) {
    tracks.forEach((t, idx) => {
      if (!t.id) return;
      const positionFactor = Math.max(0.3, 1 - idx / SCORE_POOL);
      const contribution = weight * positionFactor;
      const existing = scoreMap.get(t.id);
      if (existing) {
        existing.score += contribution;
        existing.sources.push(name);
      } else {
        scoreMap.set(t.id, { track: t, score: contribution, sources: [name] });
      }
    });
  }

  if (scoreMap.size === 0) return null;

  // Apply the recent-pick penalty so we don't repeat the same track on
  // back-to-back requests for the same spec.
  for (const entry of scoreMap.values()) {
    entry.score += recentPickPenalty(entry.track.id!);
  }

  // Sort by score, pick uniformly random from the top K. Top K is the
  // "robustly good" tier; randomness within it is the variety knob.
  const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
  const topK = sorted.slice(0, Math.min(SCORE_PICK_TOP_K, sorted.length));
  const picked = pickOne(topK.map((s) => s.track));
  if (picked) {
    const pickedScored = scoreMap.get(picked.id!);
    logger.info(
      {
        spec,
        candidates: scoreMap.size,
        topKSize: topK.length,
        pickedId: picked.id,
        pickedName: picked.name,
        pickedArtist: picked.artist_name,
        pickedScore: pickedScored?.score.toFixed(2),
        pickedSources: pickedScored?.sources,
        topPicks: topK.slice(0, 5).map((s) => ({ id: s.track.id, name: s.track.name, score: Number(s.score.toFixed(2)), sources: s.sources })),
      },
      "music: scored pick",
    );
  }
  return picked;
}

// Resolves a music spec to a playable R2-hosted MP3 URL: finds a royalty-free
// instrumental on Jamendo (curated track → tag filter → free-text → fuzzy
// tags; non-curated queries pick at random from a candidate pool for variety),
// downloads it and re-hosts on R2 so Shotstack can fetch it reliably. Returns
// null on any failure (caller falls back to a hardcoded track).
export async function resolveMusicUrl(jobId: string, spec: MusicSpec): Promise<string | null> {
  try {
    const track = await findTrack(spec);
    if (!track || !track.audio || !track.id) {
      logger.warn({ jobId, spec }, "no Jamendo match for music spec");
      return null;
    }
    logger.info(
      { jobId, spec, trackId: track.id, name: track.name, artist: track.artist_name },
      "resolving music track from Jamendo",
    );
    const audioRes = await fetchWithTimeout(track.audio, {}, MEDIA_TIMEOUT_MS);
    if (!audioRes.ok || !audioRes.body) {
      logger.warn({ jobId, status: audioRes.status }, "failed to fetch Jamendo audio");
      return null;
    }
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_TRACK_BYTES) {
      logger.warn({ jobId, bytes: buf.length }, "Jamendo audio empty or too large");
      return null;
    }
    const r2Key = `music/jamendo-${track.id}.mp3`;
    await new Upload({
      client: getR2Client(),
      params: { Bucket: getR2Bucket(), Key: r2Key, Body: buf, ContentType: "audio/mpeg" },
    }).done();
    const url = r2PublicUrl(r2Key);
    if (!url) return null;
    logger.info({ jobId, r2Key, bytes: buf.length }, "music track re-hosted on R2");
    return url;
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err) },
      "music resolve failed",
    );
    return null;
  }
}
