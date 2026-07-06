// 交互分析路由（Sprint 10 #34，支柱三）。只读聚合，audit 级即可见（与审计台账同级）。
import { Router, type Request, type Response } from "express";
import { requireRole } from "../auth/rbac.js";
import { summarizeInteractions } from "../services/interactions.js";

export const interactionsRouter = Router();

interactionsRouter.get("/interactions/summary", requireRole("audit"), (req: Request, res: Response) => {
  try {
    const since = typeof req.query.since === "string" && /^\d{8}$/.test(req.query.since) ? req.query.since : undefined;
    res.json(summarizeInteractions(since));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
