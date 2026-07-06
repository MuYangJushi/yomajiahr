import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const stateDir = mkdtempSync(join(tmpdir(), "interactions-test-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const { summarizeInteractions } = await import("./interactions.js");

function writeEvents(day: string, events: object[]): void {
  const dir = join(stateDir, "data", "interactions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `events-${day}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("空目录 → 全零摘要不抛错", () => {
  const s = summarizeInteractions();
  assert.equal(s.turns, 0);
  assert.equal(s.searchHitRate, null);
});

test("单轮完整串链：检索命中/时延/token/高频词聚合正确", () => {
  writeEvents("20260706", [
    { ts: "t", hook: "tool_call_start", runId: "r1", agentId: "hr-employee", query: "病假 材料" },
    { ts: "t", hook: "tool_call_end", runId: "r1", durationMs: 400, resultText: "#1（score 0.6）病假应提交医疗证明 [来源: 考勤管理办法.docx]" },
    { ts: "t", hook: "tool_call_start", runId: "r1", query: "病假 天数" },
    { ts: "t", hook: "tool_call_end", runId: "r1", durationMs: 300, resultText: "知识库未命中相关内容" },
    { ts: "t", hook: "agent_end", runId: "r1", success: true, durationMs: 9000 },
    { ts: "t", hook: "llm_output", runId: "r1", usage: { input: 1000, output: 200 } },
  ]);
  const s = summarizeInteractions();
  assert.equal(s.turns, 1);
  assert.equal(s.byAgent["hr-employee"], 1);
  assert.equal(s.searches, 2);
  assert.equal(s.searchHitRate, 0.5); // 一中一未命中
  assert.equal(s.misses.length, 1);
  assert.equal(s.misses[0].query, "病假 天数");
  assert.equal(s.turnDurationMs.p50, 9000);
  assert.equal(s.searchDurationMs.p90, 400);
  assert.deepEqual(s.tokens, { input: 1000, output: 200 });
  assert.equal(s.topQueryTerms[0].term, "病假");
  assert.equal(s.topQueryTerms[0].count, 2);
});

test("since 过滤 + 按天聚合 + 失败轮次", () => {
  writeEvents("20260701", [
    { ts: "t", hook: "agent_end", runId: "old1", success: true, durationMs: 100 },
  ]);
  writeEvents("20260707", [
    { ts: "t", hook: "agent_end", runId: "r2", success: false, durationMs: 500 },
  ]);
  const all = summarizeInteractions();
  assert.equal(all.turns, 3); // r1 + old1 + r2
  const recent = summarizeInteractions("20260706");
  assert.equal(recent.turns, 2); // r1 + r2
  assert.equal(recent.failedTurns, 1);
  assert.deepEqual(recent.byDay.map((d) => d.day), ["20260706", "20260707"]);
});

test("非检索工具的 tool_call_end（无 resultText）不计入检索指标", () => {
  writeEvents("20260708", [
    { ts: "t", hook: "tool_call_start", runId: "r3", toolName: "exec" },
    { ts: "t", hook: "tool_call_end", runId: "r3", toolName: "exec", durationMs: 50 },
    { ts: "t", hook: "agent_end", runId: "r3", success: true, durationMs: 800 },
  ]);
  const s = summarizeInteractions("20260708");
  assert.equal(s.turns, 1);
  assert.equal(s.searches, 0);
});

test("损坏行与无 runId 事件被跳过", () => {
  const dir = join(stateDir, "data", "interactions");
  writeFileSync(join(dir, "events-20260709.jsonl"), '{"hook":"session_start","reason":"new"}\nnot-json\n');
  const s = summarizeInteractions("20260709");
  assert.equal(s.turns, 0);
});
