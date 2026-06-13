// 原子编排：新建数字员工 = 一次事务（单飞锁 + 快照 + 落盘 + apply + 失败回滚）。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { triggerApply } from "./config-apply.js";
import { unbindAgentFromKnowledge } from "./knowledge.js";
import { ENV_PATH, removeEnv, runtimeEnv, upsertEnv } from "./secrets.js";
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

const ROLE_LABEL = { employee: "员工", admin: "管理员" } as const;
const BUILTIN_AGENT_IDS = new Set(["hr-employee", "hr-admin"]);

function isProtectedAgent(agent: AgentEntry): boolean {
  return Boolean(agent.default) || BUILTIN_AGENT_IDS.has(agent.id);
}

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

export interface UpdateAgentInput {
  name: string;
  role: "employee" | "admin";
  persona?: string;
  skills: string[];
  addChannel?: {
    domain: SupportedChannel;
    accountId?: string;
    credentials: ChannelCredentials;
  };
  removeChannels?: Array<{
    domain: SupportedChannel;
    accountId: string;
  }>;
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
  return { ...draft, channels: [assembleChannel(draft, credentials)] };
}

function assembleChannel(
  draft: AgentDraft,
  credentials: ChannelCredentials,
): CreateAgentInput["channels"][number] {
  const up = draft.id.toUpperCase().replace(/-/g, "_");
  const accountId = draft.accountId || draft.id;
  if (draft.domain === "feishu") {
    return {
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
    };
  }
  return {
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
    persona: typeof a.persona === "string" ? a.persona : "",
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
        persona: input.persona || "",
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

function validateUpdateInput(input: UpdateAgentInput): void {
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
  if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
  if (input.persona !== undefined && typeof input.persona !== "string") throw new Error("persona 非法");
  validateSkills(input.skills);
  if (input.addChannel) {
    if (input.addChannel.domain !== "feishu" && input.addChannel.domain !== "dingtalk-connector") {
      throw new Error("新增渠道非法");
    }
    if (
      input.addChannel.accountId !== undefined &&
      (typeof input.addChannel.accountId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.addChannel.accountId))
    ) {
      throw new Error("新增渠道账号 ID 非法");
    }
    if (
      !input.addChannel.credentials?.clientId?.trim() ||
      !input.addChannel.credentials?.clientSecret?.trim()
    ) {
      throw new Error("新增渠道凭证不能为空");
    }
  }
  if (input.removeChannels !== undefined && !Array.isArray(input.removeChannels)) throw new Error("解绑渠道格式非法");
  for (const channel of input.removeChannels || []) {
    if (channel.domain !== "feishu" && channel.domain !== "dingtalk-connector") throw new Error("解绑渠道非法");
    if (typeof channel.accountId !== "string" || !channel.accountId.trim()) throw new Error("解绑渠道账号 ID 不能为空");
  }
}

function workspaceVars(id: string, input: UpdateAgentInput): Record<string, string> {
  return {
    ID: id,
    NAME: input.name.trim(),
    ROLE: input.role,
    ROLE_LABEL: ROLE_LABEL[input.role],
    PERSONA: input.persona?.trim() || "（未填写人设）",
    SKILLS: input.skills.map((s) => `- ${s}`).join("\n"),
  };
}

/** 修改数字员工资料、权限与渠道配置；ID 和 MEMORY.md 保持不变。 */
export async function updateAgent(
  id: string,
  input: UpdateAgentInput,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withLock(async () => {
    validateUpdateInput(input);
    const store = readStore();
    const index = store.agents.findIndex((a) => a.id === id);
    if (index < 0) throw new Error(`agent 不存在：${id}`);
    const wsDir = workspaceDir(id);
    if (!existsSync(wsDir)) throw new Error(`agent workspace 不存在：${wsDir}`);
    let addedChannel: CreateAgentInput["channels"][number] | undefined;
    const removeKeys = new Set((input.removeChannels || []).map((channel) => `${channel.domain}/${channel.accountId}`));
    for (const channel of input.removeChannels || []) {
      if (!store.bindings.some(
        (binding) =>
          binding.agentId === id &&
          binding.match.channel === channel.domain &&
          binding.match.accountId === channel.accountId,
      )) {
        throw new Error(`数字员工未接入渠道账号：${channel.domain}/${channel.accountId}`);
      }
    }
    if (input.addChannel) {
      const accountId = input.addChannel.accountId || id;
      if (store.bindings.some(
        (b) =>
          b.agentId === id &&
          b.match.channel === input.addChannel!.domain &&
          !removeKeys.has(`${b.match.channel}/${b.match.accountId}`),
      )) {
        throw new Error(`数字员工已接入渠道：${input.addChannel.domain}`);
      }
      if (
        store.channels[input.addChannel.domain]?.[accountId] &&
        !removeKeys.has(`${input.addChannel.domain}/${accountId}`)
      ) {
        throw new Error(`渠道账号已存在：${input.addChannel.domain}/${accountId}`);
      }
      const assembled = assembleChannel(
        {
          id,
          name: input.name.trim(),
          role: input.role,
          persona: input.persona,
          skills: input.skills,
          domain: input.addChannel.domain,
          accountId,
        },
        input.addChannel.credentials,
      );
      addedChannel = assembled;
    }

    const snap = mkdtempSync(join(tmpdir(), "orch-update-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    cpSync(wsDir, join(snap, "workspace"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));
    try {
      const current = store.agents[index];
      const next: AgentEntry = {
        ...current,
        name: input.name.trim(),
        role: input.role,
        persona: input.persona?.trim() || "",
        skills: input.skills,
        tools: toolsForRole(input.role),
      };
      store.agents[index] = next;
      renderWorkspace(id, workspaceVars(id, input), { preserveMemory: true });
      const removedSecretKeys = new Set<string>();
      if (removeKeys.size > 0) {
        store.bindings = store.bindings.filter((binding) => {
          return binding.agentId !== id || !removeKeys.has(`${binding.match.channel}/${binding.match.accountId}`);
        });
        for (const channel of input.removeChannels || []) {
          const stillUsed = store.bindings.some(
            (binding) => binding.match.channel === channel.domain && binding.match.accountId === channel.accountId,
          );
          if (stillUsed) continue;
          const account = store.channels[channel.domain]?.[channel.accountId];
          if (account) secretKeysIn(account, removedSecretKeys);
          delete store.channels[channel.domain]?.[channel.accountId];
        }
        removeEnv(removedSecretKeys);
      }
      if (addedChannel) {
        upsertEnv(addedChannel.secrets || {});
        store.channels[addedChannel.domain] ??= {};
        store.channels[addedChannel.domain][addedChannel.accountId] = addedChannel.account;
        store.bindings.push({
          agentId: id,
          match: { channel: addedChannel.domain, accountId: addedChannel.accountId },
        });
      }
      writeStore(store);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`更新失败：${apply.message || apply.status}`);
      if (addedChannel) await verifyChannel(addedChannel.domain, addedChannel.accountId);
      rmSync(snap, { recursive: true, force: true });
      return { agent: next, apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        if (envExisted) cpSync(join(snap, ".env"), ENV_PATH);
        else rmSync(ENV_PATH, { force: true });
        rmSync(wsDir, { recursive: true, force: true });
        cpSync(join(snap, "workspace"), wsDir, { recursive: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
        if (rollbackApply.status !== "success") rollbackMessage = `恢复原配置失败：${rollbackApply.message || rollbackApply.status}`;
      } catch (rollbackErr) {
        rollbackMessage = `恢复原配置失败：${(rollbackErr as Error).message}`;
      } finally {
        rmSync(snap, { recursive: true, force: true });
      }
      throw new Error(`${(err as Error).message}；${rollbackMessage}`);
    }
  });
}

function secretKeysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) out.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) secretKeysIn(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) secretKeysIn(item, out);
  }
  return out;
}

