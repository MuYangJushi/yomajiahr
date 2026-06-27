// 生成器（基石 A）：base.jsonc + config-store/*.json → 运行时 openclaw.json。
// 被 install.sh（CLI）与未来 portal（programmatic）共用。
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { ConfigStore, KnowledgeStore, RuntimeConfig } from './types.js';
import { validateConfig, type ValidateOptions } from './validate-config.js';

/** 本机 Admin Server 暴露的 per-agent MCP 端点（loopback）。绑定驱动注册指向 /mcp/<agentId>。 */
const KNOWLEDGE_MCP_BASE_URL = 'http://127.0.0.1:18790';
/** per-agent MCP 注册名前缀；工具命名空间化为 `kb-<agentId>__<工具名>`（ADR-011）。 */
const KB_REGISTRATION_PREFIX = 'kb-';
const KNOWLEDGE_SEARCH_TOOL = 'knowledge_search';
const KNOWLEDGE_IMPORT_TOOL = 'knowledge_import';
/** 识别由本机制管理的知识库工具（无论旧名 `fastgpt__…` 还是新名 `kb-<id>__…`），用于幂等清洗。 */
const KNOWLEDGE_TOOL_SUFFIX_RE = /__(knowledge_search|knowledge_import)$/;

/** 把 agent.workspace（如 "~/.openclaw/workspaces/x"）解析为绝对路径。
 *  优先把前缀 ~/.openclaw 映射到运行时 stateDir（apply 以 root 运行时 ~ ≠ 部署用户家目录）。 */
export function makeWorkspaceResolver(stateDir?: string): (ws: string) => string {
  return (ws: string) => {
    if (stateDir && ws.startsWith('~/.openclaw')) return ws.replace('~/.openclaw', stateDir);
    if (ws.startsWith('~')) return ws.replace('~', homedir());
    return ws;
  };
}

/** 解析 JSONC：复用 install.sh 的语义（去 BOM/注释 + JS 对象字面量求值，容忍尾逗号）。 */
export function parseJsonc(text: string): unknown {
  const sanitized = text
    .replace(/^﻿/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return vm.runInNewContext('(' + sanitized + ')', {});
}

function readJsonc(path: string): any {
  return parseJsonc(readFileSync(path, 'utf-8'));
}
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** 从 .env / .env.example 收集已声明的变量名。 */
export function readEnvKeys(path: string): Set<string> {
  const keys = new Set<string>();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return keys;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/** 从 .env / .env.example 收集 key→value（去引号 + trim；不解析 export/多行值）。 */
export function readEnvMap(path: string): Map<string, string> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    // 去掉成对的首尾引号（与 dotenv 行为一致）
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(m[1]!, value);
  }
  return map;
}

/** 占位符值识别：admin-server 与生成器同源使用。
 *  - 空串 / 仅空白：占位符
 *  - `${...}` 字面量原样残留：占位符（dotenv 没解析到）
 *  - 与 .env.example 模板里同 key 的值完全一致：占位符（用户没改过）
 *  - 已知模板尾巴（`change-me`、`xxxxxxxx`、`...`）：占位符
 */
export function isPlaceholderValue(actual: string | undefined, template: string | undefined): boolean {
  if (actual === undefined) return true;
  const v = actual.trim();
  if (v === '') return true;
  if (/^\$\{[A-Z0-9_]+\}$/.test(v)) return true;
  if (template !== undefined && v === template.trim()) return true;
  // 模板里常见的"未填写"标识
  if (/^change[-_]me/i.test(v)) return true;
  if (/^x{4,}$/i.test(v)) return true;
  // 形如 "cli_xxxxxxxxxxxxxxxx"、"dingxxxxxxxxxxxxxxxx"：模板未替换
  if (/x{8,}/.test(v)) return true;
  return false;
}

/** 判定某 channel asset 的凭证是否完整：envKeys 必须全部在 .env 中有非占位值。
 *  channels.ts probe 与生成器派生逻辑共用此判定。
 */
export function isAssetConfigured(
  envKeys: string[] | undefined,
  envMap: Map<string, string>,
  exampleMap: Map<string, string>,
): boolean {
  if (!envKeys || envKeys.length === 0) return false;
  return envKeys.every((key) => !isPlaceholderValue(envMap.get(key), exampleMap.get(key)));
}

