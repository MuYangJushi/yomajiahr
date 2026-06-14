// AI 档案共创路由（ADR-013 #59+#60）。
// POST /api/config/agent-profile/generate
//   入参：{ jobTitle: string, hints?: string, role?: 'employee'|'admin' }
//   出参：{ profile: { jobTitle, responsibilities, personality, tone, boundaries } }
// 写 AGENT_PROFILE_GENERATE 审计；调用前需要 ops 角色；调用方不直接生成 agent。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateAgentProfile } from "../services/agent-profile.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";

export const agentProfileRouter = Router();

const GenerateInputSchema = z.object({
  jobTitle: z.string().trim().min(1, "jobTitle 不能为空").max(60, "jobTitle 太长"),
  hints: z.string().trim().max(400, "hints 太长").optional(),
  role: z.enum(["employee", "admin"]).optional(),
});

agentProfileRouter.post(
  "/config/agent-profile/generate",
  requireRole("ops"),
  async (req: Request, res: Response) => {
    const parsed = GenerateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
    }
    try {
      const profile = await generateAgentProfile(parsed.data);
      appendAuditLog("agent.profile.generate", "agent-profile", {
        job_title: parsed.data.jobTitle,
        role: parsed.data.role,
        operator: req.user?.platformUserId || "",
      });
      res.json({ profile });
    } catch (err) {
      // 任何上游错误一律 502（model/LLM 不可用），message 可读
      res.status(502).json({ error: (err as Error).message });
    }
  },
);
