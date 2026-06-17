// 空白起步可部署性（ADR-013 延伸：平台初始无 agent，从模板创建）。
// 核心保证：用实际部署的 seed 组合（空 agents、空 bindings、完整 channels）跑生成器，
// 产出的 openclaw.json 必须通过 validate-config —— 否则空平台一上线 gateway 就拒绝起。
// 直接读仓库里被改动的 seed 文件，确保测的是真实部署内容，而非内存 fixture。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { generateConfig } from './generate-config.js';
import { validateConfig } from './validate-config.js';
import type { ConfigStore } from './types.js';

const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATH = resolve(configDir, 'openclaw.base.jsonc');
const ENV_PATH = resolve(configDir, '.env.example');
const SEED_DIR = resolve(configDir, 'config-store.seed');

function readSeed(name: string): unknown {
  return JSON.parse(readFileSync(resolve(SEED_DIR, `${name}.json`), 'utf-8'));
}

function emptyPlatformStore(): ConfigStore {
  return {
    agents: readSeed('agents') as ConfigStore['agents'],
    bindings: readSeed('bindings') as ConfigStore['bindings'],
    channels: readSeed('channels') as ConfigStore['channels'],
  };
}

test('空白起步 seed：无 agent / 无 binding / 有 channels → 生成器产出合法 openclaw.json', () => {
  const store = emptyPlatformStore();
  assert.equal(store.agents.length, 0, 'seed agents 应为空（平台初始无数字员工）');
  assert.equal(store.bindings.length, 0, 'seed bindings 应为空');

  const { config } = generateConfig({ basePath: BASE_PATH, store, envPath: ENV_PATH });
  const c = config as any;
  // 无 agent → 空 agents.list、无 per-agent kb-* MCP 注册。
  assert.deepEqual(c.agents.list, [], 'agents.list 应为空');
  assert.deepEqual(c.mcp?.servers ?? {}, {}, '无绑定不应生成任何 kb-* MCP 注册');

  const result = validateConfig(store, config, {});
  assert.equal(result.ok, true, `空平台配置应通过校验，但有错误：${result.errors.join('；')}`);
});
