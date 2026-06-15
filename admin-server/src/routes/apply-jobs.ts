// 异步 apply 任务状态查询路由（fix/usage-bugs #1）。
// 写操作（agent / channel / knowledge）从同步 200 改为 202 + jobId；前端 polling 这里。
import { Router, type Request, type Response } from "express";
import { requireRole } from "../auth/rbac.js";
import { getApplyJob } from "../services/apply-jobs.js";

export const applyJobsRouter = Router();

applyJobsRouter.get("/config/apply-jobs/:id", requireRole("ops"), (req: Request, res: Response) => {
  const job = getApplyJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: "任务不存在或已过期" });
  // result 体可能很大（agent + apply 详情），保留——前端拿到终态后立刻消费。
  res.json(job);
});
