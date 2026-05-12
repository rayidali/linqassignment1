import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { version } from "./version.js";
import { getContactCard } from "./services/contact-card.js";

export const adminRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization");
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

adminRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Unauthenticated on purpose: lets you confirm which build is live with a
// plain curl (no secret needed) — kills the "am I testing a stale deploy?" doubt.
adminRouter.get("/version", (_req, res) => {
  res.json(version);
});

adminRouter.get("/admin/jobs", requireAdmin, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(jobs);
});

adminRouter.get("/admin/jobs/:id", requireAdmin, async (req: Request, res: Response) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

// Shows the contact card Linq currently has for our number (debug "is it iEdit / active?").
adminRouter.get("/admin/contact-card", requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await getContactCard());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