export interface GenerateOptions {
  basePath: string; // openclaw.base.jsonc
  storeDir?: string; // config-store/（与 store 二选一）
  store?: ConfigStore; // 内存 store（portal 预校验用；优先于 storeDir）
  envPath?: string; // .env / .env.example（占位符校验 + 凭证就绪判定）
  /** 模板文件（凭证就绪判定的对照源）；不传则走 envPath 同侧目录的 .env.example。 */
  envExamplePath?: string;
  checkFilesystem?: boolean;
  skillsDir?: string;
  resolveWorkspace?: (workspace: string) => string;
}

export interface GenerateResult {
  config: RuntimeConfig;
  store: ConfigStore;
  /** 派生时被跳过的渠道账号（凭证未配置等）；不影响 store，仅用于诊断。 */
  skippedChannelAssets?: Array<{ type: string; id: string; reason: string }>;
}

/**
 * 解析某 agent 是否至少绑定了一个可检索的 FastGPT 库（决定它是否获得 knowledge_search 工具）。
 * 语义与 admin-server `resolveDatasetIdsForAgent` 一致：只认 provider=fastgpt 且 externalKbId 非空的绑定。
 * 兜底（无 knowledge.json，旧部署）镜像 admin-server `defaultStore()`：**仅默认 agent** 视为已绑定，
 * 避免「文件缺失→全员无工具」回归，也不过度授权给非默认 agent。
 */
function agentHasFastgptBinding(
  agentId: string,
  knowledge: KnowledgeStore | undefined,
  defaultAgentId: string | undefined,
): boolean {
  if (!knowledge) return Boolean(defaultAgentId) && agentId === defaultAgentId;
  // 防御畸形 knowledge.json（如 knowledgeBases 非数组）：退化为「无绑定」，
  // 结构错误交由 validateConfig 抛可读错误，不在此处崩。
  const kbs = Array.isArray(knowledge.knowledgeBases) ? knowledge.knowledgeBases : [];
  return kbs.some(
    (kb) =>
      kb.provider === 'fastgpt' &&
      Boolean(kb.externalKbId) &&
      Array.isArray(kb.boundAgents) &&
      kb.boundAgents.includes(agentId),
  );
}

/**
 * 绑定驱动 per-agent MCP 注册与 knowledge_search 工具暴露（ADR-011）。就地改写 config：
 *  - 为每个有 FastGPT 绑定的 agent 生成 `mcp.servers["kb-<id>"]` → `/mcp/<id>`，并往其 tools.allow
 *    注入 `kb-<id>__knowledge_search`（admin 角色再加 `kb-<id>__knowledge_import`）。
 *  - 无绑定的 agent：不生成注册、不注入工具 → 没有 knowledge_search。
 *  - 幂等清洗：先剥离各 agent allow 中**所有**既有知识库工具（含旧硬编码 `fastgpt__knowledge_search`），
 *    再按绑定重新注入，使 knowledge.json 成为工具暴露的唯一真相源。
 * 注：注册 URL 只带 agentId，不含 datasetId —— 多库由 admin-server 检索时按绑定 fan-out（单注册即可）。
 */
export function applyKnowledgeBindings(config: any, store: ConfigStore): void {
  const knowledge = store.knowledge;
  const defaultAgentId = store.agents.find((a) => a.default)?.id;
  // role 在 config.agents.list 中已被剥离，故从 store.agents 取角色判定 admin。
  const roleById = new Map(store.agents.map((a) => [a.id, a.role]));

  config.mcp ??= {};
  const servers: Record<string, unknown> = { ...(config.mcp.servers ?? {}) };
  const list: any[] = Array.isArray(config.agents?.list) ? config.agents.list : [];

  for (const agent of list) {
    const agentId: string = agent.id;
    // 用新对象替换 tools，避免改到 store.agents（map 浅拷贝共享了 tools 引用）。
    const tools = { ...(agent.tools ?? {}) };
    const allow: string[] = Array.isArray(tools.allow) ? [...tools.allow] : [];
    // 幂等：先移除所有既有知识库工具（旧 fastgpt__ 或上一次生成的 kb-*）。
    let nextAllow = allow.filter((t) => !KNOWLEDGE_TOOL_SUFFIX_RE.test(t));

    if (agentHasFastgptBinding(agentId, knowledge, defaultAgentId)) {
      const regName = `${KB_REGISTRATION_PREFIX}${agentId}`;
      const isAdmin = roleById.get(agentId) === 'admin';
      const include = isAdmin
        ? [KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_IMPORT_TOOL]
        : [KNOWLEDGE_SEARCH_TOOL];
      servers[regName] = {
        enabled: true,
        url: `${KNOWLEDGE_MCP_BASE_URL}/mcp/${agentId}`,
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer ${KNOWLEDGE_MCP_TOKEN}' },
        toolFilter: { include },
      };
      nextAllow.push(`${regName}__${KNOWLEDGE_SEARCH_TOOL}`);
      if (isAdmin) nextAllow.push(`${regName}__${KNOWLEDGE_IMPORT_TOOL}`);
    }

    // 仅当原本就有 allow 策略、或本轮注入了工具时才写 allow，避免给「无策略=全开」的 agent 平添 allowlist。
    if (Array.isArray(tools.allow) || nextAllow.length > 0) tools.allow = nextAllow;
    agent.tools = tools;
  }

  config.mcp.servers = servers;
}

