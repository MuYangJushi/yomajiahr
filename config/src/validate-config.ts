// 配置校验（基石 C）：结构 schema + ADR 红线不变量。
// 输出可读中文错误，供 install.sh 拦截、P1 UI 直接展示。
import { existsSync } from 'node:fs';
import {
  AgentsStoreSchema,
  BindingsStoreSchema,
  ChannelsStoreSchema,
  KnowledgeStoreSchema,
  SUBAGENT_TOOLS,
  WRITE_TOOLS,
  type Agent,
  type AgentTools,
  type ConfigStore,
  type RuntimeConfig,
} from './types.js';

export interface ValidateOptions {
  /** .env / .env.example 中已声明的变量名集合，用于 ${VAR} 存在性校验。不传则跳过该项。 */
  envKeys?: Set<string>;
  /** 是否做文件系统检查（workspace 目录 / skills 存在）。部署目标(~/.openclaw 存在)时开启。 */
  checkFilesystem?: boolean;
  /** skills 根目录（checkFilesystem 时用）。 */
  skillsDir?: string;
  /** 把 agent.workspace（可能含 ~ ）解析为绝对路径的函数（checkFilesystem 时用）。 */
  resolveWorkspace?: (workspace: string) => string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** 建模 openclaw 的 allow/deny 优先级：有 allowlist 时工具须在其中；deny 永远拒绝。 */
export function effectivelyAllowed(tool: string, tools?: AgentTools): boolean {
  if (!tools) return true; // 无工具策略 = 默认全开
  const inAllow = tools.allow ? tools.allow.includes(tool) : true;
  const inDeny = tools.deny ? tools.deny.includes(tool) : false;
  return inAllow && !inDeny;
}

const PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)\}/g;

function collectPlaceholders(value: unknown, acc: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_RE)) acc.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholders(v, acc);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPlaceholders(v, acc);
  }
}

/** 校验三份 store 的结构 + 装配后的运行时配置的 ADR 红线。 */
export function validateConfig(
  store: ConfigStore,
  runtime: RuntimeConfig,
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: string[] = [];

  // —— 1. 结构 schema ——
  const channelsParsed = ChannelsStoreSchema.safeParse(store.channels);
  const agentsParsed = AgentsStoreSchema.safeParse(store.agents);
  const bindingsParsed = BindingsStoreSchema.safeParse(store.bindings);
  if (!channelsParsed.success)
    errors.push(`channels.json 结构错误：${channelsParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  if (!agentsParsed.success)
    errors.push(`agents.json 结构错误：${agentsParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  if (!bindingsParsed.success)
    errors.push(`bindings.json 结构错误：${bindingsParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  // knowledge 可选（旧部署无 knowledge.json）；存在时与其余三份同源校验，畸形早报而非带进生成。
  const knowledgeParsed =
    store.knowledge !== undefined ? KnowledgeStoreSchema.safeParse(store.knowledge) : undefined;
  if (knowledgeParsed && !knowledgeParsed.success)
    errors.push(`knowledge.json 结构错误：${knowledgeParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  // 结构不过则不再做语义检查（避免 undefined 噪声）
  if (
    !channelsParsed.success ||
    !agentsParsed.success ||
    !bindingsParsed.success ||
    (knowledgeParsed && !knowledgeParsed.success)
  ) {
    return { ok: false, errors };
  }

  const channels = channelsParsed.data;
  const agents = agentsParsed.data;
  const bindings = bindingsParsed.data;

  // —— 2. bindings 引用完整性（ADR-013：channels 是顶层账号资产数组；按 type 分桶派生 domain→Set<accountId>）——
  const agentIds = new Set(agents.map((a) => a.id));
  // 派生 domain 名空间（运行时与 bindings.match.channel 保持兼容）：dingtalk → dingtalk-connector
  const accountsByDomain = new Map<string, Set<string>>();
  for (const asset of channels) {
    if (asset.enabled === false) continue;
    const domain = asset.type === 'dingtalk' ? 'dingtalk-connector' : asset.type;
    if (!accountsByDomain.has(domain)) accountsByDomain.set(domain, new Set());
    accountsByDomain.get(domain)!.add(asset.id);
  }
  for (const [idx, b] of bindings.entries()) {
    if (!agentIds.has(b.agentId))
      errors.push(`bindings[${idx}]：agentId "${b.agentId}" 不存在于 agents.list`);
    const domain = b.match.channel;
    const accountIds = accountsByDomain.get(domain);
    if (!accountIds) {
      errors.push(`bindings[${idx}]：channel "${domain}" 不存在于 channels.json`);
    } else if (!accountIds.has(b.match.accountId)) {
      errors.push(`bindings[${idx}]：channel "${domain}" 下不存在账号 "${b.match.accountId}"`);
    }
  }

  // —— 3. ADR-003：role != admin 的 agent 不得有效授予写工具 ——
  for (const a of agents) {
    if (a.role !== 'admin') {
      for (const tool of WRITE_TOOLS) {
        if (effectivelyAllowed(tool, a.tools))
          errors.push(`ADR-003 违规：agent "${a.id}"(role=${a.role}) 有效授予了写工具 "${tool}"；非 admin 必须拒绝 ${WRITE_TOOLS.join('/')}`);
      }
    }
  }

  // —— 4. ADR-001：任何 agent 不得有效授予 sub-agent 工具 ——
  for (const a of agents) {
    for (const tool of SUBAGENT_TOOLS) {
      if (effectivelyAllowed(tool, a.tools))
        errors.push(`ADR-001 违规：agent "${a.id}" 有效授予了 sub-agent 工具 "${tool}"（须排除）`);
    }
  }

  // —— 5. ADR-004 的 chunking 锁定校验已随 ADR-012 退役内置 memorySearch 一并移除（约束对象已不存在）——

  // —— 6. ${VAR} 占位符存在性 ——
  if (opts.envKeys) {
    const used = new Set<string>();
    collectPlaceholders(store.channels, used);
    collectPlaceholders(runtime, used);
    for (const v of used) {
      if (!opts.envKeys.has(v))
        errors.push(`占位符 \${${v}} 未在 .env / .env.example 中声明（会导致 gateway 静默故障）`);
    }
  }

  // —— 7.（可选）文件系统检查 ——
  if (opts.checkFilesystem) {
    for (const a of agents) {
      if (opts.resolveWorkspace) {
        const wsPath = opts.resolveWorkspace(a.workspace);
        if (!existsSync(wsPath))
          errors.push(`agent "${a.id}" 的 workspace 不存在：${wsPath}`);
      }
      if (opts.skillsDir) {
        for (const s of a.skills) {
          if (!existsSync(`${opts.skillsDir}/${s}`))
            errors.push(`agent "${a.id}" 引用的 skill 不存在：${opts.skillsDir}/${s}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
