// 异步 apply 任务管线（fix/usage-bugs #1）— 状态迁移与 TTL 行为单测。
import assert from "node:assert/strict";
import test from "node:test";
import { _resetApplyJobs, enqueueApplyJob, getApplyJob } from "./apply-jobs.js";

test("成功任务：状态从 running → success 携带 result", async () => {
  _resetApplyJobs();
  const { jobId, promise } = enqueueApplyJob(async () => ({ value: 42 }), "test.ok");
  // 入队即 running（不是 queued，因为我们是 microtask 里推进的）
  const before = getApplyJob(jobId);
  assert.ok(before);
  assert.equal(before!.label, "test.ok");
  assert.ok(["queued", "running"].includes(before!.status));
  await promise;
  const after = getApplyJob(jobId);
  assert.equal(after?.status, "success");
  assert.deepEqual(after?.result, { value: 42 });
  assert.equal(after?.message, "已应用");
  assert.ok(after?.finishedAt);
});

test("失败任务：状态变 failed 并保留错误消息", async () => {
  _resetApplyJobs();
  const { jobId, promise } = enqueueApplyJob(async () => {
    throw new Error("BOOM");
  }, "test.fail");
  await promise.catch(() => {});
  const job = getApplyJob(jobId);
  assert.equal(job?.status, "failed");
  assert.equal(job?.message, "BOOM");
  assert.equal(job?.result, undefined);
  assert.ok(job?.finishedAt);
});

test("未捕获 rejection 不影响进程：promise.catch 已挂", async () => {
  _resetApplyJobs();
  const { promise } = enqueueApplyJob(async () => {
    throw new Error("nobody await");
  }, "test.unhandled");
  // 不 await，让事件循环跑一下；如果有 unhandledRejection 会让进程崩——测试自动失败。
  await new Promise((r) => setTimeout(r, 10));
  // 显式消费一次防止 node test runner 的未处理 rejection 检查
  await promise.catch(() => {});
});

test("getApplyJob：未知 id 返回 undefined", () => {
  _resetApplyJobs();
  assert.equal(getApplyJob("not-a-real-id"), undefined);
});

test("并发入队：每个 jobId 独立追踪", async () => {
  _resetApplyJobs();
  const a = enqueueApplyJob(async () => "A", "test.a");
  const b = enqueueApplyJob(async () => "B", "test.b");
  assert.notEqual(a.jobId, b.jobId);
  await Promise.all([a.promise, b.promise]);
  assert.equal(getApplyJob(a.jobId)?.result, "A");
  assert.equal(getApplyJob(b.jobId)?.result, "B");
});
