// 一次性迁移（基石 A）：旧 config/openclaw.jsonc → config-store/*.json + base 骨架。
// 用途：从单体 jsonc 抽出动态部分；也可对拍手写的 config-store（深度相等即迁移无损）。
// 注意：base 输出为去注释版骨架，仅供参考；正式 base 由人工维护(保留注释)。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './generate-config.js';
import { readFileSync } from 'node:fs';
import type { AgentsStore, ChannelsStore, BindingsStore } from './types.js';

export interface MigrationOutput {
  base: any;
  channels: ChannelsStore;
  agents: AgentsStore;
  bindings: BindingsStore;
}

/** 角色推断：有效授予写工具者视为 admin，否则 employee。 */
function inferRole(agent: any): 'admin' | 'employee' {
  const allow: string[] | undefined = agent?.tools?.allow;
  const deny: string[] | undefined = agent?.tools?.deny;
  const writeAllowed = ['memory_write', 'memory_delete', 'exec'].some((t) => {
    const inAllow = allow ? allow.includes(t) : true;
    const inDeny = deny ? deny.includes(t) : false;
    return inAllow && !inDeny;
  });
  return writeAllowed ? 'admin' : 'employee';
}

export function migrate(jsoncText: string): MigrationOutput {
  const root = parseJsonc(jsoncText) as any;

  // channels：抽出每个 domain 的 accounts，脚手架留在 base。
  // Sprint 8 ADR-013 改造后 store 改为账号资产数组；migrate 工具按 domain→type 转换输出形态。
  const channels: ChannelsStore = [];
  const baseChannels: any = {};
  for (const [domain, node] of Object.entries<any>(root.channels ?? {})) {
    const { accounts, ...scaffold } = node;
    baseChannels[domain] = scaffold;
    const type: 'feishu' | 'dingtalk' = domain === 'dingtalk-connector' ? 'dingtalk' : 'feishu';
    for (const [accountId, account] of Object.entries<any>(accounts ?? {})) {
      const { dmPolicy, groupPolicy, requireMention, ...rest } = (account as any) ?? {};
      const policy: Record<string, unknown> = {};
      if (dmPolicy) policy.dmPolicy = dmPolicy;
      if (groupPolicy) policy.groupPolicy = groupPolicy;
      if (requireMention !== undefined) policy.requireMention = requireMention;
      channels.push({
        id: accountId,
        type,
        displayName: accountId,
        enabled: true,
        account: rest,
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
      } as any);
    }
  }

  // agents：list 抽出（补 role），defaults 留在 base
  const agents: AgentsStore = (root.agents?.list ?? []).map((a: any) => ({
    role: inferRole(a),
    ...a,
  }));

  const bindings: BindingsStore = root.bindings ?? [];

  // base 骨架：原结构去掉 channels.accounts / agents.list / bindings
  const base: any = { ...root };
  base.channels = baseChannels;
  base.agents = { ...(root.agents ?? {}) };
  delete base.agents.list;
  delete base.bindings;

  return { base, channels, agents, bindings };
}

// —— CLI ——
function isMain(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : d;
  };
  const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const input = resolve(get('in', resolve(configDir, 'openclaw.jsonc'))!);
  const outStore = resolve(get('out-store', resolve(configDir, 'config-store-migrated'))!);
  const outBase = get('out-base');

  const result = migrate(readFileSync(input, 'utf-8'));
  mkdirSync(outStore, { recursive: true });
  writeFileSync(resolve(outStore, 'channels.json'), JSON.stringify(result.channels, null, 2) + '\n');
  writeFileSync(resolve(outStore, 'agents.json'), JSON.stringify(result.agents, null, 2) + '\n');
  writeFileSync(resolve(outStore, 'bindings.json'), JSON.stringify(result.bindings, null, 2) + '\n');
  if (outBase) writeFileSync(resolve(outBase), JSON.stringify(result.base, null, 2) + '\n');
  console.log(`[migrate-jsonc] store → ${outStore}`);
}
