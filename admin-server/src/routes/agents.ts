// 数字员工配置路由（P1 支柱一）：列表 / 新建 / 修改 / 删除 / 技能 / 渠道。
// ADR-013：recruit / skill-config / channel-bind 拆为三个独立生命周期。
//   - POST   /config/agents                 → 仅创建数字员工档案（createAgentProfile，允许空 skills 无渠道）
//   - PUT    /config/agents/:id             → 仅改档案（updateAgentProfile，去掉 addChannel/removeChannels）
//   - POST   /config/agents/:id/channels    → 绑定渠道（bindAgentToChannel）
//   - DELETE /config/agents/:id/channels/:domain/:accountId → 解绑（unbindAgentFromChannel）
//   - 旧 updateAgent 仍保留以供历史调用方兼容（不被 router 直接暴露）。
import { Router, type Request, type Response } from "express";
import {
  bindAgentToChannel,
  createAgentProfile,
  deleteAgent,
  listAgents,
  unbindAgentFromChannel,
  updateAgentProfile,
} from "../services/orchestrator.js";
import { listAgentTemplates } from "../services/agent-templates.js";
import { enqueueApplyJob } from "../services/apply-jobs.js";
import { cancelOnboarding, getOnboarding, startChannelOnboarding, startOnboarding } from "../services/onboarding.js";
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

// 系统自带数字员工模板（空白起步 + 从模板创建）。只读建议值，创建仍走 POST /config/agents。
agentsRouter.get("/config/agent-templates", requireRole("ops"), (_req: Request, res: Response) => {
  res.json({ templates: listAgentTemplates() });
});

// 仅创建数字员工档案（ADR-013 #58）。允许空 skills / 无渠道；状态显示"待配置"。
//
// 异步化（fix/usage-bugs #1）：HTTP 立即 202 + jobId；后台跑 createAgentProfile（含 triggerApply）。
// 校验类错误（id 已存在 / role 越权）需要立刻 400/403，所以走 Promise.race(800ms)：早完成的同步报；
// 没完成（apply 在跑）就返回 202 让前端轮询 GET /config/apply-jobs/:id。
agentsRouter.post("/config/agents", requireRole("ops"), async (req: Request, res: Response) => {
  try {
    const { skills, channels, ...profileInput } = req.body || {};
    if (skills !== undefined || channels !== undefined) {
      return res.status(400).json({ error: "招募接口不接受 skills/channels；请在独立生命周期中配置" });
    }
    const role = profileInput.role ?? "employee";
    if (role === "admin" && req.user?.platformRole !== "admin") {
      return res.status(403).json({ error: "仅平台管理员可授予 admin 系统权限" });
    }
    const operator = req.user?.platformUserId || "";
    const { jobId, promise } = enqueueApplyJob(
      async () => {
        const result = await createAgentProfile({ ...profileInput, role });
        appendAuditLog("agent.create", result.agent.id, {
          agent_id: result.agent.id,
          name: result.agent.name,
          role: result.agent.role,
          skills: result.agent.skills,
          operator,
        });
        return result;
      },
      "agent.create",
    );
    // 800ms 内完成：直接 201 兼容旧客户端；否则交给前端轮询 jobId。
    const raced = await Promise.race([
      promise.then((r) => ({ kind: "done" as const, value: r })).catch((err: Error) => ({ kind: "error" as const, err })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 800)),
    ]);
    if (raced.kind === "done") return res.status(201).json({ ...raced.value, jobId });
    if (raced.kind === "error") {
      const message = raced.err.message;
      const status = /agent id 已存在|workspace 已存在/.test(message) ? 409 : 400;
      return res.status(status).json({ error: message, jobId });
    }
    res.status(202).json({ jobId, status: "running" });
  } catch (err) {
    const message = (err as Error).message;
    const status = /agent id 已存在|workspace 已存在/.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

// 仅修改数字员工档案（ADR-013 #58）。技能分配/取消：调用方走技能配置接口（下一份 ADR）。异步 apply。
agentsRouter.put("/config/agents/:id", requireRole("ops"), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { skills, channels, addChannel, removeChannels, ...profileInput } = req.body || {};
    if ([skills, channels, addChannel, removeChannels].some((value) => value !== undefined)) {
      return res.status(400).json({ error: "员工资料接口不接受技能或渠道变更" });
    }
    if (profileInput.role === "admin" && req.user?.platformRole !== "admin") {
      return res.status(403).json({ error: "仅平台管理员可授予 admin 系统权限" });
    }
    const operator = req.user?.platformUserId || "";
    const { jobId, promise } = enqueueApplyJob(
      async () => {
        const result = await updateAgentProfile(id, profileInput);
        appendAuditLog("agent.update", id, {
          agent_id: id,
          name: result.agent.name,
          role: result.agent.role,
          skills: result.agent.skills,
          operator,
        });
        return result;
      },
      "agent.update",
    );
    const raced = await Promise.race([
      promise.then((r) => ({ kind: "done" as const, value: r })).catch((err: Error) => ({ kind: "error" as const, err })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 800)),
    ]);
    if (raced.kind === "done") return res.json({ ...raced.value, jobId });
    if (raced.kind === "error") {
      const message = raced.err.message;
      return res.status(message.startsWith("agent 不存在") ? 404 : 400).json({ error: message, jobId });
    }
    res.status(202).json({ jobId, status: "running" });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.startsWith("agent 不存在") ? 404 : 400).json({ error: message });
  }
});

