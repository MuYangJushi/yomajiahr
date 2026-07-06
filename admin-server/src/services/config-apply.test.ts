import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyModeForOperation,
  ensureApplied,
  hasPendingApply,
  triggerApply,
  waitForApplyResult,
  type ApplyResult,
} from "./config-apply.js";

test("applyModeForOperation keeps runtime-only for agent-only changes", () => {
  assert.equal(applyModeForOperation("agent.create"), "runtime-only");
  assert.equal(applyModeForOperation("agent.update.profile"), "runtime-only");
  assert.equal(applyModeForOperation("agent.skill.update"), "runtime-only");
  assert.equal(applyModeForOperation("agent.delete", { agentHasChannels: false }), "runtime-only");
});

test("applyModeForOperation restarts for knowledge MCP and channel changes", () => {
  assert.equal(applyModeForOperation("knowledge.bind"), "restart");
  assert.equal(applyModeForOperation("knowledge.unbind"), "restart");
  assert.equal(applyModeForOperation("knowledge.delete"), "restart");
  assert.equal(applyModeForOperation("knowledge.base.create"), "restart");
  assert.equal(applyModeForOperation("agent.delete", { agentHasChannels: true }), "restart");
  assert.equal(applyModeForOperation("agent.channel.bind"), "restart");
  assert.equal(applyModeForOperation("agent.channel.unbind"), "restart");
  assert.equal(applyModeForOperation("knowledge.config"), "restart");
  assert.equal(applyModeForOperation("gateway.restart"), "restart");
  assert.equal(applyModeForOperation(undefined), "restart");
  assert.equal(applyModeForOperation("unknown"), "restart");
});

// —— pending 语义收口（设计债 apply-pending-design-debt.md）——

test("ensureApplied: failed 才 throw，pending/success 放行", () => {
  assert.throws(() => ensureApplied({ status: "failed", message: "boom" }, "上线失败"), /上线失败：boom/);
  assert.doesNotThrow(() => ensureApplied({ status: "success" }, "上线失败"));
  // pending 不 throw（不传 stateDir 时也不起后台追踪）
  assert.doesNotThrow(() => ensureApplied({ status: "pending", requestId: "r1" }, "上线失败"));
});

test("hasPendingApply: 识别结果对象里的 pending apply", () => {
  assert.equal(hasPendingApply({ apply: { status: "pending" } }), true);
  assert.equal(hasPendingApply({ apply: { status: "success" } }), false);
  assert.equal(hasPendingApply({}), false);
  assert.equal(hasPendingApply(null), false);
  assert.equal(hasPendingApply("str"), false);
});

test("triggerApply 队列模式超时返回 pending 且带 requestId", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "apply-pending-"));
  const prev = process.env.OPENCLAW_APPLY_DIRECT;
  process.env.OPENCLAW_APPLY_DIRECT = "0"; // 强制队列模式（生产语义），无 helper 消费 → 超时 pending
  try {
    const result = await triggerApply({ stateDir, repoDir: stateDir, timeoutMs: 700, mode: "runtime-only", operation: "agent.create" });
    assert.equal(result.status, "pending");
    assert.ok(result.requestId, "pending 必须带 requestId 供追踪");
    // requestId 与写入的 request 文件一致
    const req = JSON.parse(readFileSync(join(stateDir, "control", "apply-request.json"), "utf-8"));
    assert.equal(result.requestId, req.id);
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_APPLY_DIRECT;
    else process.env.OPENCLAW_APPLY_DIRECT = prev;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("waitForApplyResult 只认同一 requestId 的终态", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "apply-wait-"));
  const controlDir = join(stateDir, "control");
  mkdirSync(controlDir, { recursive: true });
  try {
    // 结果文件是别的请求 → 超时返回 null（不误读他人结果）
    writeFileSync(join(controlDir, "apply-result.json"), JSON.stringify({ status: "success", requestId: "other" }));
    assert.equal(await waitForApplyResult(stateDir, "mine", 300, 100), null);
    // 结果文件是本请求 → 返回终态
    writeFileSync(join(controlDir, "apply-result.json"), JSON.stringify({ status: "failed", requestId: "mine", message: "x" }));
    const r = (await waitForApplyResult(stateDir, "mine", 1000, 100)) as ApplyResult;
    assert.equal(r.status, "failed");
    assert.equal(r.requestId, "mine");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
