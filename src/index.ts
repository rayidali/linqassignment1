import express from "express";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { webhookRouter } from "./webhook.js";
import { adminRouter } from "./admin.js";
import { startWorker, stopWorker, recoverStaleClaims } from "./worker.js";
import { prisma } from "./db.js";

async function main() {
  const recovered = await recoverStaleClaims();
  logger.info({ recovered }, "boot recovery complete");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(webhookRouter);
  app.use(adminRouter);

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
    startWorker();
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown signal received");
    server.close();
    await stopWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