/** 删除非内置数字员工，并清理其独占渠道、凭据、workspace 与知识库绑定。 */
export async function deleteAgent(id: string): Promise<{ apply: ApplyResult }> {
  return withLock(async () => {
    const store = readStore();
    const agent = store.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`agent 不存在：${id}`);
    if (isProtectedAgent(agent)) throw new Error("内置数字员工不能删除");
    const wsDir = workspaceDir(id);
    const snap = mkdtempSync(join(tmpdir(), "orch-delete-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));
    if (existsSync(wsDir)) cpSync(wsDir, join(snap, "workspace"), { recursive: true });

    try {
      const removedBindings = store.bindings.filter((b) => b.agentId === id);
      store.agents = store.agents.filter((a) => a.id !== id);
      store.bindings = store.bindings.filter((b) => b.agentId !== id);
      const removedSecretKeys = new Set<string>();
      for (const binding of removedBindings) {
        const { channel, accountId } = binding.match;
        const stillUsed = store.bindings.some((b) => b.match.channel === channel && b.match.accountId === accountId);
        if (stillUsed) continue;
        const account = store.channels[channel]?.[accountId];
        if (account) secretKeysIn(account, removedSecretKeys);
        delete store.channels[channel]?.[accountId];
      }
      writeStore(store);
      unbindAgentFromKnowledge(id);
      removeEnv(removedSecretKeys);
      rmSync(wsDir, { recursive: true, force: true });

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`删除失败：${apply.message || apply.status}`);
      rmSync(join(STATE_DIR, "agents", id), { recursive: true, force: true });
      rmSync(snap, { recursive: true, force: true });
      return { apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        if (envExisted) cpSync(join(snap, ".env"), ENV_PATH);
        else rmSync(ENV_PATH, { force: true });
        rmSync(wsDir, { recursive: true, force: true });
        if (existsSync(join(snap, "workspace"))) cpSync(join(snap, "workspace"), wsDir, { recursive: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR })) as ApplyResult;
        if (rollbackApply.status !== "success") rollbackMessage = `恢复原配置失败：${rollbackApply.message || rollbackApply.status}`;
      } catch (rollbackErr) {
        rollbackMessage = `恢复原配置失败：${(rollbackErr as Error).message}`;
      } finally {
        rmSync(snap, { recursive: true, force: true });
      }
      throw new Error(`${(err as Error).message}；${rollbackMessage}`);
    }
  });
}
