// 生成器（基石 A）：base.jsonc + config-store/*.json → 运行时 openclaw.json。
// 被 install.sh（CLI）与未来 portal（programmatic）共用。
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { ConfigStore, RuntimeConfig } from './types.js';
import { validateConfig, type ValidateOptions } from './validate-config.js';

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

export interface GenerateOptions {
  basePath: string; // openclaw.base.jsonc
  storeDir?: string; // config-store/（与 store 二选一）
  store?: ConfigStore; // 内存 store（portal 预校验用；优先于 storeDir）
  envPath?: string; // .env / .env.example（占位符校验）
  checkFilesystem?: boolean;
  skillsDir?: string;
  resolveWorkspace?: (workspace: string) => string;
}

export interface GenerateResult {
  config: RuntimeConfig;
  store: ConfigStore;
}

/** 装配运行时配置；校验失败抛错（带可读中文错误）。 */
export function generateConfig(opts: GenerateOptions): GenerateResult {
  const base = readJsonc(opts.basePath) as any;
  let store: ConfigStore;
  if (opts.store) {
    store = opts.store;
  } else if (opts.storeDir) {
    store = {
      channels: readJson(resolve(opts.storeDir, 'channels.json')),
      agents: readJson(resolve(opts.storeDir, 'agents.json')),
      bindings: readJson(resolve(opts.storeDir, 'bindings.json')),
    };
  } else {
    throw new Error('generateConfig：需提供 storeDir 或 store 之一');
  }

  // 深拷贝 base，避免污染
  const config: any = structuredClone(base);

  // —— 渠道：逐层合并（保留脚手架，仅注入 accounts）——
  config.channels ??= {};
  for (const [domain, accounts] of Object.entries(store.channels)) {
    config.channels[domain] = { ...(config.channels[domain] ?? {}), accounts };
  }

  // —— agents.list：整体替换；剥离平台专用字段（不进 OpenClaw 运行时配置）——
  config.agents ??= {};
  config.agents.list = store.agents.map(({ role, persona, ...agent }) => agent);

  // —— bindings：整体替换 ——
  config.bindings = store.bindings;

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

  return { config, store };
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
  const out = args.out ? resolve(args.out) : undefined;
  const checkFs = args['check-fs'] === 'true';

  try {
    const { config } = generateConfig({
      basePath,
      storeDir,
      envPath,
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
  } catch (err) {
    console.error('[generate-config] ' + (err as Error).message);
    process.exit(1);
  }
}
