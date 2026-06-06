// 数字员工配置路由（P1 支柱一）：列表 / 新建（原子编排上线）/ 技能 / 渠道。
import { Router, type Request, type Response } from "express";
import { createAgent, listAgents } from "../services/orchestrator.js";
import { listSkills } from "../services/workspace.js";
import { envKeysSet } from "../services/secrets.js";
import { readStore } from "../services/store.js";
import { requireRole } from "../auth/rbac.js";

export const agentsRouter = Router();

// 支持的渠道域（来自 base 脚手架；P1 固定两类）
const SUPPORTED_CHANNELS = ["feishu", "dingtalk-connector"];

agentsRouter.get("/config/agents", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ agents: listAgents() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

agentsRouter.post("/config/agents", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { agent, apply } = await createAgent(req.body);
    res.status(apply.status === "success" ? 201 : 422).json({ agent, apply });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

agentsRouter.get("/config/skills", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ skills: listSkills() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

agentsRouter.get("/config/channels", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    const { channels } = readStore();
    const keys = envKeysSet();
    const result: Record<string, { accounts: string[] }> = {};
    for (const domain of SUPPORTED_CHANNELS) {
      result[domain] = { accounts: Object.keys(channels[domain] || {}) };
    }
    res.json({ supported: SUPPORTED_CHANNELS, channels: result, env_keys: [...keys] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
