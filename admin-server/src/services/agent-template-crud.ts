// 员工模板 CRUD 服务（ADR-018 §决策 2.3）。
// 写入对象：$STATE_DIR/config-store/agent-templates.json（overlay）。
// **不动**仓库种子目录 workspaces/_templates/agents（会被 install.sh rm -rf+cp -r 覆盖式同步抹平）。
//
// 语义：
// - 创建：写 overlay.custom；id 必须在「可见内置 - hidden + custom」全集中唯一，且不能与 hidden 内置 id 同名（避免软隐藏的内置被同名 custom 假复活）。
// - 编辑：内置 id → 写 overlay.overrides[id]（字段级覆盖，不能改 id/role 以外的稳定标识）；自建 id → 直接改 overlay.custom 对应项。
// - 删除：内置 id → 加 overlay.hidden（软隐藏，可逆）；自建 id → 从 overlay.custom 真删；同时清除该 id 的 overrides 残留。
// - **不做 in-use 检查**：模板无运行时引用——招募时只拷贝 profile 到新 agent workspace，创建后 agent 不保留 template id。
//
// ADR-013/003 守门：role/profile 必填段在此层校验；toolsForRole/工具暴露由生成器在 apply 时盖章，模板无权绕过。
import {
  readAgentTemplateOverlay,
  writeAgentTemplateOverlay,
  type AgentTemplateOverlay,
  type AgentTemplateOverlayEntry,
} from "./store.js";
import {
  listBuiltinAgentTemplates,
  listAgentTemplates,
  type AgentTemplate,
} from "./agent-templates.js";
import { departmentIndex } from "./departments.js";

/** id 校验：与 agent id 同款（letters/digits/dash/underscore），避免文件名/路由非法字符。 */
export const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

const REQUIRED_PROFILE_FIELDS = ["jobTitle", "responsibilities", "personality", "tone", "boundaries"] as const;

export interface CreateAgentTemplateInput {
  id: string;
  name: string;
  role: "employee" | "admin";
  description?: string;
  suggestedId?: string;
  emoji?: string;
  tags?: string[];
  category?: string;
  department?: string;
  profile: {
    jobTitle: string;
    responsibilities: string;
    personality: string;
    tone: string;
    boundaries: string;
  };
  suggestedSkills?: string[];
  defaultSkills?: string[];
}

export type UpdateAgentTemplateInput = Partial<Omit<CreateAgentTemplateInput, "id">>;

function knownDepartmentIds(): Set<string> {
  return new Set(departmentIndex().keys());
}

function ensureProfileComplete(profile: CreateAgentTemplateInput["profile"]): void {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile 缺失");
  }
  for (const k of REQUIRED_PROFILE_FIELDS) {
    const v = (profile as Record<string, unknown>)[k];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`profile.${k} 不能为空`);
    }
  }
}

function ensureValid(input: CreateAgentTemplateInput, opts: { isUpdate?: boolean } = {}): void {
  if (!opts.isUpdate) {
    if (!TEMPLATE_ID_RE.test(input.id)) {
      throw new Error(`模板 id 非法（仅小写字母/数字/连字符，2-64 位）：${input.id}`);
    }
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error("name 不能为空");
  }
  if (input.role !== "employee" && input.role !== "admin") {
    throw new Error(`role 非法：${input.role}（仅 employee/admin）`);
  }
  ensureProfileComplete(input.profile);
  if (input.department !== undefined) {
    if (!knownDepartmentIds().has(input.department)) {
      throw new Error(`department 非法：${input.department}（不在注册表中）`);
    }
  }
}

function builtinIds(): Set<string> {
  return new Set(listBuiltinAgentTemplates().map((t) => t.id));
}

function customIds(overlay: AgentTemplateOverlay): Set<string> {
  return new Set(overlay.custom.map((c) => c.id));
}

/** 新建用户模板（写 overlay.custom）。 */
export function createAgentTemplate(input: CreateAgentTemplateInput): AgentTemplate {
  ensureValid(input);
  const overlay = readAgentTemplateOverlay();
  // id 唯一性：和 builtin（含被 hidden 的）+ custom 都不能撞。
  // 与 hidden 内置撞 → 拒绝（避免「软隐藏的内置」被同名 custom 假装复活，UX 上 confusing）。
  if (builtinIds().has(input.id)) {
    throw new Error(`模板 id 与内置模板冲突：${input.id}（内置即便已隐藏也不能被同名 custom 覆盖；请改用编辑/恢复内置）`);
  }
  if (customIds(overlay).has(input.id)) {
    throw new Error(`模板 id 已存在：${input.id}`);
  }
  const entry: AgentTemplateOverlayEntry = {
    id: input.id,
    name: input.name,
    role: input.role,
    description: input.description ?? "",
    suggestedId: input.suggestedId ?? input.id,
    profile: input.profile,
    suggestedSkills: input.suggestedSkills ?? [],
  };
  if (input.emoji !== undefined) entry.emoji = input.emoji;
  if (input.tags !== undefined) entry.tags = input.tags;
  if (input.category !== undefined) entry.category = input.category;
  if (input.department !== undefined) entry.department = input.department;
  if (input.defaultSkills !== undefined) entry.defaultSkills = input.defaultSkills;

  overlay.custom.push(entry);
  writeAgentTemplateOverlay(overlay);
  // 回读 list 找到刚加的（保证 department 兜底/排序后的最终视图）
  return listAgentTemplates().find((t) => t.id === entry.id)!;
}

