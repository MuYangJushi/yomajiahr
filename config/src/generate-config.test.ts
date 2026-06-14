// 绑定驱动 per-agent MCP 注册与 knowledge_search 工具暴露（ADR-011 #49）。
// 运行：npm run build && node --test dist/*.test.js（Node 原生 test runner）。
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { generateConfig } from './generate-config.js';
import type { ConfigStore, KnowledgeStore } from './types.js';

const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATH = resolve(configDir, 'openclaw.base.jsonc');
const ENV_PATH = resolve(configDir, '.env.example');

const FASTGPT_DATASET = 'ds_hr_policy_001';

/** 构造最小可校验的内存 store；caller 覆盖 knowledge 与 agents.allow。 */
function makeStore(overrides: Partial<ConfigStore> = {}): ConfigStore {
  return {
    channels: [],
    bindings: [],
    agents: [
      {
        id: 'hr-employee',
        role: 'employee',
        default: true,
        name: 'HR小助手',
        workspace: '~/.openclaw/workspaces/hr-employee',
        skills: [],
        tools: { allow: ['memory_search', 'memory_get'], deny: ['memory_write', 'memory_delete', 'exec'] },
      },
      {
        id: 'hr-admin',
        role: 'admin',
        name: 'HR管理员',
        workspace: '~/.openclaw/workspaces/hr-admin',
        skills: [],
        tools: { allow: ['memory_search', 'memory_get', 'exec'], deny: ['gateway', 'sessions_spawn'] },
      },
    ],
    ...overrides,
  };
}

function fastgptStore(bindings: Record<string, string[]>): KnowledgeStore {
  return {
    platform: 'fastgpt',
    knowledgeBases: Object.entries(bindings).map(([id, boundAgents], i) => ({
      id: `kb_${i}`,
      name: id,
      provider: 'fastgpt',
      externalKbId: id,
      boundAgents,
    })),
  };
}

function gen(store: ConfigStore) {
  return generateConfig({ basePath: BASE_PATH, store, envPath: ENV_PATH }).config as any;
}

function allowOf(config: any, agentId: string): string[] {
  return config.agents.list.find((a: any) => a.id === agentId).tools.allow;
}

test('有绑定 → 生成 kb-<id> 注册 + 注入 knowledge_search 工具', () => {
  const config = gen(makeStore({ knowledge: fastgptStore({ [FASTGPT_DATASET]: ['hr-employee'] }) }));
  const reg = config.mcp.servers['kb-hr-employee'];
  assert.ok(reg, '应生成 kb-hr-employee 注册');
  assert.equal(reg.url, 'http://127.0.0.1:18790/mcp/hr-employee');
  assert.equal(reg.transport, 'streamable-http');
  assert.deepEqual(reg.toolFilter.include, ['knowledge_search']);
  assert.ok(allowOf(config, 'hr-employee').includes('kb-hr-employee__knowledge_search'));
});

test('无绑定 → 无注册、无 knowledge_search 工具', () => {
  // 只绑 hr-employee；hr-admin 无绑定。
  const config = gen(makeStore({ knowledge: fastgptStore({ [FASTGPT_DATASET]: ['hr-employee'] }) }));
  assert.equal(config.mcp.servers['kb-hr-admin'], undefined);
  assert.ok(!allowOf(config, 'hr-admin').some((t) => /__knowledge_search$/.test(t)));
});

test('admin 角色绑定 → toolFilter 含 import 且注入 knowledge_import', () => {
  const config = gen(makeStore({ knowledge: fastgptStore({ [FASTGPT_DATASET]: ['hr-admin'] }) }));
  const reg = config.mcp.servers['kb-hr-admin'];
  assert.deepEqual(reg.toolFilter.include, ['knowledge_search', 'knowledge_import']);
  const allow = allowOf(config, 'hr-admin');
  assert.ok(allow.includes('kb-hr-admin__knowledge_search'));
  assert.ok(allow.includes('kb-hr-admin__knowledge_import'));
  // employee 永远不得有 import（即便它也被绑定）。
  const config2 = gen(makeStore({ knowledge: fastgptStore({ [FASTGPT_DATASET]: ['hr-employee'] }) }));
  assert.deepEqual(config2.mcp.servers['kb-hr-employee'].toolFilter.include, ['knowledge_search']);
});

test('无 knowledge.json（旧部署）→ 仅默认 agent 兜底获得工具', () => {
  const config = gen(makeStore()); // knowledge 缺省
  assert.ok(config.mcp.servers['kb-hr-employee'], '默认 agent 应兜底得注册');
  assert.ok(allowOf(config, 'hr-employee').includes('kb-hr-employee__knowledge_search'));
  // 非默认 agent 不被兜底过度授权。
  assert.equal(config.mcp.servers['kb-hr-admin'], undefined);
  assert.ok(!allowOf(config, 'hr-admin').some((t) => /__knowledge_search$/.test(t)));
});

