// 渠道账号 CRUD + 集中探活（ADR-013 §渠道独立）。
// 探活结果缓存在 channels.json 的 `health` 字段（每账号一条）：
//   { ok: boolean, lastError?: string, updatedAt: ISO8601 }
// 服务端 spawn "openclaw channels status --probe --json" 一次，按 type 分桶写回 store。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";
import { runtimeEnv } from "./secrets.js";
import { readStore, writeStore, type ChannelAsset } from "./store.js";

export interface ChannelHealth {
  ok: boolean;
  lastError?: string;
  updatedAt: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_STALE_MS = 30_000;

interface OpenclawStatus {
  channelAccounts?: Record<string, Array<{
    accountId: string;
    configured?: boolean;
    running?: boolean;
    connected?: boolean;
    probe?: { ok?: boolean; error?: string };
    lastError?: string;
  }>>;
}

async function probeOpenclaw(): Promise<OpenclawStatus> {
  return await new Promise<OpenclawStatus>((resolve) => {
    const child = spawn("openclaw", ["channels", "status", "--probe", "--json", "--timeout", String(PROBE_TIMEOUT_MS)], {
      env: { ...process.env, ...runtimeEnv(), OPENCLAW_CONFIG_PATH: join(STATE_DIR, "openclaw.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS + 5_000);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", () => { clearTimeout(timer); resolve({}); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({});
      try {
        resolve(JSON.parse(stdout) as OpenclawStatus);
      } catch {
        resolve({});
      }
    });
  });
}

/** 跑一次集中探活；按 type 分桶写回 channels.json（cache-aside 30s 过期）。 */
export async function probeChannels(force = false): Promise<ChannelHealth[]> {
  const store = readStore();
  const now = Date.now();
  // 不强制刷新 → 缓存 30s 内复用
  if (!force) {
    const allFresh = store.channels.every(
      (c) => c.health?.updatedAt && now - new Date(c.health.updatedAt).getTime() < PROBE_STALE_MS,
    );
    if (allFresh && store.channels.length > 0) {
      return store.channels.map((c) => c.health || { ok: false, lastError: "未探活", updatedAt: new Date(0).toISOString() });
    }
  }
  const status = await probeOpenclaw();
  const updatedAt = new Date().toISOString();
  const accountsByDomain: Record<string, Map<string, any>> = {};
  for (const [domain, arr] of Object.entries(status.channelAccounts || {})) {
    accountsByDomain[domain] = new Map((arr || []).map((a) => [a.accountId, a]));
  }
  for (const c of store.channels) {
    const domain = c.type === "dingtalk" ? "dingtalk-connector" : c.type;
    const probeInfo = accountsByDomain[domain]?.get(c.id);
    if (!probeInfo) {
      c.health = { ok: false, lastError: "Gateway 探活未返回该账号", updatedAt };
    } else if (c.type === "feishu") {
      const ok = Boolean(probeInfo.configured && probeInfo.running && probeInfo.probe?.ok === true);
      c.health = { ok, ...(ok ? {} : { lastError: probeInfo.probe?.error || probeInfo.lastError || "未运行" }), updatedAt };
    } else {
      const ok = Boolean(probeInfo.configured && probeInfo.running && probeInfo.connected);
      c.health = { ok, ...(ok ? {} : { lastError: probeInfo.lastError || "未连接" }), updatedAt };
    }
  }
  writeStore(store);
  return store.channels.map((c) => c.health!);
}

/** 创建账号资产（id 不可改；displayName + 凭证 + policy）。 */
export function createChannelAsset(input: {
  id: string;
  type: "feishu" | "dingtalk";
  displayName: string;
  account: Record<string, unknown>;
  policy?: ChannelAsset["policy"];
  envKeys?: string[];
  secrets?: Record<string, string>;
}): ChannelAsset {
  const store = readStore();
  if (store.channels.some((c) => c.id === input.id && c.type === input.type)) {
    throw new Error(`渠道账号 ID 已存在：${input.type}/${input.id}`);
  }
  const asset: ChannelAsset = {
    id: input.id,
    type: input.type,
    displayName: input.displayName,
    enabled: true,
    account: input.account,
    policy: input.policy,
    envKeys: input.envKeys,
  };
  store.channels.push(asset);
  writeStore(store);
  return asset;
}

/** 列出账号资产（按 type + id 排序）。 */
export function listChannelAssets(): ChannelAsset[] {
  return readStore().channels.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}
