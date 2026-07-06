// 配置应用路由（P0 基石 B：触发流水线 + 查结果）。
// RBAC（决策六）：apply（重启网关）属高危特权 → admin；查结果 → ops。
import { Router, type Request, type Response } from "express";
import { readLastResult, triggerApply } from "../services/config-apply.js";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { requireRole } from "../auth/rbac.js";

export const configRouter = Router();

configRouter.post("/config/apply", requireRole("admin"), async (_req: Request, res: Response) => {
  try {
    const result = await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "restart", operation: "gateway.restart" });
    const code = result.status === "success" ? 200 : result.status === "failed" ? 422 : 202;
    res.status(code).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

configRouter.get("/config/apply/result", requireRole("ops"), (req: Request, res: Response) => {
  const result = readLastResult(STATE_DIR);
  if (!result) return res.status(404).json({ status: "none", message: "尚无 apply 结果" });
  // ?requestId= 精确查询：结果文件只存最近一次，若已被后续请求覆盖则该请求终态不可考，如实返回 pending。
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId : undefined;
  if (requestId && result.requestId !== requestId) {
    return res.status(202).json({ status: "pending", requestId, message: "指定请求的结果尚未返回（或已被后续 apply 覆盖）" });
  }
  res.json(result);
});