/** 装配运行时配置；校验失败抛错（带可读中文错误）。 */
export function generateConfig(opts: GenerateOptions): GenerateResult {
  const base = readJsonc(opts.basePath) as any;
  let store: ConfigStore;
  if (opts.store) {
    store = opts.store;
  } else if (opts.storeDir) {
    const knowledgePath = resolve(opts.storeDir, 'knowledge.json');
    store = {
      channels: readJson(resolve(opts.storeDir, 'channels.json')),
      agents: readJson(resolve(opts.storeDir, 'agents.json')),
      bindings: readJson(resolve(opts.storeDir, 'bindings.json')),
      // 旧部署可能尚无 knowledge.json：缺失时留空，由绑定派生逻辑走默认库兜底。
      knowledge: existsSync(knowledgePath) ? (readJson(knowledgePath) as KnowledgeStore) : undefined,
    };
  } else {
    throw new Error('generateConfig：需提供 storeDir 或 store 之一');
  }

  // 深拷贝 base，避免污染
  const config: any = structuredClone(base);

  // —— 凭证就绪判定（#4：占位符账号不进运行时）——
  //   .env 中该 envKeys 全部存在且不是占位字面量（含 .env.example 模板默认值），才视为"已配置"。
  //   未配置的渠道账号一律不派生进 openclaw.json：dingtalk-connector / lark-connector 不会为其
  //   起 client，避免 401/400 退避循环 + 让 apply 速度回到秒级。store 仍保留账号供平台后续编辑。
  const envMap = opts.envPath ? readEnvMap(opts.envPath) : new Map<string, string>();
  const examplePath = opts.envExamplePath
    ?? (opts.envPath && /\.env(\.[a-zA-Z0-9_-]+)?$/.test(opts.envPath)
      ? opts.envPath.replace(/\.env(\.[a-zA-Z0-9_-]+)?$/, '.env.example')
      : undefined);
  const exampleMap = examplePath && examplePath !== opts.envPath ? readEnvMap(examplePath) : new Map<string, string>();

  // —— 渠道：把账号资产数组（ADR-013）按 type 分桶派生 domain→accountId 形态 —
  //   平台 store 是顶层数组；运行时仍消费 domain→accountId 形态。生成器派生：
  //     1) 按 asset.type 分桶（feishu → channels.feishu、dingtalk → channels.dingtalk-connector）
  //     2) 仅注入存在 binding 且凭证已就绪的账号
  //     3) 账号内容来自 asset.account + asset.policy
  config.channels ??= {};
  const runtimeChannels: Record<string, Record<string, unknown>> = {};
  const skippedAssets: Array<{ type: string; id: string; reason: string }> = [];
  for (const asset of store.channels) {
    if (asset.enabled === false) continue;
    if (!isAssetConfigured(asset.envKeys, envMap, exampleMap)) {
      // 占位符账号不派生进 runtime；store 保留 + 前端展示「凭证未配置」。
      skippedAssets.push({ type: asset.type, id: asset.id, reason: '凭证未配置' });
      continue;
    }
    const domain = asset.type === 'dingtalk' ? 'dingtalk-connector' : asset.type;
    if (!runtimeChannels[domain]) runtimeChannels[domain] = {};
    const accountObj: Record<string, unknown> = {
      ...(asset.account ?? {}),
      ...(asset.policy?.dmPolicy ? { dmPolicy: asset.policy.dmPolicy } : {}),
      ...(asset.policy?.groupPolicy ? { groupPolicy: asset.policy.groupPolicy } : {}),
      ...(asset.policy?.requireMention !== undefined ? { requireMention: asset.policy.requireMention } : {}),
    };
    // dmPolicy="open" 但未显式 allowFrom 时，OpenClaw 会丢弃所有 DM（要求显式 allowlist，
    // 见 config validate 警告）。"open" 的语义即「对所有人开放 DM」，故兜底注入 allowFrom:["*"]；
    // 用户已在 account 里显式设过 allowFrom 则尊重不覆盖。
    if (accountObj.dmPolicy === 'open' && accountObj.allowFrom === undefined) {
      accountObj.allowFrom = ['*'];
    }
    // health / envKeys / displayName / enabled 都是平台编辑层语义；不进 OpenClaw 运行时。
    void (asset as any).health;
    void (asset as any).envKeys;
    void (asset as any).displayName;
    void (asset as any).enabled;
    runtimeChannels[domain]![asset.id] = accountObj;
  }
  // 派生：仅保留存在 binding 的账号。
  for (const [domain, accounts] of Object.entries(runtimeChannels)) {
    const boundAccountIds = new Set(
      store.bindings
        .filter((binding) => binding.match.channel === domain)
        .map((binding) => binding.match.accountId),
    );
    const activeAccounts = Object.fromEntries(
      Object.entries(accounts).filter(([accountId]) => boundAccountIds.has(accountId)),
    );
    config.channels[domain] = { ...(config.channels[domain] ?? {}), accounts: activeAccounts };
  }

  // —— agents.list：整体替换；剥离平台专用字段（不进 OpenClaw 运行时配置）——
  //    role / persona / profile 都是平台编辑层语义，OpenClaw 运行时不需要；
  //    profile 由 workspace 模板单独渲染（见 workspaces/_templates/）。
  config.agents ??= {};
  config.agents.list = store.agents.map(({ role, persona, profile, ...agent }) => agent);

  // —— bindings：整体替换 ——
  config.bindings = store.bindings;

  // —— 知识库绑定驱动 MCP 注册 + knowledge_search 工具暴露（ADR-011）——
  applyKnowledgeBindings(config, store);

  // —— 注入 gateway（与旧 install.sh 一致）——
  config.gateway = { mode: 'local' };

  // —— 校验 ——
  const validateOpts: ValidateOptions = {
    envKeys: opts.envPath ? readEnvKeys(opts.envPath) : undefined,
    checkFilesystem: opts.checkFilesystem,
    skillsDir: opts.skillsDir,
    resolveWorkspace: opts.resolveWorkspace,
  };
  const { ok, errors } = validateConfig(store, config, validateOpts);
  if (!ok) {
    throw new Error('配置校验失败：\n  - ' + errors.join('\n  - '));
  }

  return { config, store, skippedChannelAssets: skippedAssets.length ? skippedAssets : undefined };
}

