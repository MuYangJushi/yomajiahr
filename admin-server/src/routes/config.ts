// 配置应用路由（P0 基石 B：触发流水线 + 查结果）。
// RBAC（决策六）：apply（重启网关）属高危特权 → admin；查结果 → ops。
import { Router, type Request, type Response } from "express";
import { readLastResult, triggerApply } from "../services/config-apply.js";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { requireRole } from "../auth/rbac.js";

export const configRouter = Router();

configRouter.post("/config/apply", requireRole("admin"), async (_req: Request, res: Response) => {
  try {
    const result = await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR });
    const code = result.status === "success" ? 200 : result.status === "failed" ? 422 : 202;
    res.status(code).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

configRouter.get("/config/apply/result", requireRole("ops"), (_req: Request, res: Response) => {
  const result = readLastResult(STATE_DIR);
  if (!result) return res.status(404).json({ status: "none", message: "尚无 apply 结果" });
  res.json(result);
});
