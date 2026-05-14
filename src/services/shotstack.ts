import { env } from "../env.js";
import { logger } from "../logger.js";
import { fetchWithTimeout } from "../http.js";

// "stage" (free sandbox, watermarked) or "v1" (production) — from the env.
const SHOTSTACK_ENV = env.SHOTSTACK_ENV;

function shotstackUrl(path: string): string {
  return `https://api.shotstack.io/${SHOTSTACK_ENV}/${path}`;
}

function authHeaders(): Record<string, string> {
  if (!env.SHOTSTACK_API_KEY) {
    throw new Error("SHOTSTACK_API_KEY not set");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": env.SHOTSTACK_API_KEY,
  };
}

export async function submitRender(jobId: string, edit: unknown): Promise<string> {
  const body = JSON.stringify(edit);
  logger.info({ jobId, editBytes: body.length }, "submitting render to Shotstack");

  const res = await fetchWithTimeout(shotstackUrl("render"), {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; response?: { id?: string }; message?: string }
    | null;

  if (!res.ok || !data?.response?.id) {
    throw new Error(
      `Shotstack render submit failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }
  logger.info({ jobId, renderId: data.response.id }, "Shotstack render queued");
  return data.response.id;
}

// In-progress Shotstack states (between submit and done). Used by the state
// machine to drive accurate user-facing progress messages — `fetching` ≈ 25 %,
// `rendering` ≈ 50 %, `saving` ≈ 75 %. These are the only ground-truth signals
// Shotstack exposes; there's no ETA or numeric progress field on the API.
export const SHOTSTACK_PROGRESS_STAGES = ["queued", "fetching", "rendering", "saving"] as const;
export type ShotstackProgressStage = (typeof SHOTSTACK_PROGRESS_STAGES)[number];

export type ShotstackStatus =
  | { status: ShotstackProgressStage; created?: string; updated?: string }
  | { status: "done"; url: string; created?: string; updated?: string }
  | { status: "failed"; error: string; created?: string; updated?: string };

export async function pollRender(jobId: string, renderId: string): Promise<ShotstackStatus> {
  const res = await fetchWithTimeout(shotstackUrl(`render/${renderId}`), {
    headers: { "x-api-key": env.SHOTSTACK_API_KEY ?? "" },
  });
  const data = (await res.json().catch(() => null)) as
    | { response?: { status?: string; url?: string; error?: string; created?: string; updated?: string } }
    | null;

  if (!res.ok || !data?.response?.status) {
    throw new Error(
      `Shotstack render status failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }
  const status = data.response.status;
  const created = data.response.created;
  const updated = data.response.updated;
  logger.info({ jobId, renderId, shotstackStatus: status, created, updated }, "polled Shotstack");

  if (status === "done") {
    if (!data.response.url) {
      throw new Error("Shotstack render done but no URL in response");
    }
    return { status: "done", url: data.response.url, created, updated };
  }
  if (status === "failed") {
    return { status: "failed", error: data.response.error ?? "unknown", created, updated };
  }
  return { status: status as ShotstackProgressStage, created, updated };
}
