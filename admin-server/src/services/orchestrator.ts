// 原子编排：新建数字员工 = 一次事务（单飞锁 + 快照 + 落盘 + apply + 失败回滚）。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { triggerApply } from "../../lib/config-apply.mjs";
import { ENV_PATH, runtimeEnv, upsertEnv } from "./secrets.js";
import { STORE_DIR, readStore, writeStore, type AgentEntry } from "./store.js";
import { renderWorkspace, workspaceDir } from "./workspace.js";

// —— 进程级单飞锁：整段「装配→落盘→apply」串行，避免并发交错 ——
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function toolsForRole(role: "employee" | "admin"): { allow: string[]; deny: string[] } {
  return role === "admin"
    ? {
        allow: ["memory_search", "memory_get", "memory_write", "memory_delete", "exec"],
        deny: ["gateway", "sessions_spawn"],
      }
    : { allow: ["memory_search", "memory_get"], deny: ["memory_write", "memory_delete", "exec"] };
}

const ROLE_LABEL = { employee: "员工面（只读）", admin: "管理面（可写）" } as const;

export interface CreateAgentInput {
  id: string;
  name: string;
  role: "employee" | "admin";
  persona?: string;
  skills: string[];
  channels: Array<{
    domain: string;
    accountId: string;
    account: Record<string, unknown>;
    secrets?: Record<string, string>;
  }>;
}

export type SupportedChannel = "feishu" | "dingtalk-connector";

export interface AgentDraft {
  id: string;
  name: string;
  role: "employee" | "admin";
  persona?: string;
  skills: string[];
  domain: SupportedChannel;
  accountId?: string;
}

export interface ChannelCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ApplyResult {
  status: "success" | "failed" | "pending";
  message?: string;
  version?: string;
  mode?: string;
}

function validateSkills(skills: unknown): asserts skills is string[] {
  if (!Array.isArray(skills) || skills.length === 0) throw new Error("至少分配一个技能");
  for (const skill of skills) {
    if (typeof skill !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(skill)) throw new Error(`技能 ID 非法：${String(skill)}`);
    if (!existsSync(join(STATE_DIR, "skills", skill, "SKILL.md"))) throw new Error(`技能不存在：${skill}`);
  }
}

export function validateAgentDraft(input: AgentDraft): void {
  if (typeof input.id !== "string" || !/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
  if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
  if (input.persona !== undefined && typeof input.persona !== "string") throw new Error("persona 非法");
  validateSkills(input.skills);
  if (input.domain !== "feishu" && input.domain !== "dingtalk-connector") throw new Error("渠道非法");
  if (input.accountId !== undefined && (typeof input.accountId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.accountId))) {
    throw new Error("账号 ID 非法");
  }

  const store = readStore();
  const accountId = input.accountId || input.id;
  if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);
  if (store.channels[input.domain]?.[accountId]) {
    throw new Error(`渠道账号已存在：${input.domain}/${accountId}`);
  }
}

export function assembleCreateInput(draft: AgentDraft, credentials: ChannelCredentials): CreateAgentInput {
  validateAgentDraft(draft);
  if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim()) throw new Error("渠道凭证不能为空");
  const up = draft.id.toUpperCase().replace(/-/g, "_");
  const accountId = draft.accountId || draft.id;
  if (draft.domain === "feishu") {
    return {
      ...draft,
      channels: [{
        domain: draft.domain,
        accountId,
        account: {
          appId: `\${FEISHU_${up}_APP_ID}`,
          appSecret: `\${FEISHU_${up}_APP_SECRET}`,
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: true,
        },
        secrets: {
          [`FEISHU_${up}_APP_ID`]: credentials.clientId,
          [`FEISHU_${up}_APP_SECRET`]: credentials.clientSecret,
        },
      }],
    };
  }
  return {
    ...draft,
    channels: [{
      domain: draft.domain,
      accountId,
      account: {
        enabled: true,
        name: draft.name,
        clientId: `\${DINGTALK_${up}_CLIENT_ID}`,
        clientSecret: `\${DINGTALK_${up}_CLIENT_SECRET}`,
        dmPolicy: "open",
        groupPolicy: "open",
        requireMention: true,
      },
      secrets: {
        [`DINGTALK_${up}_CLIENT_ID`]: credentials.clientId,
        [`DINGTALK_${up}_CLIENT_SECRET`]: credentials.clientSecret,
      },
    }],
  };
}

