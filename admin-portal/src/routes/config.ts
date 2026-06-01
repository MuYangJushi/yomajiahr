// 配置应用路由（P0 基石 B：触发流水线 + 查结果）。
// 当前由共享 token 守卫；平台级 RBAC 为已知缺口，留待后续补强。
import { Router, type Request, type Response } from "express";
import { readLastResult, triggerApply } from "../../lib/config-apply.mjs";
import { REPO_DIR, STATE_DIR } from "../config.js";

export const configRouter = Router();

configRouter.post("/config/apply", async (_req: Request, res: Response) => {
  try {
    const result = await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR });
    const code = result.status === "success" ? 200 : result.status === "failed" ? 422 : 202;
    res.status(code).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

configRouter.get("/config/apply/result", (_req: Request, res: Response) => {
  const result = readLastResult(STATE_DIR);
  if (!result) return res.status(404).json({ status: "none", message: "尚无 apply 结果" });
  res.json(result);
});
