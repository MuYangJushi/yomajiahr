// 系统自带数字员工模板（ADR-013 延伸：空白起步 + 从模板创建，对标 ClawMax TEMPLATES/agents）。
//
// ADR-016 §1：模板由内联 TS 数组升级为**文件化模板目录** `workspaces/_templates/agents/<id>-template/template.json`，
// 与 ClawMax 形态同构。本模块改为读取该目录派生，`GET /config/agent-templates` 契约保持不变（向后兼容旧字段），
// 并透传 ADR-016 新增的可选预留字段（emoji/tags/category/source/status/workflowHints）。
//
// 仅提供「建议值」：id/name/role/profile/suggestedSkills 都是预填，创建仍走正常 createAgentProfile，
//   tools.deny 等权限硬隔离由服务端 toolsForRole(role) 现场盖章，模板无权绕过（ADR-003）。
// suggestedSkills 当前仅供展示参考；技能绑定不在招募阶段进行（ADR-015）。
//
// workflowHints 只表达「建议参与哪些 workflow」，不执行；workflow DAG/cron/执行状态不进 agent template
// （ADR-016 §1.1 明确边界，留给未来独立 workflow 资产）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "./orchestrator.js";
import { departmentIndex, resolveTemplateDepartment } from "./departments.js";
import {
  readAgentTemplateOverlay,
  type AgentTemplateOverlay,
  type AgentTemplateOverlayEntry,
} from "./store.js";

/** 模板来源与版本追溯（ADR-016 §1.1，支持未来 ClawMax 上游同步）。 */
export interface AgentTemplateSource {
  type: string;
  template?: string;
  agentId?: string;
  version?: string;
  [k: string]: unknown;
}

/** workflow 建议预留（只表达意图，不执行）。 */
export interface AgentTemplateWorkflowHints {
  suggestedWorkflowIds?: string[];
  targetTags?: string[];
  defaultParticipation?: string;
  [k: string]: unknown;
}

export interface AgentTemplate {
  /** 模板标识（稳定，仅用于前端选择，不等于将来 agent 的 id）。 */
  id: string;
  /** 模板展示名 + 选中后预填到「名称」。 */
  name: string;
  /** emoji 图标（ADR-016 §1，对标 ClawMax，可选）。 */
  emoji?: string;
  /** 一句话说明，渲染在下拉项里。 */
  description: string;
  /** 预填到「不可变 ID」（用户可改）。 */
  suggestedId: string;
  role: "employee" | "admin";
  profile: Required<Pick<AgentProfile, "jobTitle" | "responsibilities" | "personality" | "tone" | "boundaries">>;
  /** 仅展示参考；技能绑定不在招募阶段进行。 */
  suggestedSkills: string[];
  /** ADR-016 §1.1 预留字段（全部可选，向后兼容）。 */
  tags?: string[];
  category?: string;
  /** ADR-018 §1.2：部门维度（curated 注册表 id）。文件可能未声明，listAgentTemplates 解析时按 category→department 映射，再无则归 "other"。 */
  department?: string;
  defaultSkills?: string[];
  source?: AgentTemplateSource;
  status?: string;
  workflowHints?: AgentTemplateWorkflowHints;
}

/** 模板目录根（仓库内，部署后随 workspaces/ 同步到 $STATE_DIR/workspaces/_templates/）。 */
function stateTemplatesDir(): string {
  return join(process.env.OPENCLAW_STATE_DIR || "", "workspaces", "_templates", "agents");
}

/**
 * 仓库内 fallback。⚠️ 不能用固定的 `import.meta.dirname + ../../.`：
 * tsup 把全仓打成单文件 `dist/server.js`，`import.meta.dirname` 从源码态的
 * `admin-server/src/services`（退 3 层到 repo 根）变成打包态的 `admin-server/dist`
 * （只退 2 层），固定层数会多退一层 → 指向 repo 之外 → 生产模板列表为空。
 *
 * 改为枚举候选目录，命中第一个存在的。兼容：源码 tsx 态、tsup 打包态、
 * `npm run dev/start`（cwd=admin-server）、install.sh 部署态（cwd=repo 根）。
 */