test('幂等：剥离旧硬编码 fastgpt__knowledge_search，无绑定时不残留', () => {
  const store = makeStore({ knowledge: { platform: 'fastgpt', knowledgeBases: [] } });
  // 模拟历史 allow 里遗留的旧工具名。
  store.agents[0].tools = { allow: ['fastgpt__knowledge_search', 'memory_search'], deny: [] };
  const config = gen(store);
  const allow = allowOf(config, 'hr-employee');
  assert.ok(!allow.includes('fastgpt__knowledge_search'), '旧硬编码工具应被剥离');
  assert.ok(!allow.some((t) => /__knowledge_search$/.test(t)), '无绑定不应残留任何 search 工具');
  assert.ok(allow.includes('memory_search'), '非知识库工具应保留');
});

test('畸形 knowledge.json → generateConfig 抛可读结构错误', () => {
  const store = makeStore({ knowledge: { platform: 'fastgpt', knowledgeBases: 'oops' } as any });
  assert.throws(() => gen(store), /knowledge\.json 结构错误/);
});

test('provider=local 或 externalKbId 为空 → 不视为有效绑定', () => {
  const store = makeStore({
    knowledge: {
      platform: 'fastgpt',
      knowledgeBases: [
        { id: 'a', name: 'local库', provider: 'local', boundAgents: ['hr-employee'] },
        { id: 'b', name: '空ID', provider: 'fastgpt', externalKbId: '', boundAgents: ['hr-employee'] },
      ],
    },
  });
  const config = gen(store);
  assert.equal(config.mcp.servers['kb-hr-employee'], undefined);
});

test('空闲渠道账号保留在 store，但不注入 Gateway runtime', () => {
  const store = makeStore();
  store.channels = [
    { id: 'occupied', type: 'feishu', displayName: '占用', enabled: true, account: { appId: '${FEISHU_HR_BOT_APP_ID}' } },
    { id: 'available', type: 'feishu', displayName: '空闲', enabled: true, account: { appId: '${FEISHU_ADMIN_BOT_APP_ID}' } },
  ];
  store.bindings = [{ agentId: 'hr-employee', match: { channel: 'feishu', accountId: 'occupied' } }];

  const config = gen(store);

  assert.deepEqual(Object.keys(config.channels.feishu.accounts), ['occupied']);
});

test('重复 (id,type) 渠道资产 → generateConfig 抛唯一性校验错误', () => {
  const store = makeStore();
  store.channels = [
    { id: 'hr-employee', type: 'feishu', displayName: 'A', enabled: true, account: { appId: '${FEISHU_HR_BOT_APP_ID}' } },
    { id: 'hr-employee', type: 'feishu', displayName: 'B', enabled: true, account: { appId: '${FEISHU_ADMIN_BOT_APP_ID}' } },
  ];
  assert.throws(() => gen(store), /\(id,type\) 必须唯一/);
});

test('同 id 不同 type（feishu + dingtalk）→ 合法，不报重复', () => {
  const store = makeStore();
  store.channels = [
    { id: 'hr-employee', type: 'feishu', displayName: 'F', enabled: true, account: { appId: '${FEISHU_HR_BOT_APP_ID}' } },
    { id: 'hr-employee', type: 'dingtalk', displayName: 'D', enabled: true, account: { clientId: '${DINGTALK_HR_BOT_CLIENT_ID}' } },
  ];
  assert.doesNotThrow(() => gen(store));
});

// ============================================================================
// ADR-013: profile 字段不进运行时配置（#56）
// ============================================================================

test('profile 完整 → 运行时 agents.list 不含 profile', () => {
  const store = makeStore();
  store.agents[0]!.profile = {
    jobTitle: '入离职专员',
    responsibilities: '解答入离职流程',
    personality: '细致、耐心',
    tone: '清晰、温和',
    boundaries: '不替代 HR 完成人工审批',
  };
  const config = gen(store);
  const emp = config.agents.list.find((a: any) => a.id === 'hr-employee');
  assert.ok(emp, 'hr-employee should be in agents.list');
  assert.equal(emp.profile, undefined, 'profile must be stripped from runtime config');
  // 防御：grep 反向验证整个 config 树里没有 profile
  const json = JSON.stringify(config);
  assert.equal(json.includes('"profile"'), false, 'runtime config JSON must not contain "profile" key anywhere');
  assert.equal(json.includes('入离职专员'), false, 'runtime config must not contain profile field values');
});

test('profile 部分字段 + 旧 persona 共存 → 两者都不进运行时', () => {
  const store = makeStore();
  store.agents[0]!.profile = { jobTitle: '薪酬顾问' };
  (store.agents[0] as any).persona = '旧的 persona 字符串';
  const config = gen(store);
  const emp = config.agents.list.find((a: any) => a.id === 'hr-employee');
  assert.equal(emp.profile, undefined);
  assert.equal(emp.persona, undefined);
  const json = JSON.stringify(config);
  assert.equal(json.includes('旧的 persona'), false);
  assert.equal(json.includes('薪酬顾问'), false);
});

test('profile 缺失 → 运行时配置照常生成（向后兼容）', () => {
  const store = makeStore();
  // hr-employee 不带 profile
  const config = gen(store);
  const emp = config.agents.list.find((a: any) => a.id === 'hr-employee');
  assert.equal(emp.profile, undefined);
});