/** 输出字节风格与旧 install.sh 一致：2 空格缩进 + 尾换行。 */
export function serializeConfig(config: RuntimeConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

// —— CLI ——
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[(i += 1)]! : 'true';
      out[key] = val;
    }
  }
  return out;
}

function isMain(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // dist/ 的上一级 = config/
  // 运行时目录：用于默认 store 位置与 ~/.openclaw 工作区解析。
  const stateDir = resolve(
    args['state-dir'] ?? process.env.OPENCLAW_STATE_DIR ?? resolve(homedir(), '.openclaw'),
  );
  const basePath = resolve(args.base ?? resolve(configDir, 'openclaw.base.jsonc'));
  // 默认从运行时 $STATE_DIR/config-store 读取（仓库内的是 config-store.seed 模板，不在此默认）。
  const storeDir = resolve(args.store ?? resolve(stateDir, 'config-store'));
  const envPath = resolve(args.env ?? resolve(configDir, '.env.example'));
  // 模板对照：默认走仓库内 .env.example。--env 指向 .env 时，用 .env.example 做凭证就绪判定的对照。
  const envExamplePath = resolve(args['env-example'] ?? resolve(configDir, '.env.example'));
  const out = args.out ? resolve(args.out) : undefined;
  const checkFs = args['check-fs'] === 'true';

  try {
    const { config, skippedChannelAssets } = generateConfig({
      basePath,
      storeDir,
      envPath,
      envExamplePath,
      checkFilesystem: checkFs,
      skillsDir: args['skills-dir'] ? resolve(args['skills-dir']) : undefined,
      resolveWorkspace: checkFs ? makeWorkspaceResolver(stateDir) : undefined,
    });
    const text = serializeConfig(config);
    if (out) {
      writeFileSync(out, text);
      chmodSync(out, 0o600);
      console.log(`[generate-config] OK → ${out}`);
    } else {
      process.stdout.write(text);
    }
    if (skippedChannelAssets?.length) {
      // 跳过的账号写到 stderr，不污染 stdout（generator 可能被 pipe）。
      for (const skip of skippedChannelAssets) {
        console.error(`[generate-config] 跳过未配置渠道：${skip.type}/${skip.id}（${skip.reason}）`);
      }
    }
  } catch (err) {
    console.error('[generate-config] ' + (err as Error).message);
    process.exit(1);
  }
}
