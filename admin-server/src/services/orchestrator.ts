// 原子编排：新建数字员工 = 一次事务（单飞锁 + 快照 + 落盘 + apply + 失败回滚）。
//
// ADR-013（#57）：将"员工档案"与"渠道绑定"拆分为两个独立原子操作。
//   - createAgentProfile / updateAgentProfile：只处理员工资料（name/role/profile/skills），可创建/更新无技能无渠道员工
//   - bindAgentToChannel / unbindAgentFromChannel：渠道账号绑定/解绑，独立原子
//   - createAgent / updateAgent（legacy）：保留旧签名，内部走新拆分路径，供历史调用方与测试兼容
//   - 派生状态 pendingSkills / pendingChannels 实时计算，不入 store
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { triggerApply } from "./config-apply.js";
import { unbindAgentFromKnowledge, readKnowledgeStore } from "./knowledge.js";
import { ENV_PATH, runtimeEnv, upsertEnv } from "./secrets.js";
import { STORE_DIR, readStore, writeStore, type AgentEntry } from "./store.js";
import { renderWorkspace, workspaceDir } from "./workspace.js";
import { getSkill, listSkillMetas, type SkillMeta } from "./skills.js";

// —— 进程级单飞锁：整段「装配→落盘→apply」串行，避免并发交错 ——
let lock: Promise<unknown> = Promise.resolve();
export function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ADR-012：内置 memorySearch/memory_* 已退役，新建 agent 不再授予 memory 工具。
// 知识检索由 ADR-011 生成器按 knowledge.json 绑定注入 kb-<id>__knowledge_search(+_import)。
// employee → 空 allowlist（最小权限，绑库后才得 knowledge_search）；admin → 仅 exec。
// memory_write/delete 始终入 deny（ADR-003 兜底 + ADR-010 已退役）。
function toolsForRole(role: "employee" | "admin"): { allow: string[]; deny: string[] } {
  return role === "admin"
    ? { allow: ["exec"], deny: ["gateway", "sessions_spawn", "memory_write", "memory_delete"] }
    : { allow: [], deny: ["memory_write", "memory_delete", "exec"] };
}

const ROLE_LABEL = { employee: "员工", admin: "管理员" } as const;

// 空白起步后无永久内置员工：所有员工都从系统模板创建、可删除可重建。
// 仅保留对「默认员工」的结构性保护（当前无 agent 被设为 default，等于全部可删）。
function isProtectedAgent(agent: AgentEntry): boolean {
  return Boolean(agent.default);
}

export interface CreateAgentInput {
  id: string;
  name: string;
  role: "employee" | "admin";
  /** @deprecated 由 profile.personality 取代。 */
  persona?: string;
  /** 结构化职业档案（ADR-013）。 */
  profile?: AgentProfile;
  /** ADR-013 允许空数组（待配置技能）。 */
  skills: string[];
  channels: Array<{
    domain: string;
    accountId: string;
    account: Record<string, unknown>;
    secrets?: Record<string, string>;
    existing?: boolean;
  }>;
}

/** 结构化职业档案（ADR-013 §数据与接口）。所有字段可选。 */
export interface AgentProfile {
  jobTitle?: string;
  responsibilities?: string;
  personality?: string;
  tone?: string;
  boundaries?: string;
  [k: string]: unknown;
}

