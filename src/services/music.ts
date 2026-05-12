import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";
import type { MusicSpec } from "../schemas.js";

const JAMENDO_API = "https://api.jamendo.com/v3.0";
const MAX_TRACK_BYTES = 20 * 1024 * 1024;

// cache key -> resolved R2 URL. Only successes are cached.
const resolved = new Map<string, string>();

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

function buildUrl(extra: Record<string, string>): string {
  const url = new URL(`${JAMENDO_API}/tracks/`);
  url.searchParams.set("client_id", env.JAMENDO_CLIENT_ID ?? "");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("vocalinstrumental", "instrumental");
  url.searchParams.set("order", "popularity_total");
  for (const [k, v] of Object.entries(extra)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

async function fetchTrack(u: string): Promise<JamendoTrack | null> {
  const res = await fetch(u);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { results?: JamendoTrack[] } | null;
  const t = data?.results?.[0];
  return t && t.audio && t.id ? t : null;
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

  const curatedId = curatedTrackId(spec);
  if (curatedId) {
    const t = await fetchTrack(buildUrl({ id: curatedId }));
    if (t) return t;
  }

  const tags = spec.tags.join(",");
  const speed = tempoToSpeed(spec.tempo) ?? "";
  const ae = spec.acoustic_or_electric === "any" ? "" : spec.acoustic_or_electric;
  const search = spec.freetext.trim();

  // Progressively loosen: tags+search+speed+acoustic → tags+search → search → fuzzytags.
  if (tags && (search || speed || ae)) {
    const t = await fetchTrack(buildUrl({ tags, search, speed, acousticelectric: ae }));
    if (t) return t;
  }
  if (tags) {
    const t = await fetchTrack(buildUrl({ tags, search }));
    if (t) return t;
  }
  if (search) {
    const t = await fetchTrack(buildUrl({ search }));
    if (t) return t;
  }
  if (tags) {
    return fetchTrack(buildUrl({ fuzzytags: tags }));
  }
  return null;
}

function cacheKey(spec: MusicSpec): string {
  return `${[...spec.tags].sort().join(",")}|${spec.freetext.toLowerCase().trim()}|${spec.tempo}|${spec.acoustic_or_electric}`;
}

// Resolves a music spec to a playable R2-hosted MP3 URL: finds a royalty-free
// instrumental on Jamendo (curated track → tag filter → free-text → fuzzy
// tags), downloads it and re-hosts on R2 so Shotstack can fetch it reliably.
// Cached. Returns null on any failure (caller falls back).
export async function resolveMusicUrl(jobId: string, spec: MusicSpec): Promise<string | null> {
  const key = cacheKey(spec);
  const cached = resolved.get(key);
  if (cached) return cached;

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
    const audioRes = await fetch(track.audio);
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
    resolved.set(key, url);
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
