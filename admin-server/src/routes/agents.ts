// 数字员工配置路由（P1 支柱一）：列表 / 新建 / 修改 / 删除 / 技能 / 渠道。
import { Router, type Request, type Response } from "express";
import { deleteAgent, listAgents, updateAgent } from "../services/orchestrator.js";
import { cancelOnboarding, getOnboarding, startOnboarding } from "../services/onboarding.js";
import { listSkills } from "../services/workspace.js";
import { envKeysSet } from "../services/secrets.js";
import { readStore } from "../services/store.js";
import { requireRole } from "../auth/rbac.js";
import { rateLimit } from "../middleware.js";
import { appendAuditLog } from "../util.js";

export const agentsRouter = Router();

// 支持的渠道域（来自 base 脚手架；P1 固定两类）
const SUPPORTED_CHANNELS = ["feishu", "dingtalk-connector"];
const onboardingLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "扫码创建请求过于频繁，请稍后再试" });

agentsRouter.get("/config/agents", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ agents: listAgents() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

agentsRouter.post("/config/agents", requireRole("admin"), async (req: Request, res: Response) => {
  res.status(410).json({ error: "请使用 /config/agent-onboarding 创建数字员工" });
});

agentsRouter.put("/config/agents/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const result = await updateAgent(id, req.body);
    appendAuditLog("agent.update", id, {
      agent_id: id,
      name: result.agent.name,
      role: result.agent.role,
      skills: result.agent.skills,
      operator: req.user?.platformUserId || "",
    });
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.startsWith("agent 不存在") ? 404 : 400).json({ error: message });
  }
});

agentsRouter.delete("/config/agents/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const result = await deleteAgent(id);
    appendAuditLog("agent.delete", id, {
      agent_id: id,
      operator: req.user?.platformUserId || "",
    });
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.startsWith("agent 不存在") ? 404 : 409).json({ error: message });
  }
});

agentsRouter.post("/config/agent-onboarding", requireRole("admin"), onboardingLimiter, (req: Request, res: Response) => {
  try {
    res.status(202).json(startOnboarding(req.user!.platformUserId, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

agentsRouter.get("/config/agent-onboarding/:id", requireRole("admin"), (req: Request, res: Response) => {
  const session = getOnboarding(req.user!.platformUserId, String(req.params.id));
  if (!session) return res.status(404).json({ error: "会话不存在或已过期" });
  res.json(session);
});

agentsRouter.delete("/config/agent-onboarding/:id", requireRole("admin"), (req: Request, res: Response) => {
  try {
    const session = cancelOnboarding(req.user!.platformUserId, String(req.params.id));
    if (!session) return res.status(404).json({ error: "会话不存在或已过期" });
    res.json(session);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
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
