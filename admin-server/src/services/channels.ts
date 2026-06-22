// 渠道账号 CRUD + 集中探活（ADR-013 §渠道独立）。
// 探活结果缓存在 channels.json 的 `health` 字段（每账号一条），不进入运行时配置。
// 服务端 spawn "openclaw channels status --probe --json" 一次，按 type 分桶写回 store。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { appendAuditLog } from "../util.js";
import { triggerApply, type ApplyResult } from "./config-apply.js";
import { withConfigLock } from "./orchestrator.js";
import { ENV_PATH, envKeysAllConfigured, envKeysSet, removeEnv, runtimeEnv, upsertEnv } from "./secrets.js";
import { STORE_DIR, readStore, writeStore, type ChannelAsset } from "./store.js";

export interface ChannelHealth {
  configured: boolean;
  running: boolean;
  connected: boolean;
  probe?: { ok: boolean };
  lastError?: string;
  checkedAt: string;
}

interface ChannelOnboardingSession {
  id: string;
  owner: string;
  status: "preparing" | "awaiting_scan" | "applying" | "success" | "failed" | "cancelled";
  message?: string;
  qrUrl?: string;
  expiresAt: number;
  abort: AbortController;
}
const onboardingSessions = new Map<string, ChannelOnboardingSession>();

function publicOnboarding(session: ChannelOnboardingSession) {
  return {
    id: session.id,
    status: session.status,
    message: session.message,
    qr_url: session.qrUrl,
    expires_at: new Date(session.expiresAt).toISOString(),
  };
}

export function getChannelOnboarding(owner: string, id: string) {
  const session = onboardingSessions.get(id);
  return session?.owner === owner ? publicOnboarding(session) : undefined;
}

export function cancelChannelOnboarding(owner: string, id: string) {
  const session = onboardingSessions.get(id);
  if (!session || session.owner !== owner) return undefined;
  session.abort.abort();
  session.status = "cancelled";
  return publicOnboarding(session);
}

export function startChannelOnboarding(owner: string, input: {
  id: string; type: "feishu" | "dingtalk"; displayName: string; policy?: ChannelAsset["policy"];
}) {
  const session: ChannelOnboardingSession = {
    id: randomUUID(), owner, status: "preparing", expiresAt: Date.now() + 2 * 60 * 60 * 1000, abort: new AbortController(),
  };
  onboardingSessions.set(session.id, session);
  void (async () => {
    try {
      const onboarding = await import("./onboarding.js");
      const callbacks = {
        signal: session.abort.signal,
        onQRCode(url: string, expiresIn: number) {
          session.qrUrl = url; session.expiresAt = Date.now() + expiresIn * 1000; session.status = "awaiting_scan";
        },
      };
      const credentials = input.type === "feishu"
        ? await onboarding.registerFeishuApplication({ id: input.id, name: input.displayName, role: "employee", skills: [], domain: "feishu" }, callbacks)
        : await onboarding.registerDingTalkApplication(callbacks);
      session.status = "applying";
      await createChannelAsset({ ...input, clientId: credentials.clientId, secret: credentials.clientSecret });
      appendAuditLog("channel.create", input.id, owner, { type: input.type, id: input.id, mode: "qrcode" });
      session.status = "success"; session.message = "渠道账号已创建";
    } catch (err) {
      session.status = session.abort.signal.aborted ? "cancelled" : "failed";
      session.message = (err as Error).message.replace(/(secret)[=:]\s*\S+/gi, "$1=***");
    }
  })();
  return publicOnboarding(session);
}

const PROBE_TIMEOUT_MS = 5_000;
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

/** 跑一次集中探活；按 type 分桶写回 channels.json（cache-aside 30s 过期）。
 *
 *  「凭证未配置」的账号短路：不进入 spawn 调度（gateway 自身也不会为它启动 client，
 *  见 generate-config.ts 的 isAssetConfigured 跳过逻辑），health 直接落
 *  `{configured:false, running:false, connected:false, lastError:"凭证未配置"}`。
 *  这避免了占位符账号（dingtalk-connector 401 退避循环 / feishu probe 持续失败）拖慢
 *  channels 页面刷新与配置 apply。
 */
