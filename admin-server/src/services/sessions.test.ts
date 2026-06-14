import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-sessions-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
const sessionsDir = join(stateDir, "agents", "employee", "sessions");
mkdirSync(sessionsDir, { recursive: true });

const { resetCurrentAgentSessions } = await import("./sessions.js");

test("只重置当前会话上下文并保留历史 transcript", () => {
  const current = join(sessionsDir, "current.jsonl");
  const historical = join(sessionsDir, "historical.jsonl.reset.old");
  writeFileSync(current, "current context\n");
  writeFileSync(historical, "history\n");
  writeFileSync(
    join(sessionsDir, "sessions.json"),
    JSON.stringify({ "agent:employee:feishu:account:direct:user": { sessionFile: current } }),
  );

  assert.deepEqual(resetCurrentAgentSessions(["employee"]), [{ agentId: "employee", sessionCount: 1 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(sessionsDir, "sessions.json"), "utf-8")), {});
  assert.equal(existsSync(current), false);
  assert.equal(existsSync(historical), true);
  assert.equal(readdirSync(sessionsDir).some((name) => name.startsWith("current.jsonl.reset.")), true);
});
