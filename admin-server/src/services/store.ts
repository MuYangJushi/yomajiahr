// 运行时 config-store 读写（$STATE_DIR/config-store/*.json）。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";

export const STORE_DIR = join(STATE_DIR, "config-store");

export interface AgentEntry {
  id: string;
  role: "employee" | "admin";
  name?: string;
  /** @deprecated 由 profile.personality 取代；保留字段做向后兼容读取，渲染时映射。 */
  persona?: string;
  /** 结构化职业档案（ADR-013）。不进运行时配置（见 config/src/generate-config.ts）。 */
  profile?: {
    jobTitle?: string;
    responsibilities?: string;
    personality?: string;
    tone?: string;
    boundaries?: string;
    [k: string]: unknown;
  };
  default?: boolean;
  workspace: string;
  /** 允许空数组（ADR-013 新员工可能尚未配置技能）。 */
  skills: string[];
  tools?: { allow?: string[]; deny?: string[] };
  [k: string]: unknown;
}
export interface ChannelPolicy {
  dmPolicy?: "open" | "restricted";
  groupPolicy?: "open" | "disabled";
  requireMention?: boolean;
}
export interface ChannelAsset {
  id: string;
  type: "feishu" | "dingtalk";
  displayName: string;
  enabled?: boolean;
  policy?: ChannelPolicy;
  account?: Record<string, unknown>;
  envKeys?: string[];
  /** 集中探活缓存（ADR-013 §渠道独立）。 */
  health?: {
    configured: boolean;
    running: boolean;
    connected: boolean;
    probe?: { ok: boolean };
    lastError?: string;
    checkedAt: string;
  };
  [k: string]: unknown;
}
/** @deprecated 保留旧类型以兼容历史调用方；新代码用 ChannelAsset[]。 */
export type ChannelsStore = ChannelAsset[];
export interface Binding {
  agentId: string;
  match: { channel: string; accountId: string };
}
export interface ConfigStore {
  channels: ChannelAsset[];
  agents: AgentEntry[];
  bindings: Binding[];
}

function rd<T>(name: string): T {
  return JSON.parse(readFileSync(join(STORE_DIR, name), "utf-8")) as T;
}
function wr(name: string, data: unknown): void {
  const p = join(STORE_DIR, name);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, p); // 原子
}

export function readStore(): ConfigStore {
  return {
    channels: rd<ChannelsStore>("channels.json"),
    agents: rd<AgentEntry[]>("agents.json"),
    bindings: rd<Binding[]>("bindings.json"),
  };
}

export function writeStore(s: ConfigStore): void {
  wr("channels.json", s.channels);
  wr("agents.json", s.agents);
  wr("bindings.json", s.bindings);
}

// ─────────────────────────────────────────────────────────────────────────────
// 员工模板 overlay（ADR-018 §决策 2）：用户可变态，与内置种子合并构成最终模板列表。
// 文件 $STATE_DIR/config-store/agent-templates.json：
//   - custom：用户新建的完整模板（不与内置 id 冲突）
//   - hidden：被「删除」的内置模板 id（软隐藏；抗 redeploy）
//   - overrides：内置模板的字段级覆盖（编辑内置时落在这里，不动 repo 种子）
// 旧部署 $STATE_DIR/config-store 已存在但缺 agent-templates.json 时：返回空 overlay，
// 写操作时 wr() 会原子建文件（seed-once 不覆盖既有 config-store，新文件由首次写触发）。

/** overlay 的运行时形态。`overrides[id]` 是 Partial 字段集；语义见 ADR-018 §2.1。 */
export interface AgentTemplateOverlay {
  custom: AgentTemplateOverlayEntry[];
  hidden: string[];
  overrides: Record<string, Record<string, unknown>>;
}

/** custom 模板：与 AgentTemplate 同构（admin-server/src/services/agent-templates.ts），
 *  这里用宽松类型避免循环依赖；CRUD 层校验完整性后再写入。 */
export interface AgentTemplateOverlayEntry {
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
  [k: string]: unknown;
}

const TEMPLATE_OVERLAY_FILE = "agent-templates.json";

/** 空 overlay（旧部署缺文件兜底，与 seed 一致）。 */
function emptyAgentTemplateOverlay(): AgentTemplateOverlay {
  return { custom: [], hidden: [], overrides: {} };
}

/** 安全读 overlay：文件缺失/JSON 失败/结构非法都退到空 overlay，不抛、不崩主流程。 */
export function readAgentTemplateOverlay(): AgentTemplateOverlay {
  const p = join(STORE_DIR, TEMPLATE_OVERLAY_FILE);
  if (!existsSync(p)) return emptyAgentTemplateOverlay();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return emptyAgentTemplateOverlay();
  }
  if (!raw || typeof raw !== "object") return emptyAgentTemplateOverlay();
  const o = raw as Record<string, unknown>;
  const custom = Array.isArray(o.custom) ? (o.custom as AgentTemplateOverlayEntry[]) : [];
  const hidden = Array.isArray(o.hidden) ? (o.hidden as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const overrides = o.overrides && typeof o.overrides === "object" && !Array.isArray(o.overrides)
    ? (o.overrides as Record<string, Record<string, unknown>>)
    : {};
  return { custom, hidden, overrides };
}

/** 原子写 overlay。调用方负责 CRUD 校验。 */
export function writeAgentTemplateOverlay(overlay: AgentTemplateOverlay): void {
  wr(TEMPLATE_OVERLAY_FILE, overlay);
}
