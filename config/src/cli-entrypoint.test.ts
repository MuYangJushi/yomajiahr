// 回归：发布包用 current → releases/<ver> symlink 布局调用 generate-config.js。
// 修复前 isMain() 直接比较 process.argv[1]（symlink 路径）与 import.meta.url（Node 默认 realpath
// 后的实路径），经 symlink 调用时误判为「非入口」→ 整段生成逻辑被跳过、exit 0 却不写 --out 文件，
// 导致 apply-config.sh 随后 validate 一个不存在的 staging → "OpenClaw 原生配置校验失败"。
// 运行：npm run build && node --test dist/*.test.js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url)); // dist/
const configDir = resolve(here, '..');
const CLI = resolve(here, 'generate-config.js');
const BASE_PATH = resolve(configDir, 'openclaw.base.jsonc');
const ENV_PATH = resolve(configDir, '.env.example');
const SEED_STORE = resolve(configDir, 'config-store.seed');

function runCli(scriptPath: string, out: string, stateDir: string) {
  execFileSync(
    process.execPath,
    [
      scriptPath,
      '--out', out,
      '--base', BASE_PATH,
      '--store', SEED_STORE,
      '--env', ENV_PATH,
      '--state-dir', stateDir,
    ],
    { stdio: 'pipe' },
  );
}

test('经 symlink 路径调用 generate-config 仍写出 --out 文件（发布包 current symlink 回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
  // 模拟发布包 current → releases/<ver> 布局：link 指向真实 CLI。
  const link = join(dir, 'generate-config.js');
  symlinkSync(CLI, link);
  const out = join(dir, 'openclaw.json.staging');

  runCli(link, out, dir);

  assert.ok(existsSync(out), '经 symlink 调用必须写出 --out 文件，否则 isMain 误判生成逻辑被跳过');
});

test('经实路径调用 generate-config 写出 --out 文件（对照）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-entry-real-'));
  const out = join(dir, 'openclaw.json.staging');

  runCli(CLI, out, dir);

  assert.ok(existsSync(out), '经实路径调用必须写出 --out 文件');
});
