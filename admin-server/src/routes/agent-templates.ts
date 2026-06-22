// 员工模板 + 部门路由（ADR-018）。
// - GET    /config/departments              部门注册表
// - POST   /config/agent-templates          新建用户模板（写 overlay.custom）
// - PUT    /config/agent-templates/:id      编辑模板（内置→overlay.overrides；自建→改 overlay.custom）
// - DELETE /config/agent-templates/:id      删除模板（内置→软隐藏；自建→真删）
// - POST   /config/agent-templates/:id/restore  恢复软隐藏的内置模板
//
// GET /config/agent-templates 仍由 routes/agents.ts 提供（保持单一注册点），其内部已调 listAgentTemplates()，
// 合并语义在阶段 2 已落地。
//
// 写操作一律落 audit-log.jsonl（ADR-018 §2.3，与 ADR-015 技能 CRUD 同款）。
// **不做** in-use 检查：模板无运行时引用（招募时只拷 profile，不留 template id 在 agent 上），删除不影响已存在的数字员工。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import { listDepartments } from "../services/departments.js";
import {
  TEMPLATE_ID_RE,
  createAgentTemplate,
  deleteAgentTemplate,
  restoreAgentTemplate,
  updateAgentTemplate,
} from "../services/agent-template-crud.js";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/config/departments", requireRole("ops"), (_req: Request, res: Response) => {
  res.json({ departments: listDepartments() });
});

// —— 入参 schema（ADR-018 §2.3 校验：id 形态、role、profile 必填段、department 在注册表） ——
// 注：department 是否在注册表的校验在 service 层做（注册表运行时可变；schema 层只做形态校验）。
const RoleSchema = z.enum(["employee", "admin"]);

const ProfileSchema = z.object({
  jobTitle: z.string().trim().min(1, "profile.jobTitle 不能为空"),
  responsibilities: z.string().trim().min(1, "profile.responsibilities 不能为空"),
  personality: z.string().trim().min(1, "profile.personality 不能为空"),
  tone: z.string().trim().min(1, "profile.tone 不能为空"),
  boundaries: z.string().trim().min(1, "profile.boundaries 不能为空"),
});

const CreateSchema = z.object({
  id: z.string().trim().regex(TEMPLATE_ID_RE, "模板 id 非法（仅小写字母/数字/连字符，2-64 位）"),
  name: z.string().trim().min(1, "name 不能为空").max(120),
  role: RoleSchema,
  description: z.string().trim().max(500).optional(),
  suggestedId: z.string().trim().regex(TEMPLATE_ID_RE).optional(),
  emoji: z.string().trim().max(16).optional(),
  tags: z.array(z.string().trim()).max(20).optional(),
  category: z.string().trim().max(64).optional(),
  department: z.string().trim().max(64).optional(),
  profile: ProfileSchema,
  suggestedSkills: z.array(z.string().trim()).max(50).optional(),
  defaultSkills: z.array(z.string().trim()).max(50).optional(),
});

// 编辑：所有字段可选；profile 给则整段必填（service 层 ensureProfileComplete）。
const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: RoleSchema.optional(),
  description: z.string().trim().max(500).optional(),
  emoji: z.string().trim().max(16).optional(),
  tags: z.array(z.string().trim()).max(20).optional(),
  category: z.string().trim().max(64).optional(),
  department: z.string().trim().max(64).optional(),
  profile: ProfileSchema.optional(),
  suggestedSkills: z.array(z.string().trim()).max(50).optional(),
  defaultSkills: z.array(z.string().trim()).max(50).optional(),
});

agentTemplatesRouter.post("/config/agent-templates", requireRole("ops"), (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  const operator = req.user?.platformUserId || "";
  try {
    // role=admin 模板要求平台 admin（与 routes/agents.ts POST /config/agents 同款守门）。
    if (parsed.data.role === "admin" && req.user?.platformRole !== "admin") {
      return res.status(403).json({ error: "仅平台管理员可创建 admin 角色模板" });
    }
    const tpl = createAgentTemplate(parsed.data);
    appendAuditLog("agent-template.create", tpl.id, operator, {
      id: tpl.id,
      name: tpl.name,
      role: tpl.role,
      department: tpl.department,
    });
    res.status(201).json({ template: tpl });
  } catch (err) {
    const message = (err as Error).message;
    const status = /已存在|冲突/.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

agentTemplatesRouter.put("/config/agent-templates/:id", requireRole("ops"), (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  const operator = req.user?.platformUserId || "";
  try {
    if (parsed.data.role === "admin" && req.user?.platformRole !== "admin") {
      return res.status(403).json({ error: "仅平台管理员可将模板角色提升为 admin" });
    }
    const tpl = updateAgentTemplate(id, parsed.data);
    appendAuditLog("agent-template.update", id, operator, {
      id,
      name: tpl.name,
      role: tpl.role,
      department: tpl.department,
    });
    res.json({ template: tpl });
  } catch (err) {
    const message = (err as Error).message;
    const status = /不存在/.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

agentTemplatesRouter.delete("/config/agent-templates/:id", requireRole("ops"), (req: Request, res: Response) => {
  const id = String(req.params.id);
  const operator = req.user?.platformUserId || "";
  try {
    const result = deleteAgentTemplate(id);
    appendAuditLog("agent-template.delete", id, operator, {
      id,
      kind: result.kind, // hidden | removed
    });
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    const status = /不存在/.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

// 恢复软隐藏的内置模板（撤销内置删除）。自建模板已真删，无法恢复。
agentTemplatesRouter.post("/config/agent-templates/:id/restore", requireRole("ops"), (req: Request, res: Response) => {
  const id = String(req.params.id);
  const operator = req.user?.platformUserId || "";
  try {
    const tpl = restoreAgentTemplate(id);
    appendAuditLog("agent-template.restore", id, operator, { id });
    res.json({ template: tpl });
  } catch (err) {
    const message = (err as Error).message;
    const status = /不是内置|未被隐藏|不存在/.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
});
