// Node's global fetch has NO default timeout — a hung connection blocks
// forever. Combined with the worker's single-tick-in-flight guard, one stuck
// request would freeze the whole worker. Wrap every external request with an
// abort timeout so a wedged connection fails fast instead of hanging.

export const API_TIMEOUT_MS = 20_000; // JSON API calls (Shotstack, Linq, Jamendo metadata)
export const MEDIA_TIMEOUT_MS = 90_000; // up/downloading media bytes (clips, music, render output)

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep full url */
      }
      throw new Error(`request to ${host} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