/** 编辑模板。内置 → overrides；自建 → 改 custom 对应项；不存在 → 404 抛错。 */
export function updateAgentTemplate(id: string, patch: UpdateAgentTemplateInput): AgentTemplate {
  if (!id || typeof id !== "string") throw new Error("id 不能为空");
  const overlay = readAgentTemplateOverlay();
  const builtins = builtinIds();
  const customIdx = overlay.custom.findIndex((c) => c.id === id);
  const isBuiltin = builtins.has(id);
  if (!isBuiltin && customIdx < 0) {
    throw new Error(`模板不存在：${id}`);
  }
  // 字段校验：先在 patch 上做单字段校验（必填段只在显式给出时校验）。
  if (patch.role !== undefined && patch.role !== "employee" && patch.role !== "admin") {
    throw new Error(`role 非法：${patch.role}（仅 employee/admin）`);
  }
  if (patch.profile !== undefined) {
    // patch 中如果带 profile，要求整段必填齐全（避免半填半留导致 boundaries 被清空）
    ensureProfileComplete(patch.profile as CreateAgentTemplateInput["profile"]);
  }
  if (patch.department !== undefined) {
    if (!knownDepartmentIds().has(patch.department)) {
      throw new Error(`department 非法：${patch.department}`);
    }
  }
  if (isBuiltin) {
    // 写 overrides[id]：仅保留白名单字段，id/suggestedId 不可改（内置稳定标识）
    const cleanPatch: Record<string, unknown> = { ...overlay.overrides[id] };
    const ALLOWED = ["name", "description", "emoji", "tags", "category", "department", "role", "profile", "suggestedSkills", "defaultSkills"] as const;
    for (const k of ALLOWED) {
      if ((patch as Record<string, unknown>)[k] !== undefined) cleanPatch[k] = (patch as Record<string, unknown>)[k];
    }
    overlay.overrides[id] = cleanPatch;
  } else {
    // 自建：直接合并到 custom 项；id 不可改。
    const existing = overlay.custom[customIdx];
    const next: AgentTemplateOverlayEntry = {
      ...existing,
      ...(patch as Partial<AgentTemplateOverlayEntry>),
      id: existing.id, // 强制锁定
      profile: patch.profile ? patch.profile : existing.profile,
    };
    overlay.custom[customIdx] = next;
  }
  writeAgentTemplateOverlay(overlay);
  return listAgentTemplates().find((t) => t.id === id)!;
}

/** 删除模板。内置 → 软隐藏 + 清 overrides；自建 → 真删；不存在 → 抛错。
 *  返回 { kind: 'hidden' | 'removed', id } 给路由层据此选择 audit action 与 UX 文案。 */
export function deleteAgentTemplate(id: string): { kind: "hidden" | "removed"; id: string } {
  if (!id || typeof id !== "string") throw new Error("id 不能为空");
  const overlay = readAgentTemplateOverlay();
  const builtins = builtinIds();
  if (builtins.has(id)) {
    // 内置：加 hidden（去重）+ 清 overrides 残留
    if (!overlay.hidden.includes(id)) overlay.hidden.push(id);
    if (overlay.overrides[id]) delete overlay.overrides[id];
    writeAgentTemplateOverlay(overlay);
    return { kind: "hidden", id };
  }
  const customIdx = overlay.custom.findIndex((c) => c.id === id);
  if (customIdx < 0) throw new Error(`模板不存在：${id}`);
  overlay.custom.splice(customIdx, 1);
  writeAgentTemplateOverlay(overlay);
  return { kind: "removed", id };
}

/** 恢复软隐藏的内置模板（从 hidden 中移除）。UX 上对应「撤销删除」。 */
export function restoreAgentTemplate(id: string): AgentTemplate {
  const overlay = readAgentTemplateOverlay();
  const builtins = builtinIds();
  if (!builtins.has(id)) {
    throw new Error(`不是内置模板（自建无需恢复）：${id}`);
  }
  const before = overlay.hidden.length;
  overlay.hidden = overlay.hidden.filter((x) => x !== id);
  if (overlay.hidden.length === before) {
    throw new Error(`模板未被隐藏：${id}`);
  }
  writeAgentTemplateOverlay(overlay);
  return listAgentTemplates().find((t) => t.id === id)!;
}
