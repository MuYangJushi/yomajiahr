// #29/#73：审计落操作人的两条不变量——
//  ① 经 appendAuditLog（operator 必填参数）写入的新日志，details.operator 必为传入值（非空）；
//  ② 缺 operator 的历史日志在台账/CSV 渲染时标注「(历史·未落操作人)」，不回填伪造。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-audit-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
mkdirSync(join(stateDir, "data", "hr-admin"), { recursive: true });

const { appendAuditLog, readAuditLog, auditOperator } = await import("./util.js");
const { operatorName } = await import("./audit-labels.js");

test("appendAuditLog 把 operator 写进 details.operator（新日志不空）", async () => {
  appendAuditLog("agent.delete", "agent-x", "feishu:u123", { agent_id: "agent-x" });
  // 写队列是微任务串行，flush 后回读。
  await new Promise((r) => setTimeout(r, 50));
  const log = readAuditLog();
  const entry = log.find((e) => e.action === "agent.delete" && e.file === "agent-x");
  assert.ok(entry, "应写入审计条目");
  assert.equal(entry.details.operator, "feishu:u123");
  assert.equal(entry.details.agent_id, "agent-x");
  assert.notEqual(operatorName(entry), "(历史·未落操作人)");
  assert.equal(operatorName(entry), "feishu:u123");
});

test("缺 operator 的历史日志标注「(历史·未落操作人)」，不伪造", () => {
  assert.equal(operatorName({ details: { agent_id: "old" } }), "(历史·未落操作人)");
  assert.equal(operatorName({ details: {} }), "(历史·未落操作人)");
  assert.equal(operatorName({}), "(历史·未落操作人)");
});

test("operatorName 兼容历史 {id,name} 对象形态", () => {
  assert.equal(operatorName({ details: { operator: { id: "a", name: "张三" } } }), "张三");
});

// fix/0623：操作人结构化 { id, name }——台账优先显示人类可读 name，保留 id 取证。
test("auditOperator 从会话派生 { id, name }", () => {
  assert.deepEqual(auditOperator({ user: { platformUserId: "feishu:on_abc", name: "李四" } }), {
    id: "feishu:on_abc",
    name: "李四",
  });
  // 无登录态：id/name 皆空（→ 历史/系统来源语义）。
  assert.deepEqual(auditOperator({}), { id: "", name: undefined });
});

test("appendAuditLog 存结构化操作人 { id, name }，台账显示 name", async () => {
  appendAuditLog("agent.delete", "agent-y", auditOperator({ user: { platformUserId: "demo:9a7f", name: "比赛访客" } }), {
    agent_id: "agent-y",
  });
  await new Promise((r) => setTimeout(r, 50));
  const entry = readAuditLog().find((e) => e.action === "agent.delete" && e.file === "agent-y");
  assert.ok(entry, "应写入审计条目");
  assert.deepEqual(entry.details.operator, { id: "demo:9a7f", name: "比赛访客" });
  assert.equal(operatorName(entry), "比赛访客");
});

test("operatorName 对象缺 name 时退化短 id，不误标历史", () => {
  // 结构化对象有 id 但 name 缺失 → 仍是真实操作人，显示短 id，绝不标「历史」。
  const out = operatorName({ details: { operator: { id: "feishu:on_1db1339b318f2350cb08b982d5819354" } } });
  assert.notEqual(out, "(历史·未落操作人)");
  assert.match(out, /feishu/);
});