function repoTemplatesDir(): string {
  const dir = import.meta.dirname || "";
  const candidates = [
    join(dir, "..", "..", "..", "workspaces", "_templates", "agents"), // 源码态: src/services → repo 根
    join(dir, "..", "..", "workspaces", "_templates", "agents"),       // 打包态: dist → repo 根
    join(process.cwd(), "workspaces", "_templates", "agents"),         // cwd=repo 根
    join(process.cwd(), "..", "workspaces", "_templates", "agents"),   // cwd=admin-server
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 全部不命中时返回源码态候选，保持与原行为一致（读空目录返回 []）。
  return candidates[0];
}

/** 安全读取一个 template.json（结构非法跳过，不抛、不崩整个列表）。 */
function readTemplateFile(file: string): AgentTemplate | undefined {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  // 必填字段校验（缺则跳过）。
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    (raw.role !== "employee" && raw.role !== "admin") ||
    !raw.profile ||
    typeof raw.profile !== "object"
  ) {
    return undefined;
  }
  const profile = raw.profile as Record<string, unknown>;
  const requiredProfile: AgentTemplate["profile"] = {
    jobTitle: typeof profile.jobTitle === "string" ? profile.jobTitle : "",
    responsibilities: typeof profile.responsibilities === "string" ? profile.responsibilities : "",
    personality: typeof profile.personality === "string" ? profile.personality : "",
    tone: typeof profile.tone === "string" ? profile.tone : "",
    boundaries: typeof profile.boundaries === "string" ? profile.boundaries : "",
  };
  const skillsFromArray = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((s: unknown): s is string => typeof s === "string") : [];
  const t: AgentTemplate = {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    suggestedId: typeof raw.suggestedId === "string" ? raw.suggestedId : raw.id,
    role: raw.role,
    profile: requiredProfile,
    suggestedSkills: skillsFromArray(raw.suggestedSkills).length > 0
      ? skillsFromArray(raw.suggestedSkills)
      : skillsFromArray(raw.defaultSkills),
  };
  // 透传 ADR-016 可选预留字段。
  if (typeof raw.emoji === "string") t.emoji = raw.emoji;
  if (Array.isArray(raw.tags)) t.tags = skillsFromArray(raw.tags);
  if (typeof raw.category === "string") t.category = raw.category;
  if (typeof raw.department === "string") t.department = raw.department;
  if (Array.isArray(raw.defaultSkills)) t.defaultSkills = skillsFromArray(raw.defaultSkills);
  if (raw.source && typeof raw.source === "object") t.source = raw.source as AgentTemplateSource;
  if (typeof raw.status === "string") t.status = raw.status;
  if (raw.workflowHints && typeof raw.workflowHints === "object") {
    t.workflowHints = raw.workflowHints as AgentTemplateWorkflowHints;
  }
  return t;
}

function readTemplatesFrom(dir: string): AgentTemplate[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AgentTemplate[] = [];
  for (const name of entries) {
    if (!name.endsWith("-template")) continue;
    const file = join(dir, name, "template.json");
    if (!existsSync(file)) continue;
    const t = readTemplateFile(file);
    if (t) out.push(t);
  }
  return out;
}

/** 应用部门兜底：`department` 字段优先，再按 category→department 映射，再回退 "other"。 */
function withResolvedDepartment(list: AgentTemplate[]): AgentTemplate[] {
  const idx = departmentIndex();
  const known = new Set(idx.keys());
  return list.map((t) => ({ ...t, department: resolveTemplateDepartment(t.department, t.category, known) }));
}

