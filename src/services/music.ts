import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";

const JAMENDO_API = "https://api.jamendo.com/v3.0";
const MAX_TRACK_BYTES = 20 * 1024 * 1024;

// query (lowercased) -> resolved R2 URL. Only successes are cached.
const resolved = new Map<string, string>();

// Hand-curated track IDs for iconic themes where Jamendo's fuzzy search fails
// to surface the obvious choice. (Jingle Bells by Maya Filipič — a clean
// royalty-free instrumental cover.) Add more as needed.
const CURATED_TRACKS: Array<{ match: RegExp; trackId: string }> = [
  {
    match: /christmas|xmas|jingle bell|merry christmas|santa|holiday season|deck the hall|o come all|silent night|carol of the bell|winter wonderland/i,
    trackId: "478677",
  },
];

// Maps keywords in the search query to Jamendo genre tags — the `tags` filter
// returns far more on-target results than free-text `search` alone. First
// match wins. If `tags` returns nothing, we retry with `search` alone.
const KEYWORD_TO_TAG: Array<{ match: RegExp; tag: string }> = [
  { match: /christmas|xmas|jingle|carol|holiday/i, tag: "christmas" },
  { match: /lofi|lo-fi|chillhop|chill ?beat/i, tag: "lounge" },
  { match: /chill|relax|mellow|ambient|dreamy/i, tag: "chillout" },
  { match: /trap|hip ?hop|rap|808|drill/i, tag: "hiphop" },
  { match: /piano|orchestral|cinematic|epic|classical|score|soundtrack/i, tag: "soundtrack" },
  { match: /edm|electronic|techno|house|synth|dance/i, tag: "electronic" },
  { match: /rock|guitar|punk|metal/i, tag: "rock" },
  { match: /jazz|swing|blues|soul/i, tag: "jazz" },
  { match: /funk|groove|disco|upbeat|party/i, tag: "pop" },
];

type JamendoTrack = { id?: string; name?: string; artist_name?: string; audio?: string };

function jamendoUrl(extra: Record<string, string>): string {
  const url = new URL(`${JAMENDO_API}/tracks/`);
  url.searchParams.set("client_id", env.JAMENDO_CLIENT_ID ?? "");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("vocalinstrumental", "instrumental");
  url.searchParams.set("order", "popularity_total");
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.toString();
}

async function fetchTrack(u: string): Promise<JamendoTrack | null> {
  const res = await fetch(u);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { results?: JamendoTrack[] } | null;
  const t = data?.results?.[0];
  return t && t.audio && t.id ? t : null;
}

async function searchJamendo(query: string): Promise<JamendoTrack | null> {
  if (!env.JAMENDO_CLIENT_ID) return null;

  // 1. Curated track for an iconic theme.
  const curated = CURATED_TRACKS.find((c) => c.match.test(query));
  if (curated) {
    const t = await fetchTrack(jamendoUrl({ id: curated.trackId }));
    if (t) return t;
  }

  // 2. Tag filter (refined by the free-text query) — much more on-target.
  const tagged = KEYWORD_TO_TAG.find((m) => m.match.test(query));
  if (tagged) {
    const t = await fetchTrack(jamendoUrl({ tags: tagged.tag, search: query }));
    if (t) return t;
  }

  // 3. Fall back to plain free-text search.
  return fetchTrack(jamendoUrl({ search: query }));
}

// Resolves a free-text music query to a playable R2-hosted MP3 URL: finds a
// royalty-free instrumental on Jamendo (curated track → tag filter → search),
// downloads it and re-hosts on R2 so Shotstack can fetch it reliably. Cached
// by query. Returns null on any failure (caller falls back).
export async function resolveMusicUrl(jobId: string, query: string): Promise<string | null> {
  const key = query.toLowerCase().trim();
  if (!key) return null;
  const cached = resolved.get(key);
  if (cached) return cached;

  try {
    const track = await searchJamendo(key);
    if (!track || !track.audio || !track.id) {
      logger.warn({ jobId, query }, "no Jamendo match for music query");
      return null;
    }
    logger.info(
      { jobId, query, trackId: track.id, name: track.name, artist: track.artist_name },
      "resolving music track from Jamendo",
    );
    const audioRes = await fetch(track.audio);
    if (!audioRes.ok || !audioRes.body) {
      logger.warn({ jobId, query, status: audioRes.status }, "failed to fetch Jamendo audio");
      return null;
    }
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_TRACK_BYTES) {
      logger.warn({ jobId, query, bytes: buf.length }, "Jamendo audio empty or too large");
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
    logger.info({ jobId, query, r2Key, bytes: buf.length }, "music track re-hosted on R2");
    return url;
  } catch (err) {
    logger.warn(
      { jobId, query, err: err instanceof Error ? err.message : String(err) },
      "music resolve failed",
    );
    return null;
  }
}