/** 渠道绑定/解绑独立操作的入参（ADR-013 #57）。 */
export interface BindChannelInput {
  agentId: string;
  domain: SupportedChannel;
  accountId?: string;
  credentials?: ChannelCredentials;
  existing?: boolean;
  account?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export type SupportedChannel = "feishu" | "dingtalk-connector";

/** domain ↔ 资产 type 互转（ADR-013 #64：channels.json 顶层数组按 type 分桶）。 */
function domainToType(domain: SupportedChannel): "feishu" | "dingtalk" {
  return domain === "dingtalk-connector" ? "dingtalk" : "feishu";
}
function findChannelAsset(
  channels: Array<{ id: string; type: "feishu" | "dingtalk"; [k: string]: unknown }>,
  domain: SupportedChannel,
  accountId: string,
): { id: string; type: "feishu" | "dingtalk"; [k: string]: unknown } | undefined {
  const type = domainToType(domain);
  return channels.find((c) => c.type === type && c.id === accountId);
}
function upsertChannelAsset(
  channels: Array<{ id: string; type: "feishu" | "dingtalk"; [k: string]: unknown }>,
  domain: SupportedChannel,
  accountId: string,
  patch: Record<string, unknown>,
): void {
  const type = domainToType(domain);
  const idx = channels.findIndex((c) => c.type === type && c.id === accountId);
  if (idx >= 0) Object.assign(channels[idx] as object, patch);
  else channels.push({ id: accountId, type, ...patch } as any);
}

export interface AgentDraft {
  id: string;
  name: string;
  role: "employee" | "admin";
  /** @deprecated 由 profile.personality 取代。 */
  persona?: string;
  profile?: AgentProfile;
  /** ADR-013 允许空数组。 */
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
  /** @deprecated 由 profile.personality 取代。 */
  persona?: string;
  profile?: AgentProfile;
  skills: string[];
  addChannel?: {
    domain: SupportedChannel;
    accountId?: string;
    credentials?: ChannelCredentials;
    existing?: boolean;
  };
  removeChannels?: Array<{
    domain: SupportedChannel;
    accountId: string;
  }>;
}

/** 派生状态（ADR-013 #57）：按 store 实时计算，不入盘。 */
export interface AgentDerivedStatus {
  pendingSkills: boolean;
  pendingChannels: boolean;
}

function validateSkills(skills: unknown, { allowEmpty = false }: { allowEmpty?: boolean } = {}): asserts skills is string[] {
  if (!Array.isArray(skills)) throw new Error("skills 必须为数组");
  if (!allowEmpty && skills.length === 0) throw new Error("至少分配一个技能");
  for (const skill of skills) {
    if (typeof skill !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(skill)) throw new Error(`技能 ID 非法：${String(skill)}`);
    if (!existsSync(join(STATE_DIR, "skills", skill, "SKILL.md"))) throw new Error(`技能不存在：${skill}`);
  }
}

/** 把旧 persona 隐式映射为 profile.personality（ADR-013 向后兼容）。 */
function legacyToProfile(input: { persona?: string; profile?: AgentProfile }): AgentProfile | undefined {
  if (input.profile) {
    const limits: Record<string, number> = { jobTitle: 60, responsibilities: 2000, personality: 400, tone: 400, boundaries: 1200 };
    return Object.fromEntries(Object.entries(limits).flatMap(([key, limit]) => {
      const value = input.profile?.[key];
      if (value === undefined) return [];
      if (typeof value !== "string") throw new Error(`profile.${key} 必须为字符串`);
      return [[key, value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, limit)]];
    }));
  }
  if (input.persona) return { personality: input.persona };
  return undefined;
}

/** 由 pending 标志派生出"待配置"状态提示行（AGENTS.md 渲染用，ADR-013）。 */
function pendingStatusBlock(pendingSkills: boolean, pendingChannels: boolean): string {
  const items: string[] = [];
  if (pendingSkills) items.push("- 暂未分配技能。招募后在「技能配置」页分配，或通过 /api/config/agents/:id/skills 写入。");
  if (pendingChannels) items.push("- 暂未接入渠道。招募后在「渠道管理」页绑定账号。");
  if (items.length === 0) return "";
  return `## 当前状态\n\n${items.join("\n")}\n`;
}

/**
 * 渲染 TOOLS.md 的「知识库工具」段落。
 * fix/usage-bugs：KB 解绑后 AI 仍以为有 knowledge_search → 用 exec curl 绕路。
 *   → 与运行时 tools.allow 一致地"事实陈述"工具是否在场。
 *   不绑库 / 解绑后：明确告诉 AI 该能力当前关闭、不要绕路。
 * ADR-018：去 HR 专属措辞 —— 不写「HR 政策」「HR 知识库」，改通用「事实/依据」。
 */
export function knowledgeToolsBlock(role: "employee" | "admin", hasKbBinding: boolean): string {
  if (!hasKbBinding) {
    return [
      "### 知识库工具：当前未绑定",
      "",
      "你的工具清单中**没有任何**知识库检索/导入工具。需要文档依据的问题暂时无法检索。",
      "",
      "- 收到需要文档依据的问题：如实告知「我目前未绑定知识库，无法基于授权资料回答，建议您联系管理员」。",
      "- **绝不**用 `exec` / `curl` / 任何网络请求自行探测 FastGPT 或其他知识库 API。",
    ].join("\n");
  }
  const lines = [
    "### 知识库工具",
    "",
    "知识库经 FastGPT MCP 工具访问（ADR-010）。下列工具在你的运行时 allowlist 中：",
    "",
    "- `knowledge_search`：检索你绑定的知识库（FastGPT），返回命中切片",
  ];
  if (role === "admin") {
    lines.push("- `knowledge_import`：导入文档到知识库（仅管理员岗位）");
  }
  lines.push("");
  lines.push("文档托管在 **FastGPT**；平台无本地归档/chunk 副本（ADR-010）。始终以 `knowledge_search` 的实际返回为准，不编造字段或内容。");
  return lines.join("\n");
}

/**
 * 派生 agent 当前是否绑定可用的 FastGPT 知识库。镜像生成器 `agentHasFastgptBinding`
 * 与 admin-server `resolveDatasetIdsForAgent`：只认 provider=fastgpt + externalKbId 非空 + boundAgents 含该 agent。
 * 旧部署无 knowledge.json 时退默认（与 generator 兜底一致）：仅 default agent 视为已绑定。
 */
export function agentHasKbBinding(agentId: string): boolean {
  const { agents } = readStore();
  const defaultAgent = agents.find((a) => a.default)?.id;
  let store: ReturnType<typeof readKnowledgeStore>;
  try {
    store = readKnowledgeStore();
  } catch {
    return Boolean(defaultAgent) && agentId === defaultAgent;
  }
  const kbs = Array.isArray(store.knowledgeBases) ? store.knowledgeBases : [];
  return kbs.some(
    (kb) =>
      kb.provider === "fastgpt" &&
      Boolean(kb.externalKbId) &&
      Array.isArray(kb.boundAgents) &&
      kb.boundAgents.includes(agentId),
  );
}

