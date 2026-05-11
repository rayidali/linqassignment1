import express, { Router, type Request, type Response } from "express";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { LinqWebhookPayload } from "./schemas.js";
import { env } from "./env.js";
import { verifyLinqSignature } from "./linq-signature.js";

export const webhookRouter = Router();

// IMPORTANT: HMAC verification needs the original, unparsed bytes — we cannot
// re-serialize after express.json() because whitespace/key order differences
// would invalidate the signature. Apply express.raw() ONLY to this route,
// before any global JSON parser.
webhookRouter.post(
  "/webhook",
  express.raw({ type: "*/*", limit: "5mb" }),
  async (req: Request, res: Response) => {
    const rawBody = (req.body instanceof Buffer ? req.body : Buffer.alloc(0)) as Buffer;

    if (env.LINQ_WEBHOOK_SECRET) {
      const result = verifyLinqSignature(rawBody, req.headers, env.LINQ_WEBHOOK_SECRET);
      if (!result.ok) {
        logger.warn(
          { reason: result.reason, headers: req.headers },
          "webhook signature verification failed",
        );
        return res.status(401).json({ error: "invalid signature", reason: result.reason });
      }
    } else {
      logger.warn("LINQ_WEBHOOK_SECRET not set — accepting webhook without verification");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString("utf8"));
    } catch {
      logger.warn({ bodyLen: rawBody.length }, "webhook body not valid JSON");
      return res.status(400).json({ error: "invalid JSON" });
    }

    const parsed = LinqWebhookPayload.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { errors: parsed.error.flatten().fieldErrors, sampleBody: typeof raw === "object" ? raw : null },
        "webhook payload invalid",
      );
      return res.status(400).json({
        error: "invalid payload",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const data = parsed.data;

    try {
      const job = await prisma.job.upsert({
        where: { externalId: data.event_id },
        create: {
          externalId: data.event_id,
          state: "received",
          payload: data as object,
        },
        update: {},
      });
      logger.info(
        { jobId: job.id, externalId: data.event_id, state: job.state },
        "webhook accepted",
      );
      return res.status(200).json({ jobId: job.id });
    } catch (err) {
      logger.error({ err, externalId: data.event_id }, "webhook upsert failed");
      return res.status(500).json({ error: "internal error" });
    }
  },
);
