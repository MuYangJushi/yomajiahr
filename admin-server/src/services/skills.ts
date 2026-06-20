// 技能目录 CRUD（ADR-015 §1 技能可编辑化）。
//
// 技能是 $STATE_DIR/skills/<name>/SKILL.md（frontmatter + markdown body）。
// 本模块只做文件 I/O + 引用检查 + 审计准备，**不触发 apply**（SKILL.md 是内容文件，
// 不进 openclaw.json/store；OpenClaw 按会话读取，新会话即生效）。
// 员工↔技能分配（改 agent.skills[]）才需要 apply，见 orchestrator.updateAgentSkills。
//
// 守 ADR-015「技能 ≠ 工具授权」：CRUD 不触碰 tools/openclaw.json 授权。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";
import { readStore } from "./store.js";

export const SKILLS_DIR = join(STATE_DIR, "skills");

/** 技能 ID 规则：小写字母/数字/连字符/下划线，首字符须字母或数字（与 validateSkills 一致）。 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ROLE_VALUES = new Set(["employee", "admin"]);
/** 控制字符清理（与 profile 字段清理一致）。 */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type SkillRole = "employee" | "admin";

/** 技能元信息（列表/分配视图用，不含 body）。 */
export interface SkillMeta {
  name: string;
  description: string;
  requiredRole?: SkillRole;
  requiresKnowledge?: boolean;
  /** ADR-016 §1：对标 ClawMax 的 emoji 图标（可选，向后兼容，旧技能缺字段不报错）。 */
  emoji?: string;
  /** ADR-016 §1：对标 ClawMax 的 tags（可选，向后兼容）。 */
  tags?: string[];
}

/** 技能全文（编辑器取/存用，含 body）。 */
export interface Skill extends SkillMeta {
  body: string;
}

export function skillDir(name: string): string {
  return join(SKILLS_DIR, name);
}
export function skillPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

/** 解析 SKILL.md：frontmatter（键值）+ body（frontmatter 之后的全文）。 */
function parseSkillFile(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return { fm, body: m[2] ?? "" };
}

