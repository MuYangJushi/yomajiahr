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

const { appendAuditLog, readAuditLog } = await import("./util.js");
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