export function validateAgentDraft(input: AgentDraft, opts: { allowEmptySkills?: boolean; allowNoChannel?: boolean } = {}): void {
  if (typeof input.id !== "string" || !/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
  if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
  if (input.persona !== undefined && typeof input.persona !== "string") throw new Error("persona 非法");
  validateSkills(input.skills, { allowEmpty: opts.allowEmptySkills });
  if (!opts.allowNoChannel) {
    if (input.domain !== "feishu" && input.domain !== "dingtalk-connector") throw new Error("渠道非法");
    if (input.accountId !== undefined && (typeof input.accountId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.accountId))) {
      throw new Error("账号 ID 非法");
    }
  }
  const store = readStore();
  if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);
}

export function assembleCreateInput(draft: AgentDraft, credentials: ChannelCredentials): CreateAgentInput {
  validateAgentDraft(draft);
  if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim()) throw new Error("渠道凭证不能为空");
  return { ...draft, channels: [assembleChannel(draft, credentials)] };
}

export function assembleExistingAccountInput(draft: AgentDraft): CreateAgentInput {
  validateAgentDraft(draft);
  return { ...draft, channels: [assembleExistingChannel(draft)] };
}

function assembleExistingChannel(draft: AgentDraft): CreateAgentInput["channels"][number] {
  const accountId = draft.accountId?.trim();
  if (!accountId) throw new Error("请选择已有渠道账号");
  const store = readStore();
  const asset = findChannelAsset(store.channels, draft.domain, accountId);
  const account = asset?.account as Record<string, unknown> | undefined;
  if (!account) throw new Error(`渠道账号不存在：${draft.domain}/${accountId}`);
  const occupied = store.bindings.find(
    (binding) => binding.match.channel === draft.domain && binding.match.accountId === accountId,
  );
  if (occupied) throw new Error(`渠道账号已被 ${occupied.agentId} 占用：${draft.domain}/${accountId}`);
  return { domain: draft.domain, accountId, account, existing: true };
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

/** 列表（含绑定渠道汇总 + 派生状态 pendingSkills/pendingChannels，ADR-013）。 */
export function listAgents() {
  const { agents, bindings } = readStore();
  return agents.map((a) => {
    const channels = bindings
      .filter((b) => b.agentId === a.id)
      .map((b) => ({ domain: b.match.channel, accountId: b.match.accountId }));
    const skills = a.skills || [];
    const profile = a.profile;
    return {
      id: a.id,
      role: a.role,
      name: a.name || a.id,
      /** @deprecated 由 profile.personality 取代。读取时映射，保证旧调用方仍能拿到 personality。 */
      persona: typeof a.persona === "string"
        ? a.persona
        : (typeof profile?.personality === "string" ? profile.personality : ""),
      profile,
      default: Boolean(a.default),
      skills,
      channels,
      derived: {
        pendingSkills: skills.length === 0,
        pendingChannels: channels.length === 0,
      } satisfies AgentDerivedStatus,
    };
  });
}

/**
 * 按当前 store + KB 绑定状态重新渲染指定 agent 的 workspace（保留 MEMORY.md）。
 * fix/usage-bugs：KB 绑定/解绑后必须刷新 TOOLS.md 与 AGENTS.md，否则 AI 仍以为 knowledge_*
 * 工具可用 → 解绑后用 exec 绕路撞 FastGPT 端点。无视 agent 是否存在 / workspace 是否存在
 * （静默跳过），调用方串到 PUT /knowledge/bindings 链路里，挂掉不应阻塞绑定主流程。
 */
export function rerenderAgentWorkspace(agentId: string): void {
  const store = readStore();
  const agent = store.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const wsDir = workspaceDir(agentId);
  if (!existsSync(wsDir)) return;
  const channels = store.bindings
    .filter((b) => b.agentId === agentId)
    .map((b) => ({ domain: b.match.channel, accountId: b.match.accountId }));
  const skills = agent.skills ?? [];
  const profile = agent.profile;
  const role = agent.role;
  const name = agent.name || agentId;
  renderWorkspace(agentId, {
    ID: agentId,
    NAME: name,
    ROLE: role,
    ROLE_LABEL: ROLE_LABEL[role],
    JOB_TITLE: profile?.jobTitle || ROLE_LABEL[role],
    RESPONSIBILITIES: profile?.responsibilities || "（未填写职责）",
    PERSONA: profile?.personality || "（未填写人设）",
    TONE: profile?.tone || "（未指定语气）",
    BOUNDARIES: profile?.boundaries || "（未指定边界）",
    PROFILE: profile ? JSON.stringify(profile, null, 2) : "（未配置职业档案）",
    SKILLS: skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "（待配置技能）",
    PENDING_STATUS: pendingStatusBlock(skills.length === 0, channels.length === 0),
    PENDING_SKILLS: skills.length === 0 ? "true" : "false",
    PENDING_CHANNELS: channels.length === 0 ? "true" : "false",
    KNOWLEDGE_TOOLS_BLOCK: knowledgeToolsBlock(role, agentHasKbBinding(agentId)),
  }, { preserveMemory: true });
}

/**
 * 仅创建数字员工档案（ADR-013 #57）。
 * 允许空 skills + 无渠道绑定；状态显示"待配置技能 / 待接入渠道"。
 * 不创建/绑定任何渠道账号；渠道操作走 bindAgentToChannel。
 */
export async function createAgentProfile(
  input: {
    id: string;
    name: string;
    role: "employee" | "admin";
    /** @deprecated 由 profile.personality 取代。 */
    persona?: string;
    profile?: AgentProfile;
  },
  onApplied?: () => void,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withConfigLock(async () => {
    const skills: string[] = [];
    if (typeof input.id !== "string" || !/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
    if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
    if (input.persona !== undefined && typeof input.persona !== "string") throw new Error("persona 非法");

    const store = readStore();
    if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);
    const wsDir = workspaceDir(input.id);
    if (existsSync(wsDir)) throw new Error(`agent workspace 已存在：${wsDir}`);

    const snap = mkdtempSync(join(tmpdir(), "orch-profile-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });

    try {
      const profile = legacyToProfile({ persona: input.persona, profile: input.profile });
      if (!profile?.jobTitle) throw new Error("profile.jobTitle 不能为空");
      const jobTitle = profile?.jobTitle || ROLE_LABEL[input.role];
      renderWorkspace(input.id, {
        ID: input.id,
        NAME: input.name,
        ROLE: input.role,
        ROLE_LABEL: ROLE_LABEL[input.role],
        JOB_TITLE: jobTitle,
        RESPONSIBILITIES: profile?.responsibilities || "（未填写职责）",
        PERSONA: profile?.personality || "（未填写人设）",
        TONE: profile?.tone || "（未指定语气）",
        BOUNDARIES: profile?.boundaries || "（未指定边界）",
        PROFILE: profile ? JSON.stringify(profile, null, 2) : "（未配置职业档案）",
        SKILLS: skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "（待配置技能）",
        PENDING_STATUS: pendingStatusBlock(skills.length === 0, true),
        PENDING_SKILLS: skills.length === 0 ? "true" : "false",
        PENDING_CHANNELS: "true",
        KNOWLEDGE_TOOLS_BLOCK: knowledgeToolsBlock(input.role, agentHasKbBinding(input.id)),
      });

      const agentEntry: AgentEntry = {
        id: input.id,
        role: input.role,
        name: input.name,
        profile,
        workspace: `~/.openclaw/workspaces/${input.id}`,
        skills,
        heartbeat: {},
        tools: toolsForRole(input.role),
      };
      store.agents.push(agentEntry);
      writeStore(store);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.create" })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`上线失败：${apply.message || apply.status}`);
      onApplied?.();

      rmSync(snap, { recursive: true, force: true });
      return { agent: agentEntry, apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        rmSync(wsDir, { recursive: true, force: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.create" })) as ApplyResult;
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

/**
 * 渠道绑定（ADR-013 #57 独立原子操作）。
 * 适用：① 新建账号并绑定；② 复用现有空闲账号。
 * 同一 agent 在同渠道下已绑其他账号 → 409；同账号已绑他 agent → 409。
 */
export async function bindAgentToChannel(
  input: BindChannelInput,
  onApplied?: () => void,
): Promise<{ apply: ApplyResult }> {
  return withConfigLock(async () => {
    if (!input.agentId) throw new Error("agentId 不能为空");
    if (input.domain !== "feishu" && input.domain !== "dingtalk-connector") {
      throw new Error(`渠道非法：${input.domain}`);
    }
    if (input.accountId !== undefined && (typeof input.accountId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.accountId))) {
      throw new Error("账号 ID 非法");
    }
    if (input.existing) {
      if (!input.accountId) throw new Error("复用账号必须指定 accountId");
    } else {
      if (!input.credentials?.clientId?.trim() || !input.credentials?.clientSecret?.trim()) {
        throw new Error("新建渠道凭证不能为空");
      }
    }

    const store = readStore();
    const agent = store.agents.find((a) => a.id === input.agentId);
    if (!agent) throw new Error(`agent 不存在：${input.agentId}`);

    const accountId = input.accountId || input.agentId;
    const existingAccount = findChannelAsset(store.channels, input.domain, accountId)?.account as Record<string, unknown> | undefined;

    if (input.existing) {
      if (!existingAccount) throw new Error(`渠道账号不存在：${input.domain}/${accountId}`);
    } else {
      if (existingAccount) throw new Error(`渠道账号已存在：${input.domain}/${accountId}`);
    }

    const occupiedBy = store.bindings.find(
      (b) => b.match.channel === input.domain && b.match.accountId === accountId,
    );
    if (occupiedBy) throw new Error(`渠道账号已被 ${occupiedBy.agentId} 占用：${input.domain}/${accountId}`);

    const sameDomainBinding = store.bindings.find(
      (b) => b.agentId === input.agentId && b.match.channel === input.domain,
    );

    const snap = mkdtempSync(join(tmpdir(), "orch-bind-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));

    try {
      let account: Record<string, unknown> | undefined = input.account;
      let secrets: Record<string, string> | undefined = input.secrets;
      if (!input.existing) {
        const draft = {
          id: input.agentId,
          name: agent.name || input.agentId,
          role: agent.role,
          persona: agent.persona,
          skills: agent.skills,
          domain: input.domain,
          accountId,
        };
        const assembled = assembleChannel(draft, input.credentials!);
        account = assembled.account;
        secrets = assembled.secrets;
      } else {
        account = existingAccount;
      }

      if (secrets) upsertEnv(secrets);
      if (account && !input.existing) {
        upsertChannelAsset(store.channels, input.domain, accountId, {
          account,
          displayName: agent.name || input.agentId,
          policy: {
            dmPolicy: (account as any)?.dmPolicy,
            groupPolicy: (account as any)?.groupPolicy,
            requireMention: (account as any)?.requireMention,
          },
          enabled: true,
        });
      }
      if (sameDomainBinding) {
        store.bindings = store.bindings.filter((binding) => binding !== sameDomainBinding);
      }
      store.bindings.push({ agentId: input.agentId, match: { channel: input.domain, accountId } });
      writeStore(store);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "restart", operation: "agent.channel.bind" })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`绑定失败：${apply.message || apply.status}`);
      onApplied?.();

      rmSync(snap, { recursive: true, force: true });
      return { apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        if (envExisted) cpSync(join(snap, ".env"), ENV_PATH);
        else if (existsSync(ENV_PATH)) rmSync(ENV_PATH, { force: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "restart", operation: "agent.channel.bind" })) as ApplyResult;
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

/** 渠道解绑（ADR-013 #57 独立原子操作）。账号与凭证作为平台资产保留。 */
export async function unbindAgentFromChannel(
  agentId: string,
  domain: SupportedChannel,
  accountId: string,
  onApplied?: () => void,
): Promise<{ apply: ApplyResult }> {
  return withConfigLock(async () => {
    if (!agentId) throw new Error("agentId 不能为空");
    if (domain !== "feishu" && domain !== "dingtalk-connector") throw new Error(`渠道非法：${domain}`);
    if (!accountId) throw new Error("accountId 不能为空");

    const store = readStore();
    const binding = store.bindings.find(
      (b) => b.agentId === agentId && b.match.channel === domain && b.match.accountId === accountId,
    );
    if (!binding) throw new Error(`数字员工未接入该渠道：${domain}/${accountId}`);

    const snap = mkdtempSync(join(tmpdir(), "orch-unbind-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    try {
      store.bindings = store.bindings.filter(
        (b) => !(b.agentId === agentId && b.match.channel === domain && b.match.accountId === accountId),
      );
      // 账号与凭证作为平台资产保留（其他 agent 可复用）
      writeStore(store);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "restart", operation: "agent.channel.unbind" })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`解绑失败：${apply.message || apply.status}`);
      onApplied?.();

      rmSync(snap, { recursive: true, force: true });
      return { apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "restart", operation: "agent.channel.unbind" })) as ApplyResult;
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

/** 创建一个数字员工（原子，legacy 路径）。新代码请用 createAgentProfile + bindAgentToChannel 组合（ADR-013）。 */
export async function createAgent(
  input: CreateAgentInput,
  onApplied?: () => void,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withConfigLock(async () => {
    // —— 轻量输入预检（深度 ADR 校验由 apply 的 generate-config --check-fs 权威把关）——
    if (typeof input.id !== "string" || !/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
    if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
    validateSkills(input.skills);
    if (!Array.isArray(input.channels) || input.channels.length === 0) throw new Error("至少接入一个渠道");

    const store = readStore();
    if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);
    for (const ch of input.channels) {
      const existing = findChannelAsset(store.channels, ch.domain as SupportedChannel, ch.accountId);
      if (!ch.existing && existing) {
        throw new Error(`渠道账号已存在：${ch.domain}/${ch.accountId}`);
      }
      if (ch.existing && !existing) throw new Error(`渠道账号不存在：${ch.domain}/${ch.accountId}`);
      if (store.bindings.some((binding) => binding.match.channel === ch.domain && binding.match.accountId === ch.accountId)) {
        throw new Error(`渠道账号已被占用：${ch.domain}/${ch.accountId}`);
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
      const profile = legacyToProfile({ persona: input.persona, profile: input.profile });
      const jobTitle = profile?.jobTitle || ROLE_LABEL[input.role];
      renderWorkspace(input.id, {
        ID: input.id,
        NAME: input.name,
        ROLE: input.role,
        ROLE_LABEL: ROLE_LABEL[input.role],
        JOB_TITLE: jobTitle,
        RESPONSIBILITIES: profile?.responsibilities || "（未填写职责）",
        PERSONA: profile?.personality || "（未填写人设）",
        TONE: profile?.tone || "（未指定语气）",
        BOUNDARIES: profile?.boundaries || "（未指定边界）",
        PROFILE: profile ? JSON.stringify(profile, null, 2) : "（未配置职业档案）",
        SKILLS: input.skills.map((s) => `- ${s}`).join("\n"),
        PENDING_STATUS: "",
        PENDING_SKILLS: "false",
        PENDING_CHANNELS: "false",
        KNOWLEDGE_TOOLS_BLOCK: knowledgeToolsBlock(input.role, agentHasKbBinding(input.id)),
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
        persona: profile?.personality || "",
        profile,
        workspace: `~/.openclaw/workspaces/${input.id}`,
        skills: input.skills,
        heartbeat: {},
        tools: toolsForRole(input.role),
      };
      store.agents.push(agentEntry);
      for (const ch of input.channels) {
        if (!ch.existing) {
          upsertChannelAsset(store.channels, ch.domain as SupportedChannel, ch.accountId, {
            account: ch.account,
            displayName: input.name,
            policy: {
              dmPolicy: (ch.account as any)?.dmPolicy,
              groupPolicy: (ch.account as any)?.groupPolicy,
              requireMention: (ch.account as any)?.requireMention,
            },
            enabled: true,
          });
        }
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

export async function createAgentFromExistingAccount(
  draft: AgentDraft,
  onApplied?: () => void,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return createAgent(assembleExistingAccountInput(draft), onApplied);
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
    if (!input.addChannel.existing && (
      !input.addChannel.credentials?.clientId?.trim() ||
      !input.addChannel.credentials?.clientSecret?.trim()
    )) {
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
  const profile = legacyToProfile({ persona: input.persona, profile: input.profile });
  return {
    ID: id,
    NAME: input.name.trim(),
    ROLE: input.role,
    ROLE_LABEL: ROLE_LABEL[input.role],
    JOB_TITLE: profile?.jobTitle || ROLE_LABEL[input.role],
    RESPONSIBILITIES: profile?.responsibilities || "（未填写职责）",
    PERSONA: profile?.personality || input.persona?.trim() || "（未填写人设）",
    TONE: profile?.tone || "（未指定语气）",
    BOUNDARIES: profile?.boundaries || "（未指定边界）",
    PROFILE: profile ? JSON.stringify(profile, null, 2) : "（未配置职业档案）",
    SKILLS: input.skills.map((s) => `- ${s}`).join("\n"),
    PENDING_STATUS: "",
    PENDING_SKILLS: "false",
    PENDING_CHANNELS: "false",
    KNOWLEDGE_TOOLS_BLOCK: knowledgeToolsBlock(input.role, agentHasKbBinding(id)),
  };
}

/** 仅修改数字员工资料（ADR-013 #57）。渠道操作走 bind/unbindAgentFromChannel。 */
export async function updateAgentProfile(
  id: string,
  input: {
    name: string;
    role: "employee" | "admin";
    /** @deprecated 由 profile.personality 取代。 */
    persona?: string;
    profile?: AgentProfile;
  },
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withConfigLock(async () => {
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
    if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
    if (input.persona !== undefined && typeof input.persona !== "string") throw new Error("persona 非法");

    const store = readStore();
    const index = store.agents.findIndex((a) => a.id === id);
    if (index < 0) throw new Error(`agent 不存在：${id}`);
    const wsDir = workspaceDir(id);
    if (!existsSync(wsDir)) throw new Error(`agent workspace 不存在：${wsDir}`);

    const current = store.agents[index]!;
    const skills = current.skills ?? [];
    const profile = legacyToProfile({ persona: input.persona, profile: input.profile }) ?? current.profile;

    const snap = mkdtempSync(join(tmpdir(), "orch-update-profile-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    cpSync(wsDir, join(snap, "workspace"), { recursive: true });
    try {
      const { persona: _legacyPersona, ...currentWithoutLegacyPersona } = current;
      const next: AgentEntry = {
        ...currentWithoutLegacyPersona,
        name: input.name.trim(),
        role: input.role,
        profile,
        skills,
        tools: toolsForRole(input.role),
      };
      store.agents[index] = next;
      // 重新渲染 workspace（按 profile + 派生状态）
      const channels = store.bindings
        .filter((b) => b.agentId === id)
        .map((b) => ({ domain: b.match.channel, accountId: b.match.accountId }));
      const jobTitle = profile?.jobTitle || ROLE_LABEL[next.role];
      renderWorkspace(id, {
        ID: id,
        NAME: next.name!,
        ROLE: next.role,
        ROLE_LABEL: ROLE_LABEL[next.role],
        JOB_TITLE: jobTitle,
        RESPONSIBILITIES: profile?.responsibilities || "（未填写职责）",
        PERSONA: profile?.personality || "（未填写人设）",
        TONE: profile?.tone || "（未指定语气）",
        BOUNDARIES: profile?.boundaries || "（未指定边界）",
        PROFILE: profile ? JSON.stringify(profile, null, 2) : "（未配置职业档案）",
        SKILLS: skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "（待配置技能）",
        PENDING_STATUS: pendingStatusBlock(skills.length === 0, channels.length === 0),
        PENDING_SKILLS: skills.length === 0 ? "true" : "false",
        PENDING_CHANNELS: channels.length === 0 ? "true" : "false",
        KNOWLEDGE_TOOLS_BLOCK: knowledgeToolsBlock(next.role, agentHasKbBinding(id)),
      }, { preserveMemory: true });
      writeStore(store);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.update.profile" })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`更新失败：${apply.message || apply.status}`);

      rmSync(snap, { recursive: true, force: true });
      return { agent: next, apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        rmSync(wsDir, { recursive: true, force: true });
        cpSync(join(snap, "workspace"), wsDir, { recursive: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.update.profile" })) as ApplyResult;
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

/** 员工↔技能分配视图（ADR-015 §3）：当前技能 + 可分配技能元信息 + 依赖未满足提示（不阻断）。 */
export interface AgentSkillsView {
  skills: string[];
  available: SkillMeta[];
  unmet: Array<{ skill: string; reason: string }>;
  /** ADR-016 §5.1：技能/知识库绑定状态不匹配的提示（不自动修复）。 */
  warnings: Array<{ code: string; message: string }>;
}

/** 计算技能依赖未满足项（requiresKnowledge 但员工未绑 FastGPT 库）。仅提示，不阻断分配。 */
function computeSkillUnmet(agentId: string, skills: string[]): Array<{ skill: string; reason: string }> {
  const hasKb = agentHasKbBinding(agentId);
  const unmet: Array<{ skill: string; reason: string }> = [];
  for (const name of skills) {
    const meta = getSkill(name);
    if (meta?.requiresKnowledge && !hasKb) {
      unmet.push({ skill: name, reason: "依赖知识库绑定未满足，前往「知识库」页绑定后该技能才可实际使用" });
    }
  }
  return unmet;
}

/** 取员工技能分配视图（GET /config/agents/:id/skills）。 */
export function getAgentSkillsView(agentId: string): AgentSkillsView {
  const { agents } = readStore();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`agent 不存在：${agentId}`);
  const skills = agent.skills ?? [];
  return { skills, available: listSkillMetas(), unmet: computeSkillUnmet(agentId, skills), warnings: computeSkillWarnings(agentId, skills) };
}

/**
 * ADR-016 §5.1：技能与知识库绑定状态不匹配的提示（只提示，不自动修复，不阻断）。
 * - 已绑知识库但未分配任何 requiresKnowledge 知识问答类 skill → 提示缺少问答行为规范。
 * - 分配了 requiresKnowledge skill 但未绑知识库 → 沿用 unmet，不重复 warning。
 */
function computeSkillWarnings(agentId: string, skills: string[]): Array<{ code: string; message: string }> {
  const hasKb = agentHasKbBinding(agentId);
  const hasQaSkill = skills.some((name) => getSkill(name)?.requiresKnowledge);
  const warnings: Array<{ code: string; message: string }> = [];
  if (hasKb && !hasQaSkill) {
    warnings.push({
      code: "kb-without-qa-skill",
      message: "已绑定知识库，但未分配知识问答类技能。该员工可以访问知识库工具，但缺少问答行为规范（如先检索、按来源引用、未命中不编造），建议分配 hr-policy-qa 等知识问答技能。",
    });
  }
  return warnings;
}

export interface AgentSkillsUpdateResult {
  before: string[];
  after: string[];
  unmet: Array<{ skill: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  apply: ApplyResult;
}

/**
 * 更新员工技能集（ADR-015 §3，PUT /config/agents/:id/skills）。
 * 校验：存在性（validateSkills）+ 角色兼容（requiredRole=admin 只能分给 admin，阻断）；
 * 依赖未满足（requiresKnowledge 未绑库）仅记 unmet、不阻断。
 * 经 store→generate→validate→apply 落地 + 重渲染 workspace；失败回滚 store+workspace。
 */
export async function updateAgentSkills(id: string, nextSkills: string[]): Promise<AgentSkillsUpdateResult> {
  return withConfigLock(async () => {
    validateSkills(nextSkills, { allowEmpty: true });
    const store = readStore();
    const index = store.agents.findIndex((a) => a.id === id);
    if (index < 0) throw new Error(`agent 不存在：${id}`);
    const agent = store.agents[index]!;
    for (const name of nextSkills) {
      const meta = getSkill(name);
      if (meta?.requiredRole === "admin" && agent.role !== "admin") {
        throw new Error(`技能 ${name} 要求 admin 角色，该数字员工为 ${agent.role}`);
      }
    }
    // 去重保序
    const dedup = Array.from(new Set(nextSkills));
    const before = agent.skills ?? [];
    const wsDir = workspaceDir(id);
    if (!existsSync(wsDir)) throw new Error(`agent workspace 不存在：${wsDir}`);

    const snap = mkdtempSync(join(tmpdir(), "orch-skills-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    cpSync(wsDir, join(snap, "workspace"), { recursive: true });
    try {
      const current = store.agents[index]!;
      const next: AgentEntry = { ...current, skills: dedup };
      store.agents[index] = next;
      writeStore(store);
      // 重渲染 workspace（按新 skills 刷 AGENTS.md 的技能列表 + 待配置状态）。
      rerenderAgentWorkspace(id);

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.skill.update" })) as ApplyResult;
      if (apply.status !== "success") throw new Error(`技能更新失败：${apply.message || apply.status}`);

      rmSync(snap, { recursive: true, force: true });
      return { before, after: dedup, unmet: computeSkillUnmet(id, dedup), warnings: computeSkillWarnings(id, dedup), apply };
    } catch (err) {
      let rollbackMessage = "已恢复原配置";
      try {
        cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
        rmSync(wsDir, { recursive: true, force: true });
        cpSync(join(snap, "workspace"), wsDir, { recursive: true });
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: "runtime-only", operation: "agent.skill.update" })) as ApplyResult;
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

/** 修改数字员工资料、权限与渠道配置；ID 和 MEMORY.md 保持不变。
 *  Legacy 路径，新代码请用 updateAgentProfile + bindAgentToChannel / unbindAgentFromChannel 组合。 */
export async function updateAgent(
  id: string,
  input: UpdateAgentInput,
): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withConfigLock(async () => {
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
        findChannelAsset(store.channels, input.addChannel.domain, accountId) &&
        !input.addChannel.existing &&
        !removeKeys.has(`${input.addChannel.domain}/${accountId}`)
      ) {
        throw new Error(`渠道账号已存在：${input.addChannel.domain}/${accountId}`);
      }
      const draft = {
        id,
        name: input.name.trim(),
        role: input.role,
        persona: input.persona ?? input.profile?.personality,
        skills: input.skills,
        domain: input.addChannel.domain,
        accountId,
      };
      addedChannel = input.addChannel.existing
        ? assembleExistingChannel(draft)
        : assembleChannel(draft, input.addChannel.credentials!);
    }

    const snap = mkdtempSync(join(tmpdir(), "orch-update-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    cpSync(wsDir, join(snap, "workspace"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));
    try {
      const current = store.agents[index];
      const profile = legacyToProfile({ persona: input.persona, profile: input.profile }) ?? current?.profile;
      const next: AgentEntry = {
        ...current,
        name: input.name.trim(),
        role: input.role,
        persona: profile?.personality || "",
        profile,
        skills: input.skills,
        tools: toolsForRole(input.role),
      };
      store.agents[index] = next;
      renderWorkspace(id, workspaceVars(id, input), { preserveMemory: true });
      if (removeKeys.size > 0) {
        store.bindings = store.bindings.filter((binding) => {
          return binding.agentId !== id || !removeKeys.has(`${binding.match.channel}/${binding.match.accountId}`);
        });
        // 解绑只释放账号；账号配置和凭据作为平台资产保留，供其他数字员工复用。
      }
      if (addedChannel) {
        upsertEnv(addedChannel.secrets || {});
        if (!addedChannel.existing) {
          upsertChannelAsset(store.channels, addedChannel.domain as SupportedChannel, addedChannel.accountId, {
            account: addedChannel.account,
            displayName: input.name.trim(),
            policy: {
              dmPolicy: (addedChannel.account as any)?.dmPolicy,
              groupPolicy: (addedChannel.account as any)?.groupPolicy,
              requireMention: (addedChannel.account as any)?.requireMention,
            },
            enabled: true,
          });
        }
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

/** 删除非内置数字员工，并释放其渠道账号、清理 workspace 与知识库绑定。 */
export async function deleteAgent(id: string): Promise<{ apply: ApplyResult }> {
  return withConfigLock(async () => {
    const store = readStore();
    const agent = store.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`agent 不存在：${id}`);
    if (isProtectedAgent(agent)) throw new Error("内置数字员工不能删除");
    // ADR-016 §3.1：删除带渠道绑定的 agent 等同解绑渠道 → restart；纯无渠道 → runtime-only。
    const hadChannels = store.bindings.some((b) => b.agentId === id);
    const deleteMode: "restart" | "runtime-only" = hadChannels ? "restart" : "runtime-only";
    const wsDir = workspaceDir(id);
    const snap = mkdtempSync(join(tmpdir(), "orch-delete-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));
    if (existsSync(wsDir)) cpSync(wsDir, join(snap, "workspace"), { recursive: true });

    try {
      store.agents = store.agents.filter((a) => a.id !== id);
      store.bindings = store.bindings.filter((b) => b.agentId !== id);
      // 渠道账号是平台资产；删除数字员工只释放绑定，账号和凭据保留供后续复用。
      writeStore(store);
      unbindAgentFromKnowledge(id);
      rmSync(wsDir, { recursive: true, force: true });

      const apply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: deleteMode, operation: "agent.delete" })) as ApplyResult;
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
        const rollbackApply = (await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: deleteMode, operation: "agent.delete" })) as ApplyResult;
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
