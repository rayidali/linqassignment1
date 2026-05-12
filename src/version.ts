import { execSync } from "node:child_process";
import { env } from "./env.js";

function resolveCommit(): string {
  if (env.RENDER_GIT_COMMIT) return env.RENDER_GIT_COMMIT;
  // Local dev fallback — Render always sets RENDER_GIT_COMMIT in prod.
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const commit = resolveCommit();

export const version = {
  commit,
  shortCommit: commit === "unknown" ? "unknown" : commit.slice(0, 7),
  branch: env.RENDER_GIT_BRANCH ?? null,
  startedAt: new Date().toISOString(),
};
