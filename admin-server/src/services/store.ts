// 运行时 config-store 读写（$STATE_DIR/config-store/*.json）。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
