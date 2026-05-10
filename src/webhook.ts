import { Router, type Request, type Response } from "express";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { LinqWebhookPayload } from "./schemas.js";

export const webhookRouter = Router();

webhookRouter.post("/webhook", async (req: Request, res: Response) => {
  // Day 2 TODO: verify X-Webhook-Signature HMAC over `{timestamp}.{raw_body}`
  // before parsing JSON. Requires switching this route to express.raw().
  const parsed = LinqWebhookPayload.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten().fieldErrors }, "webhook payload invalid");
    return res.status(400).json({
      error: "invalid payload",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const payload = parsed.data;

  try {
    const job = await prisma.job.upsert({
      where: { externalId: payload.event_id },
      create: {
        externalId: payload.event_id,
        state: "received",
        payload: payload as object,
      },
      update: {},
    });
    logger.info(
      { jobId: job.id, externalId: payload.event_id, state: job.state },
      "webhook accepted",
    );
    return res.status(200).json({ jobId: job.id });
  } catch (err) {
    logger.error({ err, externalId: payload.event_id }, "webhook upsert failed");
    return res.status(500).json({ error: "internal error" });
  }
});
