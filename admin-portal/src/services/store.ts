// 运行时 config-store 读写（$STATE_DIR/config-store/*.json）。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";

export const STORE_DIR = join(STATE_DIR, "config-store");

export interface AgentEntry {
  id: string;
  role: "employee" | "admin";
  name?: string;
  default?: boolean;
  workspace: string;
  skills: string[];
  tools?: { allow?: string[]; deny?: string[] };
  [k: string]: unknown;
}
export interface Binding {
  agentId: string;
  match: { channel: string; accountId: string };
}
export type ChannelsStore = Record<string, Record<string, Record<string, unknown>>>;
export interface ConfigStore {
  channels: ChannelsStore;
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
