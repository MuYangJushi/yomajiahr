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
  defaultSkills?: string[];
  source?: AgentTemplateSource;
  status?: string;
  workflowHints?: AgentTemplateWorkflowHints;
}

/** 模板目录根（仓库内，部署后随 workspaces/ 同步到 $STATE_DIR/workspaces/_templates/）。 */
function stateTemplatesDir(): string {
  return join(process.env.OPENCLAW_STATE_DIR || "", "workspaces", "_templates", "agents");
}

/** 仓库内 fallback：admin-server/src/services → ../../workspaces/_templates/agents（开发态）。 */
function repoTemplatesDir(): string {
  return join(import.meta.dirname, "..", "..", "..", "workspaces", "_templates", "agents");
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
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 列出全部系统模板（ADR-016 §1：读目录派生）。优先 STATE_DIR 部署副本，回退仓库源。 */
export function listAgentTemplates(): AgentTemplate[] {
  const stateDir = process.env.OPENCLAW_STATE_DIR || "";
  if (stateDir) {
    const fromState = readTemplatesFrom(stateTemplatesDir());
    if (fromState.length > 0) return fromState;
  }
  return readTemplatesFrom(repoTemplatesDir());
}
