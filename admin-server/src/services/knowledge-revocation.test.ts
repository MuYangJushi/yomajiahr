import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const resetScript = join(repoDir, "config/scripts/reset-agent-sessions.mjs");
const verifyScript = join(repoDir, "config/scripts/verify-knowledge-revocation.mjs");

function fixture() {
  const stateDir = join(tmpdir(), `yomajiahr-revocation-test-${process.pid}-${Math.random()}`);
  const sessionsDir = join(stateDir, "agents", "employee", "sessions");
  const controlDir = join(stateDir, "control");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });
  return { stateDir, sessionsDir, requestPath: join(controlDir, "apply-request.json") };
}

test("reset script archives current transcripts, clears the active index, and preserves its permissions", () => {
  const { stateDir, sessionsDir, requestPath } = fixture();
  const transcript = join(sessionsDir, "current.jsonl");
  const storePath = join(sessionsDir, "sessions.json");
  writeFileSync(transcript, "policy context\n");
  writeFileSync(storePath, JSON.stringify({ "agent:employee:main": { sessionFile: transcript } }));
  chmodSync(storePath, 0o640);
  writeFileSync(requestPath, JSON.stringify({ resetAgentIds: ["employee"] }));

  const result = JSON.parse(execFileSync("node", [resetScript, stateDir, requestPath], { encoding: "utf8" }));

  assert.deepEqual(result, [{ agentId: "employee", sessionCount: 1 }]);
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")), {});
  assert.equal(statSync(storePath).mode & 0o777, 0o640);
  assert.equal(existsSync(transcript), false);
  assert.equal(readdirSync(sessionsDir).some((name) => name.startsWith("current.jsonl.reset.")), true);
});

test("reset script rejects transcript paths outside the agent sessions directory before changing files", () => {
  const { stateDir, sessionsDir, requestPath } = fixture();
  const storePath = join(sessionsDir, "sessions.json");
  writeFileSync(storePath, JSON.stringify({ unsafe: { sessionFile: join(stateDir, "outside.jsonl") } }));
  writeFileSync(requestPath, JSON.stringify({ resetAgentIds: ["employee"] }));

  assert.throws(() => execFileSync("node", [resetScript, stateDir, requestPath]), /unsafe sessionFile/);
  assert.notDeepEqual(JSON.parse(readFileSync(storePath, "utf8")), {});
});

test("revocation verification requires store binding, runtime tool, and MCP registration to all be absent", () => {
  const { stateDir, requestPath } = fixture();
  mkdirSync(join(stateDir, "config-store"), { recursive: true });
  writeFileSync(requestPath, JSON.stringify({ revokedKnowledgeAgentIds: ["employee"] }));
  writeFileSync(
    join(stateDir, "config-store", "knowledge.json"),
    JSON.stringify({
      platform: "fastgpt",
      knowledgeBases: [{ id: "kb", provider: "fastgpt", externalKbId: "ds", boundAgents: [] }],
    }),
  );
  writeFileSync(
    join(stateDir, "openclaw.json"),
    JSON.stringify({ agents: { list: [{ id: "employee", tools: { allow: [] } }] }, mcp: { servers: {} } }),
  );

  execFileSync("node", [verifyScript, stateDir, requestPath]);

  writeFileSync(
    join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: { list: [{ id: "employee", tools: { allow: ["kb-employee__knowledge_search"] } }] },
      mcp: { servers: {} },
    }),
  );
  assert.throws(
    () => execFileSync("node", [verifyScript, stateDir, requestPath]),
    /runtime still exposes a knowledge tool/,
  );
});
