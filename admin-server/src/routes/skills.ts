// 技能目录 CRUD 路由（ADR-015 §1 技能可编辑化）：
//   GET    /config/skills           列表（不含 body）
//   GET    /config/skills/:name     取单个技能全文（编辑器用）
//   POST   /config/skills           新建技能（写 SKILL.md，不 apply）
//   PUT    /config/skills/:name     编辑技能（name 不可改，不 apply）
//   DELETE /config/skills/:name     删除技能（被引用时 409 SKILL_IN_USE）
//
// 技能 CRUD 仅写 $STATE_DIR/skills/<name>/SKILL.md，不改 openclaw.json/store，故同步响应、不走 apply job。
// 员工↔技能分配（需 apply）见 routes/agents.ts 的 GET/PUT /config/agents/:id/skills。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import {
  SKILL_NAME_RE,
  createSkill,
  deleteSkill,
  getSkill,
  listSkillMetas,
  updateSkill,
  type SkillRole,
} from "../services/skills.js";

export const skillsRouter = Router();

const RoleSchema = z.enum(["employee", "admin"]);

const CreateSchema = z.object({
  name: z.string().trim().regex(SKILL_NAME_RE, "技能 ID 非法"),
  description: z.string().trim().min(1, "description 不能为空").max(500),
  requiredRole: RoleSchema.optional(),
  requiresKnowledge: z.boolean().optional(),
  body: z.string().optional(),
});

const UpdateSchema = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  requiredRole: RoleSchema.nullable().optional(),
  requiresKnowledge: z.boolean().optional(),
  body: z.string().optional(),
});

skillsRouter.get("/config/skills", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ skills: listSkillMetas() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

skillsRouter.get("/config/skills/:name", requireRole("ops"), (req: Request, res: Response) => {
  const name = String(req.params.name);
  const skill = getSkill(name);
  if (!skill) return res.status(404).json({ error: `技能不存在：${name}` });
  res.json({ skill });
});

skillsRouter.post("/config/skills", requireRole("ops"), (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  const operator = req.user?.platformUserId || "";
  try {
    const skill = createSkill({
      name: parsed.data.name,
      description: parsed.data.description,
      requiredRole: parsed.data.requiredRole as SkillRole | undefined,
      requiresKnowledge: parsed.data.requiresKnowledge,
      body: parsed.data.body ?? "",
    });
    appendAuditLog("skill.create", skill.name, {
      name: skill.name,
      description: skill.description,
      requiredRole: skill.requiredRole,
      requiresKnowledge: skill.requiresKnowledge,
      operator,
    });
    res.status(201).json({ skill });
  } catch (err) {
    const message = (err as Error).message;
    res.status(/已存在|非法/.test(message) ? 409 : 400).json({ error: message });
  }
});

skillsRouter.put("/config/skills/:name", requireRole("ops"), (req: Request, res: Response) => {
  const name = String(req.params.name);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  const operator = req.user?.platformUserId || "";
  try {
    const skill = updateSkill(name, {
      description: parsed.data.description,
      requiredRole: parsed.data.requiredRole as SkillRole | null | undefined,
      requiresKnowledge: parsed.data.requiresKnowledge,
      body: parsed.data.body,
    });
    appendAuditLog("skill.update", skill.name, {
      name: skill.name,
      description: skill.description,
      requiredRole: skill.requiredRole,
      requiresKnowledge: skill.requiresKnowledge,
      operator,
    });
    res.json({ skill });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.startsWith("技能不存在") ? 404 : 400).json({ error: message });
  }
});

skillsRouter.delete("/config/skills/:name", requireRole("ops"), (req: Request, res: Response) => {
  const name = String(req.params.name);
  const operator = req.user?.platformUserId || "";
  try {
    const { referencedBy } = deleteSkill(name);
    appendAuditLog("skill.delete", name, { name, referencedBy, operator });
    res.json({ deleted: { name } });
  } catch (err) {
    const e = err as Error & { referencedBy?: string[] };
    const message = e.message;
    if (message.startsWith("SKILL_IN_USE")) {
      return res.status(409).json({
        error: `技能被以下数字员工引用，请先在「技能配置」页解绑：${e.referencedBy?.join(", ") || ""}`,
        code: "SKILL_IN_USE",
        referencedBy: e.referencedBy ?? [],
      });
    }
    res.status(message.startsWith("技能不存在") ? 404 : 400).json({ error: message });
  }
});
