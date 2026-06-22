// 部门注册表（ADR-018 §决策 1.1）：curated，非自由字符串。
// 仓库内 workspaces/_templates/departments.json 是真相源；用户不可在运行时改部门表。
// 给「员工模板」选择/分组用，**不**注入 workspace 元模板（守 ADR-013：选择期元数据不进运行时配置）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Department {
  id: string;
  label: string;
  emoji?: string;
  order: number;
}

/** category → department 一次性兜底映射（ADR-018 §1.3）。
 *  仅在 template.json 未显式声明 department 时使用；显式 department 优先。
 *  仍无法解析时归 `other`，任何模板不会因部门缺失从 UI 丢失。 */
export const CATEGORY_TO_DEPARTMENT: Record<string, string> = {
  hr: "hr",
  leadership: "leadership",
  product: "product",
  engineering: "engineering",
  data: "data",
  research: "research",
  // judgment calls（ADR-018 §1.3 标 ⚠️，待 Dennis review 整表时一并定）
  communication: "marketing",
  event: "operations",
  education: "other",
  general: "other",
};

/** 仓库 fallback 路径解析。沿用 agent-templates 的多候选枚举（tsup 打包/源码 tsx/不同 cwd）。 */
function repoDepartmentsFile(): string {
  const dir = import.meta.dirname || "";
  const candidates = [
    join(dir, "..", "..", "..", "workspaces", "_templates", "departments.json"),
    join(dir, "..", "..", "workspaces", "_templates", "departments.json"),
    join(process.cwd(), "workspaces", "_templates", "departments.json"),
    join(process.cwd(), "..", "workspaces", "_templates", "departments.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

function stateDepartmentsFile(): string {
  return join(process.env.OPENCLAW_STATE_DIR || "", "workspaces", "_templates", "departments.json");
}

/** 默认硬兜底：仓库与 STATE_DIR 都缺时仍返回 other，避免 UI 整段挂掉。 */
const FALLBACK_DEPARTMENTS: Department[] = [
  { id: "other", label: "其他 / 未分组", emoji: "📁", order: 999 },
];

function readDepartmentsFromFile(file: string): Department[] | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out: Department[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.label !== "string") continue;
    const dept: Department = {
      id: o.id,
      label: o.label,
      order: typeof o.order === "number" ? o.order : 999,
    };
    if (typeof o.emoji === "string") dept.emoji = o.emoji;
    out.push(dept);
  }
  return out;
}

/** 列出部门表。优先 STATE_DIR 部署副本，回退仓库源，再回退硬兜底。 */
export function listDepartments(): Department[] {
  const stateDir = process.env.OPENCLAW_STATE_DIR || "";
  if (stateDir) {
    const fromState = readDepartmentsFromFile(stateDepartmentsFile());
    if (fromState && fromState.length > 0) return [...fromState].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  const fromRepo = readDepartmentsFromFile(repoDepartmentsFile());
  if (fromRepo && fromRepo.length > 0) return [...fromRepo].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return FALLBACK_DEPARTMENTS;
}

/** 派生：返回 id→Department 索引（便于 listAgentTemplates 排序时按 order 取）。 */
export function departmentIndex(): Map<string, Department> {
  const m = new Map<string, Department>();
  for (const d of listDepartments()) m.set(d.id, d);
  return m;
}

/**
 * 解析模板部门：显式 department 字段优先（在已知部门表中）；否则按 category 映射；都不命中→other。
 * 任何模板不会因部门缺失从 UI 丢失。
 */
export function resolveTemplateDepartment(
  rawDepartment: string | undefined,
  rawCategory: string | undefined,
  knownDepartmentIds: Set<string>,
): string {
  if (rawDepartment && knownDepartmentIds.has(rawDepartment)) return rawDepartment;
  if (rawCategory && CATEGORY_TO_DEPARTMENT[rawCategory] && knownDepartmentIds.has(CATEGORY_TO_DEPARTMENT[rawCategory])) {
    return CATEGORY_TO_DEPARTMENT[rawCategory];
  }
  return "other";
}
