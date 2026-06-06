// 原子编排：新建数字员工 = 一次事务（单飞锁 + 快照 + 落盘 + apply + 失败回滚）。
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";
import { triggerApply } from "../../lib/config-apply.mjs";
import { ENV_PATH, upsertEnv } from "./secrets.js";
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

export interface ApplyResult {
  status: "success" | "failed" | "pending";
  message?: string;
  version?: string;
  mode?: string;
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
export async function createAgent(input: CreateAgentInput): Promise<{ agent: AgentEntry; apply: ApplyResult }> {
  return withLock(async () => {
    // —— 轻量输入预检（深度 ADR 校验由 apply 的 generate-config --check-fs 权威把关）——
    if (!/^[a-z0-9-]+$/.test(input.id)) throw new Error("id 只能含小写字母、数字、连字符");
    if (!input.name?.trim()) throw new Error("name 不能为空");
    if (input.role !== "employee" && input.role !== "admin") throw new Error("role 非法");
    if (!Array.isArray(input.skills) || input.skills.length === 0) throw new Error("至少分配一个技能");
    if (!Array.isArray(input.channels) || input.channels.length === 0) throw new Error("至少接入一个渠道");

    const store = readStore();
    if (store.agents.some((a) => a.id === input.id)) throw new Error(`agent id 已存在：${input.id}`);

    // —— 快照（store + .env + 是否新建 .env），供回滚 ——
    const snap = mkdtempSync(join(tmpdir(), "orch-"));
    cpSync(STORE_DIR, join(snap, "config-store"), { recursive: true });
    const envExisted = existsSync(ENV_PATH);
    if (envExisted) cpSync(ENV_PATH, join(snap, ".env"));
    const wsDir = workspaceDir(input.id);

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

      rmSync(snap, { recursive: true, force: true });
      return { agent: agentEntry, apply };
    } catch (err) {
      // —— 回滚 store / .env / workspace ——
      cpSync(join(snap, "config-store"), STORE_DIR, { recursive: true });
      if (envExisted) cpSync(join(snap, ".env"), ENV_PATH);
      else if (existsSync(ENV_PATH)) rmSync(ENV_PATH, { force: true });
      rmSync(wsDir, { recursive: true, force: true });
      rmSync(snap, { recursive: true, force: true });
      throw err;
    }
  });
}
