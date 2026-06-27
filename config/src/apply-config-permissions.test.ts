import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scriptPath = join(repoDir, 'config', 'scripts', 'apply-config.sh');
const applyRunnerPath = join(tmpdir(), `yomajiahr-apply-runner-${process.pid}.sh`);

writeFileSync(
  applyRunnerPath,
  `#!/usr/bin/env bash
set -euo pipefail
source "$1"
`,
);
chmodSync(applyRunnerPath, 0o755);

function createStateDir(name: string): string {
  const stateDir = join(tmpdir(), `yomajiahr-${name}-${process.pid}`);
  mkdirSync(join(stateDir, 'config-store'), { recursive: true });
  mkdirSync(join(stateDir, 'skills'), { recursive: true });
  writeFileSync(join(stateDir, 'config-store', 'agents.json'), '[]\n');
  writeFileSync(join(stateDir, 'config-store', 'bindings.json'), '[]\n');
  writeFileSync(join(stateDir, 'config-store', 'channels.json'), '[]\n');
  writeFileSync(join(stateDir, '.env'), readFileSync(join(repoDir, 'config', '.env.example'), 'utf-8'));
  return stateDir;
}

test('apply-config：原子替换前先修正 staging 权限，避免 runtime-only watcher EACCES 窗口', () => {
  const stateDir = createStateDir('apply-permission');
  const fakeBin = join(stateDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, 'openclaw'),
    `#!/usr/bin/env bash
if [ "$1 $2" = "config validate" ]; then exit 0; fi
echo "unexpected openclaw args: $*" >&2
exit 1
`,
  );
  chmodSync(join(fakeBin, 'openclaw'), 0o755);
  const chownLog = join(stateDir, 'chown.log');
  writeFileSync(
    join(fakeBin, 'chown'),
    `#!/usr/bin/env bash
echo "$*" >> "$YOMAJIA_TEST_CHOWN_LOG"
exit 0
`,
  );
  chmodSync(join(fakeBin, 'chown'), 0o755);
  writeFileSync(
    join(fakeBin, 'mv'),
    `#!/usr/bin/env bash
if [ "$1" = "$YOMAJIA_TEST_STAGING" ] && [ "$2" = "$YOMAJIA_TEST_RUNTIME" ]; then
  if ! grep -F -- "$YOMAJIA_TEST_STAGING" "$YOMAJIA_TEST_CHOWN_LOG" >/dev/null 2>&1; then
    echo "staging was not chowned before runtime swap" >&2
    exit 42
  fi
fi
exec /bin/mv "$@"
`,
  );
  chmodSync(join(fakeBin, 'mv'), 0o755);

  execFileSync(applyRunnerPath, [scriptPath], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      REPO_DIR: repoDir,
      STATE_DIR: stateDir,
      YOMAJIA_TEST_CHOWN_LOG: chownLog,
      YOMAJIA_TEST_STAGING: join(stateDir, 'openclaw.json.staging'),
      YOMAJIA_TEST_RUNTIME: join(stateDir, 'openclaw.json'),
      PROCESS_APPLY_REQUEST: '0',
      APPLY_MODE: 'runtime-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const runtimeStat = statSync(join(stateDir, 'openclaw.json'));
  assert.equal(runtimeStat.mode & 0o777, 0o600);

  const stateStat = statSync(stateDir);
  assert.equal(runtimeStat.uid, stateStat.uid);
  assert.equal(runtimeStat.gid, stateStat.gid);
});