export async function probeChannels(force = false): Promise<ChannelHealth[]> {
  const snapshot = readStore();
  const now = Date.now();
  // 不强制刷新 → 缓存 30s 内复用
  if (!force) {
    const allFresh = snapshot.channels.every(
      (c) => c.health?.checkedAt && now - new Date(c.health.checkedAt).getTime() < PROBE_STALE_MS,
    );
    if (allFresh && snapshot.channels.length > 0) {
      return snapshot.channels.map((c) => c.health || { configured: false, running: false, connected: false, lastError: "未探活", checkedAt: new Date(0).toISOString() });
    }
  }
  const checkedAt = new Date().toISOString();
  // 先按 envKeys 真实值做配置就绪判定；未配置账号直接落 health，不参与 spawn 探活。
  const configuredAssets: ChannelAsset[] = [];
  const healthByAsset = new Map<string, ChannelHealth>();
  for (const c of snapshot.channels) {
    if (envKeysAllConfigured(c.envKeys)) {
      configuredAssets.push(c);
    } else {
      healthByAsset.set(`${c.type}/${c.id}`, {
        configured: false,
        running: false,
        connected: false,
        lastError: "凭证未配置",
        checkedAt,
      });
    }
  }
  // 仅当至少有一条已配置账号时才发起 spawn 探活。
  const status = configuredAssets.length > 0 ? await probeOpenclaw() : ({} as OpenclawStatus);
  const accountsByDomain: Record<string, Map<string, any>> = {};
  for (const [domain, arr] of Object.entries(status.channelAccounts || {})) {
    accountsByDomain[domain] = new Map((arr || []).map((a) => [a.accountId, a]));
  }
  for (const c of configuredAssets) {
    const domain = c.type === "dingtalk" ? "dingtalk-connector" : c.type;
    const probeInfo = accountsByDomain[domain]?.get(c.id);
    if (!probeInfo) {
      healthByAsset.set(`${c.type}/${c.id}`, { configured: true, running: false, connected: false, lastError: "Gateway 探活未返回该账号", checkedAt });
    } else {
      const configured = Boolean(probeInfo.configured);
      const running = Boolean(probeInfo.running);
      const connected = c.type === "feishu" ? probeInfo.probe?.ok === true : Boolean(probeInfo.connected);
      healthByAsset.set(`${c.type}/${c.id}`, {
        configured,
        running,
        connected,
        ...(c.type === "feishu" ? { probe: { ok: connected } } : {}),
        ...(configured && running && connected ? {} : { lastError: probeInfo.probe?.error || probeInfo.lastError || "未连接" }),
        checkedAt,
      });
    }
  }
  // 探活期间可能发生新增/删除/绑定。只把 health 合并进最新 store，禁止旧快照复活已删除资产。
  return withConfigLock(async () => {
    const latest = readStore();
    for (const channel of latest.channels) {
      const health = healthByAsset.get(`${channel.type}/${channel.id}`);
      if (health) channel.health = health;
    }
    writeStore(latest);
    return latest.channels.map((channel) =>
      channel.health || { configured: false, running: false, connected: false, lastError: "未探活", checkedAt: new Date(0).toISOString() },
    );
  });
}

/** 创建账号资产（id 不可改；displayName + 凭证 + policy）。 */
function credentialsFor(input: { id: string; type: "feishu" | "dingtalk"; clientId: string; secret: string; displayName: string }) {
  const up = input.id.toUpperCase().replace(/-/g, "_");
  if (input.type === "feishu") {
    const idKey = `FEISHU_${up}_APP_ID`;
    const secretKey = `FEISHU_${up}_APP_SECRET`;
    return {
      account: { appId: `\${${idKey}}`, appSecret: `\${${secretKey}}` },
      envKeys: [idKey, secretKey],
      secrets: { [idKey]: input.clientId, [secretKey]: input.secret },
    };
  }
  const idKey = `DINGTALK_${up}_CLIENT_ID`;
  const secretKey = `DINGTALK_${up}_CLIENT_SECRET`;
  return {
    account: { enabled: true, name: input.displayName, clientId: `\${${idKey}}`, clientSecret: `\${${secretKey}}` },
    envKeys: [idKey, secretKey],
    secrets: { [idKey]: input.clientId, [secretKey]: input.secret },
  };
}