// 渠道绑定（ADR-013 #58）。新账号（带 credentials）或复用现有空闲账号。异步 apply。
agentsRouter.post("/config/agents/:id/channels", requireRole("ops"), onboardingLimiter, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const operator = req.user?.platformUserId || "";
  try {
    const { jobId, promise } = enqueueApplyJob(
      async () => {
        const result = await bindAgentToChannel({ agentId, ...req.body });
        appendAuditLog("agent.channel.bind", agentId, {
          agent_id: agentId,
          domain: req.body?.domain,
          account_id: req.body?.accountId || agentId,
          existing: Boolean(req.body?.existing),
          operator,
        });
        return result;
      },
      "agent.channel.bind",
    );
    const raced = await Promise.race([
      promise.then((r) => ({ kind: "done" as const, value: r })).catch((err: Error) => ({ kind: "error" as const, err })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 800)),
    ]);
    if (raced.kind === "done") return res.status(201).json({ ...raced.value, jobId });
    if (raced.kind === "error") {
      const message = raced.err.message;
      const status = /agent 不存在/.test(message) ? 404 : /已接入|已存在|已被/.test(message) ? 409 : 400;
      return res.status(status).json({ error: message, jobId });
    }
    res.status(202).json({ jobId, status: "running" });
  } catch (err) {
    const message = (err as Error).message;
    const status = /agent 不存在/.test(message) ? 404 : /已接入|已存在|已被/.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

// 渠道解绑（ADR-013 #58）。账号与凭证作为平台资产保留。
agentsRouter.delete("/config/agents/:id/channels/:domain/:accountId", requireRole("ops"), async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const domain = String(req.params.domain);
  const accountId = String(req.params.accountId);
  try {
    const result = await unbindAgentFromChannel(agentId, domain as any, accountId);
    appendAuditLog("agent.channel.unbind", agentId, {
      agent_id: agentId,
      domain,
      account_id: accountId,
      operator: req.user?.platformUserId || "",
    });
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    const status = /未接入|未找到/.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

agentsRouter.delete("/config/agents/:id", requireRole("ops"), async (req: Request, res: Response) => {
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

agentsRouter.post("/config/agent-onboarding", requireRole("ops"), onboardingLimiter, (req: Request, res: Response) => {
  try {
    res.status(202).json(startOnboarding(req.user!.platformUserId, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

agentsRouter.post("/config/agents/:id/channel-onboarding", requireRole("ops"), onboardingLimiter, (req: Request, res: Response) => {
  try {
    res.status(202).json(startChannelOnboarding(req.user!.platformUserId, String(req.params.id), req.body));
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.startsWith("agent 不存在") ? 404 : 400).json({ error: message });
  }
});

agentsRouter.get("/config/agent-onboarding/:id", requireRole("ops"), (req: Request, res: Response) => {
  const session = getOnboarding(req.user!.platformUserId, String(req.params.id));
  if (!session) return res.status(404).json({ error: "会话不存在或已过期" });
  res.json(session);
});

agentsRouter.delete("/config/agent-onboarding/:id", requireRole("ops"), (req: Request, res: Response) => {
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

// 列出渠道账号资产（向 wizard / 渠道管理页提供"已存在账号"选择）。
// 新形态（ADR-013）：channels.json 是顶层数组；按 type 分桶派生 domain→accountId 形态。
agentsRouter.get("/config/channels", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    const { agents, channels, bindings } = readStore();
    const keys = envKeysSet();
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name || agent.id]));
    const result: Record<string, {
      accounts: Array<{ accountId: string; occupied: boolean; occupiedBy?: string; occupiedByName?: string }>;
    }> = {};
    for (const domain of SUPPORTED_CHANNELS) {
      const accounts = channels
        .filter((c) => (domain === "dingtalk-connector" ? c.type === "dingtalk" : c.type === domain))
        .map((c) => {
          const binding = bindings.find(
            (item) => item.match.channel === domain && item.match.accountId === c.id,
          );
          return {
            accountId: c.id,
            displayName: c.displayName,
            enabled: c.enabled !== false,
            occupied: Boolean(binding),
            ...(binding
              ? { occupiedBy: binding.agentId, occupiedByName: agentNames.get(binding.agentId) || binding.agentId }
              : {}),
          };
        });
      result[domain] = { accounts };
    }
    res.json({ supported: SUPPORTED_CHANNELS, channels: result, env_keys: [...keys] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
