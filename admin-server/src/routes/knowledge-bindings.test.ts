import assert from "node:assert/strict";
import test from "node:test";
import { computeRevokedAgentIds } from "./knowledge.js";

const kb = (id: string, externalKbId: string, boundAgents: string[], provider = "fastgpt") =>
  ({ id, name: id, provider, externalKbId, boundAgents } as any);
const store = (...bases: any[]) => ({ platform: "fastgpt", knowledgeBases: bases } as any);

test("computeRevokedAgentIds：单库解绑 → agent 计入 revoked", () => {
  const prev = store(kb("kb0", "ds0", ["hr-employee", "hr-admin"]));
  const next = store(kb("kb0", "ds0", ["hr-employee"]));
  assert.deepEqual(computeRevokedAgentIds(prev, next), ["hr-admin"]);
});

test("computeRevokedAgentIds：多库 agent 从其一解绑但仍绑另一库 → 不计入 revoked（fix/qa-fixes 核心回归）", () => {
  // hr-admin 同绑默认库 + 人才发展库，本次只从人才发展库解绑 → 仍绑默认库，不算撤权。
  const prev = store(kb("kb_default", "ds_def", ["hr-admin"]), kb("kb_talent", "ds_talent", ["hr-employee", "hr-admin"]));
  const next = store(kb("kb_default", "ds_def", ["hr-admin"]), kb("kb_talent", "ds_talent", ["hr-employee"]));
  assert.deepEqual(computeRevokedAgentIds(prev, next), []);
});

test("computeRevokedAgentIds：从最后一个绑定库解绑 → 计入 revoked", () => {
  const prev = store(kb("kb_default", "ds_def", ["hr-admin"]), kb("kb_talent", "ds_talent", ["hr-admin"]));
  const next = store(kb("kb_default", "ds_def", ["hr-admin"]), kb("kb_talent", "ds_talent", []));
  assert.deepEqual(computeRevokedAgentIds(prev, next), []); // 仍绑默认库

  const next2 = store(kb("kb_default", "ds_def", []), kb("kb_talent", "ds_talent", []));
  assert.deepEqual(computeRevokedAgentIds(prev, next2), ["hr-admin"]); // 两库都解绑才撤权
});

test("computeRevokedAgentIds：仍绑的库 externalKbId 为空（不可检索）→ 不算 still-bound，计入 revoked", () => {
  const prev = store(kb("kb0", "ds0", ["hr-admin"]), kb("kb1", "ds1", ["hr-admin"]));
  const next = store(kb("kb0", "", ["hr-admin"]), kb("kb1", "ds1", []));
  // kb0 externalKbId 空 → 与 verify 脚本一致不视为有效绑定 → hr-admin 实际无可检索库 → revoked
  assert.deepEqual(computeRevokedAgentIds(prev, next), ["hr-admin"]);
});
