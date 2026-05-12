import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { sendTextReply } from "./services/linq.js";
import { advance, type JobRow } from "./state.js";

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TICK_INTERVAL_MS = 1000;
const CLAIM_TIMEOUT_MS = 60_000;

// States the worker won't claim: terminal (delivered/replied/failed) plus
// awaiting_clarification (parked until the user replies). Kept in sync with
// state.ts WORKER_SKIP_STATES — small and stable, so inlined in SQL below.

let tickHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let shuttingDown = false;

async function claimOneJob(): Promise<JobRow | null> {
  // Atomic claim in a single statement.
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE "Job"
    SET "claimedAt" = NOW(), "claimedBy" = ${WORKER_ID}
    WHERE id = (
      SELECT id FROM "Job"
      WHERE state NOT IN ('delivered', 'replied', 'failed', 'awaiting_clarification')
        AND ("claimedAt" IS NULL OR "claimedAt" < NOW() - INTERVAL '60 seconds')
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, "chatId", state, payload, result
  `;
  return rows[0] ?? null;
}

async function notifyVideoFailure(job: JobRow, errorMsg: string): Promise<void> {
  if (job.type !== "video" || !job.chatId) return;
  const friendly = /no editable|no media/i.test(errorMsg)
    ? "i can only edit videos and photos rn, send me one of those"
    : "ah that one broke on me, mind trying again? lmk if it keeps happening";
  await sendTextReply(job.chatId, friendly, `${job.id}-fail`).catch((e) => {
    logger.warn(
      { jobId: job.id, err: e instanceof Error ? e.message : String(e) },
      "failed to send failure notice to user",
    );
  });
}

async function runTick(): Promise<void> {
  if (tickInFlight || shuttingDown) return;
  tickInFlight = true;
  try {
    const job = await claimOneJob();
    if (!job) return;

    try {
      const advanceResult = await advance(job);
      const mergedResult = {
        ...((job.result as Record<string, unknown> | null) ?? {}),
        ...(advanceResult.resultPatch ?? {}),
      };
      await prisma.job.update({
        where: { id: job.id },
        data: {
          state: advanceResult.nextState,
          result: mergedResult as object,
          error: advanceResult.error ?? null,
          claimedAt: null,
          claimedBy: null,
        },
      });
      if (advanceResult.nextState !== job.state) {
        logger.info(
          { jobId: job.id, from: job.state, to: advanceResult.nextState },
          "state transition",
        );
      }
      if (advanceResult.nextState === "failed") {
        await notifyVideoFailure(job, advanceResult.error ?? "unknown");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, state: job.state, err: message }, "advance threw");
      await prisma.job.update({
        where: { id: job.id },
        data: {
          state: "failed",
          error: message,
          claimedAt: null,
          claimedBy: null,
        },
      });
      await notifyVideoFailure(job, message);
    }
  } catch (err) {
    logger.error({ err }, "tick failed before claim");
  } finally {
    tickInFlight = false;
  }
}

export function startWorker(): void {
  if (tickHandle) return;
  logger.info({ workerId: WORKER_ID, tickMs: TICK_INTERVAL_MS }, "worker starting");
  tickHandle = setInterval(() => {
    void runTick();
  }, TICK_INTERVAL_MS);
}

export async function stopWorker(): Promise<void> {
  shuttingDown = true;
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  let waited = 0;
  while (tickInFlight && waited < 10_000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  logger.info("worker stopped");
}

export async function recoverStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const result = await prisma.job.updateMany({
    where: {
      claimedAt: { lt: cutoff },
      state: { notIn: ["delivered", "replied", "failed", "awaiting_clarification"] },
    },
    data: { claimedAt: null, claimedBy: null },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, "released stale claims");
  }
  return result.count;
}
