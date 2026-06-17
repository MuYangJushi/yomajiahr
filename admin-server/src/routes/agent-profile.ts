// AI 档案共创路由（ADR-013 #59+#60）。
// POST /api/config/agent-profile/generate
//   入参：{ jobTitle: string, hints?: string, role?: 'employee'|'admin' }
//   出参：{ profile: { jobTitle, responsibilities, personality, tone, boundaries } }
// 写 AGENT_PROFILE_GENERATE 审计；调用前需要 ops 角色；调用方不直接生成 agent。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateAgentProfile, PROFILE_FIELDS } from "../services/agent-profile.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";

export const agentProfileRouter = Router();

const GenerateInputSchema = z.object({
  jobTitle: z.string().trim().min(1, "jobTitle 不能为空").max(60, "jobTitle 太长"),
  hints: z.string().trim().max(400, "hints 太长").optional(),
  fields: z.array(z.enum(PROFILE_FIELDS)).min(1).optional(),
});

agentProfileRouter.post(
  "/config/agent-profile/generate",
  requireRole("ops"),
  async (req: Request, res: Response) => {
    const parsed = GenerateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "入参非法";
      // 同时返 error/message，避免前端读 .message 时拿不到（旧 EditAgentModal 即此症状）。
      return res.status(400).json({ error: msg, message: msg });
    }
    const startedAt = Date.now();
    try {
      const generated = await generateAgentProfile(parsed.data);
      const profile = parsed.data.fields
        ? Object.fromEntries(parsed.data.fields.map((field) => [field, generated[field]]))
        : generated;
      appendAuditLog("agent.profile.generate", "agent-profile", {
        fields: parsed.data.fields || PROFILE_FIELDS,
        duration_ms: Date.now() - startedAt,
        success: true,
        operator: req.user?.platformUserId || "",
      });
      res.json({ profile });
    } catch (err) {
      appendAuditLog("agent.profile.generate", "agent-profile", {
        fields: parsed.data.fields || PROFILE_FIELDS,
        duration_ms: Date.now() - startedAt,
        success: false,
        operator: req.user?.platformUserId || "",
      });
      res.status(503).json({ error: "PROFILE_GENERATE_UNAVAILABLE", message: (err as Error).message });
    }
  },
);