async function mutateChannels<T>(
  operation: (store: ReturnType<typeof readStore>) => T,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withConfigLock(async () => {
    // 快照只用于回滚；不 cpSync 整个目录（非原子，回滚窗口里并发 readStore 可能读到半截 JSON
    // → 列表 GET 间歇 500）。改用内存快照 + 原子 writeStore / 原子写 .env 还原，保证单文件原子。
    const prevStore = readStore();
    const prevEnv = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : null;
    try {
      const store = readStore();
      const result = operation(store);
      writeStore(store);
      // 删除渠道账号走 restart 模式（停掉对应 channel client），生产 apply 含 gateway 重启 +
      // 探活（PROBE_WINDOW 30s + READY_SUSTAIN 11s），常超 triggerApply 默认 30s。超时返回 pending
      // 会被下方判定为失败并回滚 → 删除被撤销。故允许调用方按操作抬高超时。
      const apply = await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, timeoutMs: opts.timeoutMs }) as ApplyResult;
      if (apply.status !== "success") throw new Error(`配置应用失败：${apply.message || apply.status}`);
      return result;
    } catch (err) {
      // 原子还原：writeStore 逐文件 tmp+rename；.env 同样 tmp+rename+chmod。
      try {
        writeStore(prevStore);
        if (prevEnv !== null) {
          const tmp = `${ENV_PATH}.tmp`;
          writeFileSync(tmp, prevEnv);
          renameSync(tmp, ENV_PATH);
          chmodSync(ENV_PATH, 0o600);
        } else {
          rmSync(ENV_PATH, { force: true });
        }
        await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR });
      } catch {
        /* 复原失败：保持原错误返回，运维可手工 apply */
      }
      throw err;
    }
  });
}

export async function createChannelAsset(input: {
  id: string;
  type: "feishu" | "dingtalk";
  displayName: string;
  clientId: string;
  secret: string;
  policy?: ChannelAsset["policy"];
}): Promise<ChannelAsset> {
  const credentials = credentialsFor(input);
  return mutateChannels((store) => {
    if (store.channels.some((c) => c.id === input.id && c.type === input.type)) throw new Error(`渠道账号 ID 已存在：${input.type}/${input.id}`);
    upsertEnv(credentials.secrets);
    const asset: ChannelAsset = { id: input.id, type: input.type, displayName: input.displayName, enabled: true, account: credentials.account, envKeys: credentials.envKeys, policy: input.policy };
    store.channels.push(asset);
    return asset;
  });
}

export async function updateChannelAsset(type: "feishu" | "dingtalk", id: string, input: {
  displayName?: string; clientId?: string; secret?: string; policy?: ChannelAsset["policy"];
}): Promise<ChannelAsset> {
  return mutateChannels((store) => {
    const asset = store.channels.find((c) => c.type === type && c.id === id);
    if (!asset) throw new Error("账号不存在");
    if (input.displayName) asset.displayName = input.displayName;
    if (input.policy) asset.policy = input.policy;
    if (input.clientId || input.secret) {
      const env = credentialsFor({ id, type, displayName: asset.displayName, clientId: input.clientId || "", secret: input.secret || "" });
      const current = runtimeEnv();
      upsertEnv(Object.fromEntries(Object.entries(env.secrets).filter(([key, value]) => value || !current[key])));
      asset.account = { ...asset.account, ...env.account };
      asset.envKeys = env.envKeys;
    }
    return asset;
  });
}

export async function deleteChannelAsset(type: "feishu" | "dingtalk", id: string): Promise<void> {
  return mutateChannels((store) => {
    const asset = store.channels.find((c) => c.type === type && c.id === id);
    if (!asset) throw new Error("账号不存在");
    const domain = type === "dingtalk" ? "dingtalk-connector" : type;
    if (store.bindings.some((b) => b.match.channel === domain && b.match.accountId === id)) throw new Error("CHANNEL_IN_USE");
    store.channels = store.channels.filter((c) => !(c.type === type && c.id === id));
    removeEnv(asset.envKeys || []);
  }, { timeoutMs: 120_000 });
}

/** 列出脱敏账号资产、实时占用状态与员工名称。 */
export function listChannelAssets() {
  const store = readStore();
  const keys = envKeysSet();
  const agentNames = new Map(store.agents.map((agent) => [agent.id, agent.name || agent.id]));
  return store.channels.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }).map((asset) => {
    const domain = asset.type === "dingtalk" ? "dingtalk-connector" : asset.type;
    const binding = store.bindings.find((b) => b.match.channel === domain && b.match.accountId === asset.id);
    return {
      id: asset.id, type: asset.type, displayName: asset.displayName, enabled: asset.enabled !== false,
      policy: asset.policy, health: asset.health,
      credentialsConfigured: Boolean(asset.envKeys?.length && asset.envKeys.every((key) => keys.has(key))),
      occupiedBy: binding ? { agentId: binding.agentId, agentName: agentNames.get(binding.agentId) || binding.agentId } : undefined,
    };
  });
}
