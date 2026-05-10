import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "./db.js";
import { env } from "./env.js";

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