/** 序列化 SKILL.md：稳定字段顺序 name → description → requiredRole → requiresKnowledge → emoji → tags → body。 */
function serializeSkill(meta: SkillMeta, body: string): string {
  const lines = ["---", `name: ${meta.name}`, `description: ${meta.description}`];
  if (meta.requiredRole) lines.push(`requiredRole: ${meta.requiredRole}`);
  if (meta.requiresKnowledge) lines.push(`requiresKnowledge: true`);
  if (meta.emoji) lines.push(`emoji: ${meta.emoji}`);
  if (meta.tags && meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(", ")}]`);
  lines.push("---", "");
  const cleaned = body.replace(CONTROL_RE, "");
  return lines.join("\n") + (cleaned.endsWith("\n") ? cleaned : cleaned + "\n");
}

/** 解析 frontmatter 中的 tags 值（宽容：`[a, b]` / `a,b` / `a` 都接受；空 → undefined）。 */
function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!stripped) return undefined;
  const tags = stripped
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function metaFromFm(name: string, fm: Record<string, string>): SkillMeta {
  const meta: SkillMeta = { name, description: fm.description ?? "" };
  if (fm.requiredRole && ROLE_VALUES.has(fm.requiredRole)) {
    meta.requiredRole = fm.requiredRole as SkillRole;
  }
  if (fm.requiresKnowledge === "true") meta.requiresKnowledge = true;
  if (typeof fm.emoji === "string" && fm.emoji) meta.emoji = fm.emoji.replace(CONTROL_RE, "").trim();
  const tags = parseTags(fm.tags);
  if (tags) meta.tags = tags;
  return meta;
}

/** 列出全部技能（按 name 排序）。含 body，供路由按需裁剪。 */
export function listSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: Skill[] = [];
  for (const name of readdirSync(SKILLS_DIR)) {
    const p = skillPath(name);
    if (!existsSync(p)) continue;
    const { fm, body } = parseSkillFile(readFileSync(p, "utf-8"));
    out.push({ ...metaFromFm(name, fm), body });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 列出技能元信息（不含 body），给列表/分配视图用。 */
export function listSkillMetas(): SkillMeta[] {
  return listSkills().map(({ body: _body, ...meta }) => meta);
}

export function getSkill(name: string): Skill | undefined {
  const p = skillPath(name);
  if (!existsSync(p)) return undefined;
  const { fm, body } = parseSkillFile(readFileSync(p, "utf-8"));
  return { ...metaFromFm(name, fm), body };
}

/** 引用某技能的员工 ID 列表（删除安全检查用）。 */
export function agentsUsingSkill(name: string): string[] {
  const { agents } = readStore();
  return agents.filter((a) => Array.isArray(a.skills) && a.skills.includes(name)).map((a) => a.id);
}

function cleanDescription(description: string): string {
  return description.replace(CONTROL_RE, "").trim();
}

export interface SkillInput {
  name: string;
  description: string;
  requiredRole?: SkillRole | null;
  requiresKnowledge?: boolean;
  /** ADR-016 §1：emoji 图标（可选）。 */
  emoji?: string | null;
  /** ADR-016 §1：tags（可选）。 */
  tags?: string[] | null;
  body?: string;
}

/** 校验技能入参的公共部分（name 仅在新建时校验）。 */
function validateMeta(input: {
  description: string;
  requiredRole?: SkillRole | null;
  requiresKnowledge?: boolean;
  emoji?: string | null;
  tags?: string[] | null;
}): {
  description: string;
  requiredRole?: SkillRole;
  requiresKnowledge?: boolean;
  emoji?: string;
  tags?: string[];
} {
  const description = cleanDescription(input.description);
  if (!description) throw new Error("description 不能为空");
  if (description.length > 500) throw new Error("description 过长（≤500 字符）");
  const out: { description: string; requiredRole?: SkillRole; requiresKnowledge?: boolean; emoji?: string; tags?: string[] } = {
    description,
  };
  if (input.requiredRole) {
    if (!ROLE_VALUES.has(input.requiredRole)) throw new Error("requiredRole 非法");
    out.requiredRole = input.requiredRole;
  }
  if (input.requiresKnowledge) out.requiresKnowledge = true;
  if (input.emoji) {
    const emoji = input.emoji.replace(CONTROL_RE, "").trim();
    if (emoji.length > 16) throw new Error("emoji 过长（≤16 字符）");
    if (emoji) out.emoji = emoji;
  }
  if (Array.isArray(input.tags)) {
    const tags = input.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.replace(CONTROL_RE, "").trim())
      .filter(Boolean)
      .slice(0, 20);
    if (tags.length > 0) out.tags = tags;
  }
  return out;
}

/** 新建技能：写 $STATE_DIR/skills/<name>/SKILL.md。不触发 apply。 */
export function createSkill(input: SkillInput): Skill {
  if (!SKILL_NAME_RE.test(input.name)) {
    throw new Error("技能 ID 非法（小写字母/数字/连字符/下划线，首字符须字母或数字）");
  }
  if (existsSync(skillPath(input.name))) throw new Error(`技能已存在：${input.name}`);
  const meta = validateMeta(input);
  const body = (input.body ?? "").replace(CONTROL_RE, "");
  mkdirSync(skillDir(input.name), { recursive: true });
  writeFileSync(skillPath(input.name), serializeSkill({ name: input.name, ...meta }, body));
  return getSkill(input.name)!;
}

/** 编辑技能（name 不可改）：改 description/requiredRole/requiresKnowledge/emoji/tags/body。不触发 apply。 */
export function updateSkill(name: string, input: Partial<SkillInput>): Skill {
  if (!existsSync(skillPath(name))) throw new Error(`技能不存在：${name}`);
  const current = getSkill(name)!;
  const meta = validateMeta({
    description: input.description ?? current.description,
    requiredRole: input.requiredRole === null ? undefined : (input.requiredRole ?? current.requiredRole),
    requiresKnowledge: input.requiresKnowledge ?? current.requiresKnowledge,
    emoji: input.emoji === null ? undefined : (input.emoji ?? current.emoji),
    tags: input.tags === null ? undefined : (input.tags ?? current.tags),
  });
  const body = (input.body !== undefined ? input.body : current.body).replace(CONTROL_RE, "");
  writeFileSync(skillPath(name), serializeSkill({ name, ...meta }, body));
  return getSkill(name)!;
}

/** 删除技能：被任意 agent 引用时拒绝（SKILL_IN_USE），避免悬空引用让下次 apply 校验失败。 */
export function deleteSkill(name: string): { referencedBy: string[] } {
  if (!existsSync(skillPath(name))) throw new Error(`技能不存在：${name}`);
  const referencedBy = agentsUsingSkill(name);
  if (referencedBy.length > 0) {
    const err = new Error(`SKILL_IN_USE:${referencedBy.join(",")}`) as Error & { referencedBy?: string[] };
    err.referencedBy = referencedBy;
    throw err;
  }
  rmSync(skillDir(name), { recursive: true, force: true });
  return { referencedBy: [] };
}
