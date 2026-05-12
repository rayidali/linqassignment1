import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getR2Client, getR2Bucket, r2PublicUrl } from "../r2.js";

const JAMENDO_API = "https://api.jamendo.com/v3.0";
const MAX_TRACK_BYTES = 20 * 1024 * 1024;

// query (lowercased) -> resolved R2 URL. Only successes are cached, so a
// transient Jamendo failure is retried next time.
const resolved = new Map<string, string>();

type JamendoTrack = {
  id?: string;
  name?: string;
  artist_name?: string;
  audio?: string;
};

async function searchJamendo(query: string): Promise<JamendoTrack | null> {
  if (!env.JAMENDO_CLIENT_ID) return null;
  const url = new URL(`${JAMENDO_API}/tracks/`);
  url.searchParams.set("client_id", env.JAMENDO_CLIENT_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("search", query);
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("vocalinstrumental", "instrumental");
  url.searchParams.set("order", "popularity_total");
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { results?: JamendoTrack[] } | null;
  const track = data?.results?.[0];
  return track && track.audio && track.id ? track : null;
}

// Resolves a free-text music query (a genre/mood, or a distilled user request)
// to a playable R2-hosted MP3 URL: searches Jamendo (royalty-free), downloads
// the top instrumental match, re-hosts on R2 so Shotstack can fetch it
// reliably. Cached by query. Returns null on any failure (caller falls back).
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