async function verifyChannel(domain: string, accountId: string): Promise<void> {
  let lastError = "目标账号尚未就绪";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn("openclaw", ["channels", "status", "--probe", "--json", "--timeout", "15000"], {
          env: { ...process.env, ...runtimeEnv(), OPENCLAW_CONFIG_PATH: join(STATE_DIR, "openclaw.json") },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `channel probe exit ${code}`)));
      });
      const status = JSON.parse(output);
      const account = status?.channelAccounts?.[domain]?.find((a: any) => a.accountId === accountId);
      if (!account) throw new Error(`渠道验证未找到目标账号：${domain}/${accountId}`);
      if (domain === "feishu") {
        if (account.configured && account.running && account.probe?.ok === true) return;
        lastError = account.probe?.error || account.lastError || "未运行";
      } else {
        if (account.configured && account.running && account.connected) return;
        lastError = account.lastError || "未连接";
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${domain === "feishu" ? "飞书" : "钉钉"}渠道验证失败：${lastError}`);
}

/** 列表（含绑定渠道汇总）。 */
export function listAgents() {
  const { agents, bindings } = readStore();
  return agents.map((a) => ({
    id: a.id,
    role: a.role,
    name: a.name || a.id,
    default: Boolean(a.default),
    skills: a.skills || [],
    channels: bindings
      .filter((b) => b.agentId === a.id)
      .map((b) => ({ domain: b.match.channel, accountId: b.match.accountId })),
  }));
}

/** 创建一个数字员工（原子）。 */
export async function createAgent(
  input: CreateAgentInput,
  onApplied?: () => void,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withLock(async () => {
    // —— 轻量输入预检（深度 ADR 校验由 apply 的 generate-config --check-fs 权威把关）——
    if (typeof input.id !== "string" || !/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
    if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
    validateSkills(input.skills);
    if (!Array.isArray(input.channels) || input.channels.length === 0) throw new Error("至少接入一个渠道");

    const store = readStore();
    if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);
    for (const ch of input.channels) {
      if (store.channels[ch.domain]?.[ch.accountId]) {
        throw new Error(`渠道账号已存在：${ch.domain}/${ch.accountId}`);
      }
    }
    const wsDir = workspaceDir(input.id);
    if (existsSync(wsDir)) throw new Error(`agent workspace 已存在：${wsDir}`);

    // —— 快照（store + .env + 是否新建 .env），供回滚 ——
    const snap = mkdtempSync(join(tmpdir(), "orch-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));

    try {
      // 1. workspace 文件
      renderWorkspace(input.id, {
        ID: input.id,
        NAME: input.name,
        ROLE: input.role,
        ROLE_LABEL: ROLE_LABEL[input.role],
        PERSONA: input.persona || "（未填写人设）",
        SKILLS: input.skills.map((s) => `- ${s}`).join("\n"),
      });

      // 2. 秘钥（键级 upsert）
      const secretEntries: Record<string, string> = {};
      for (const ch of input.channels) if (ch.secrets) Object.assign(secretEntries, ch.secrets);
      upsertEnv(secretEntries);

      // 3. store（role→tools 默认；ADR-003 硬隔离）
      const agentEntry: AgentEntry = {
        id: input.id,
        role: input.role,
        name: input.name,
        workspace: `~/.openclaw/workspaces/${input.id}`,
        skills: input.skills,
        heartbeat: {},
        tools: toolsForRole(input.role),
      };
      store.agents.push(agentEntry);
      for (const ch of input.channels) {
        store.channels[ch.domain] ??= {};
        store.channels[ch.domain][ch.accountId] = ch.account;
        store.bindings.push({ agentId: input.id, match: { channel: ch.domain, accountId: ch.accountId } });
      }
      writeStore(store);

      // 4. apply（权威校验 + 重启 + 探活 + runtime 回滚）
      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`上线失败：${apply.message || apply.status}`);
      onApplied?.();
      for (const ch of input.channels) await verifyChannel(ch.domain, ch.accountId);

      rmSync(snap, { recursive: true, force: true });
      return { agent: agentEntry, apply };
    } catch (err) {
      // —— 回滚 store / .env / workspace ——
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        if (envExisted) cpSync(join(snap, ".env"), ENV_PATH);
        else if (existsSync(ENV_PATH)) rmSync(ENV_PATH, { force: true });
        rmSync(wsDir, { recursive: true, force: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
        if (rollbackApply.status !== "success") {
          rollbackMessage = `恢复原配置失败：${rollbackApply.message || rollbackApply.status}`;
        }
      } catch (rollbackErr) {
        rollbackMessage = `恢复原配置失败：${(rollbackErr as Error).message}`;
      } finally {
        rmSync(snap, { recursive: true, force: true });
      }
      throw new Error(`${(err as Error).message}；${rollbackMessage}`);
    }
  });
}

export async function createAgentFromCredentials(
  draft: AgentDraft,
  credentials: ChannelCredentials,
  onApplied?: () => void,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return createAgent(assembleCreateInput(draft, credentials), onApplied);
}