/** 排序：按 (department.order, template id)，部门未知则归到尾部。 */
function sortByDepartment(list: AgentTemplate[]): AgentTemplate[] {
  const idx = departmentIndex();
  return [...list].sort((a, b) => {
    const da = idx.get(a.department || "other")?.order ?? 999;
    const db = idx.get(b.department || "other")?.order ?? 999;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
}

/** 读内置模板（不含 overlay）：优先 STATE_DIR 部署副本，回退仓库源。 */
function readBuiltinTemplates(): AgentTemplate[] {
  const stateDir = process.env.OPENCLAW_STATE_DIR || "";
  let list: AgentTemplate[] = [];
  if (stateDir) list = readTemplatesFrom(stateTemplatesDir());
  if (list.length === 0) list = readTemplatesFrom(repoTemplatesDir());
  return list;
}

/** 将 overlay.custom 条目规范化为 AgentTemplate（补必填默认值，不做严格类型断言，CRUD 层负责校验）。 */
function normalizeCustom(entry: AgentTemplateOverlayEntry): AgentTemplate | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  if (typeof entry.id !== "string" || typeof entry.name !== "string") return undefined;
  if (entry.role !== "employee" && entry.role !== "admin") return undefined;
  if (!entry.profile || typeof entry.profile !== "object") return undefined;
  const p = entry.profile;
  const t: AgentTemplate = {
    id: entry.id,
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : "",
    suggestedId: typeof entry.suggestedId === "string" && entry.suggestedId ? entry.suggestedId : entry.id,
    role: entry.role,
    profile: {
      jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : "",
      responsibilities: typeof p.responsibilities === "string" ? p.responsibilities : "",
      personality: typeof p.personality === "string" ? p.personality : "",
      tone: typeof p.tone === "string" ? p.tone : "",
      boundaries: typeof p.boundaries === "string" ? p.boundaries : "",
    },
    suggestedSkills: Array.isArray(entry.suggestedSkills) ? entry.suggestedSkills.filter((s): s is string => typeof s === "string") : [],
  };
  if (typeof entry.emoji === "string") t.emoji = entry.emoji;
  if (Array.isArray(entry.tags)) t.tags = entry.tags.filter((s): s is string => typeof s === "string");
  if (typeof entry.category === "string") t.category = entry.category;
  if (typeof entry.department === "string") t.department = entry.department;
  if (Array.isArray(entry.defaultSkills)) t.defaultSkills = entry.defaultSkills.filter((s): s is string => typeof s === "string");
  return t;
}

/** 把 overrides[id] 的字段级覆盖应用到内置模板。
 *  仅覆盖白名单字段（name/description/emoji/tags/category/department/profile/suggestedSkills/defaultSkills/role），
 *  不允许通过 overrides 改 id（id 是内置的稳定标识，改了等于「换了一个模板」，请走自建 custom）。 */
function applyOverride(base: AgentTemplate, override: Record<string, unknown>): AgentTemplate {
  const out: AgentTemplate = { ...base };
  if (typeof override.name === "string") out.name = override.name;
  if (typeof override.description === "string") out.description = override.description;
  if (typeof override.emoji === "string") out.emoji = override.emoji;
  if (Array.isArray(override.tags)) out.tags = override.tags.filter((s): s is string => typeof s === "string");
  if (typeof override.category === "string") out.category = override.category;
  if (typeof override.department === "string") out.department = override.department;
  if (override.role === "employee" || override.role === "admin") out.role = override.role;
  if (override.profile && typeof override.profile === "object") {
    const op = override.profile as Record<string, unknown>;
    out.profile = {
      jobTitle: typeof op.jobTitle === "string" ? op.jobTitle : base.profile.jobTitle,
      responsibilities: typeof op.responsibilities === "string" ? op.responsibilities : base.profile.responsibilities,
      personality: typeof op.personality === "string" ? op.personality : base.profile.personality,
      tone: typeof op.tone === "string" ? op.tone : base.profile.tone,
      boundaries: typeof op.boundaries === "string" ? op.boundaries : base.profile.boundaries,
    };
  }
  if (Array.isArray(override.suggestedSkills)) out.suggestedSkills = (override.suggestedSkills as unknown[]).filter((s): s is string => typeof s === "string");
  if (Array.isArray(override.defaultSkills)) out.defaultSkills = (override.defaultSkills as unknown[]).filter((s): s is string => typeof s === "string");
  return out;
}

/**
 * 列出全部系统模板（ADR-016 §1 + ADR-018 §决策 2.2）。合并语义：
 *
 *   builtins = 内置（state 优先 → repo fallback）
 *   overlay  = config-store/agent-templates.json
 *   结果 = (builtins 中 id ∉ hidden，逐个 apply overrides[id]) ++ overlay.custom
 *          → 部门兜底解析 → 按 (department.order, id) 排序
 *
 * 行为：
 * - 旧部署 overlay 文件缺失：等价空 overlay，列表与「无 overlay」时一致（向后兼容）。
 * - overlay.custom 与内置 id 冲突时：custom 进列表，内置仍在（CRUD 端点会在 POST 时阻断同名）。
 *   兜底原则：列表层不强删，避免坏 overlay 让 UI 整段挂掉；冲突由 CRUD 校验环节守。
 */
export function listAgentTemplates(): AgentTemplate[] {
  const builtins = readBuiltinTemplates();
  const overlay: AgentTemplateOverlay = readAgentTemplateOverlay();
  const hidden = new Set(overlay.hidden);
  const merged: AgentTemplate[] = [];
  for (const b of builtins) {
    if (hidden.has(b.id)) continue;
    const ov = overlay.overrides[b.id];
    merged.push(ov ? applyOverride(b, ov) : b);
  }
  for (const c of overlay.custom) {
    const normalized = normalizeCustom(c);
    if (normalized) merged.push(normalized);
  }
  return sortByDepartment(withResolvedDepartment(merged));
}

/** 列出仅内置模板（CRUD 用：内置 id 集合用于判定「软隐藏 vs 真删」 + 同名冲突）。 */
export function listBuiltinAgentTemplates(): AgentTemplate[] {
  return sortByDepartment(withResolvedDepartment(readBuiltinTemplates()));
}
