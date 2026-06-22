import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrgRole } from "./org-mapping.js";
import type { IdpIdentity } from "./types.js";

const feishu: IdpIdentity = { idp: "feishu", unionId: "u1", name: "测试" };

test("默认关（enabled 未传且 env 未开）→ null，不调用 fetcher", async () => {
  let called = false;
  const role = await resolveOrgRole(feishu, {
    fetchDepartmentIds: async () => {
      called = true;
      return ["hr-dept"];
    },
  });
  assert.equal(role, null);
  assert.equal(called, false);
});

test("开启 + 命中 admin 部门 → 提升 admin", async () => {
  const role = await resolveOrgRole(feishu, {
    enabled: true,
    adminDeptIds: ["hr-dept"],
    fetchDepartmentIds: async () => ["other", "hr-dept"],
  });
  assert.equal(role, "admin");
});

test("开启但不在 admin 部门 → null（仅提升，不降级）", async () => {
  const role = await resolveOrgRole(feishu, {
    enabled: true,
    adminDeptIds: ["hr-dept"],
    fetchDepartmentIds: async () => ["sales-dept"],
  });
  assert.equal(role, null);
});

test("开启但部门 API 抛错 → 结果不是 admin（fail-closed）", async () => {
  const role = await resolveOrgRole(feishu, {
    enabled: true,
    adminDeptIds: ["hr-dept"],
    fetchDepartmentIds: async () => {
      throw new Error("scope 未开通：99991672");
    },
  });
  assert.equal(role, null);
});

test("开启但部门列表为空 → null（fail-closed）", async () => {
  const role = await resolveOrgRole(feishu, {
    enabled: true,
    adminDeptIds: ["hr-dept"],
    fetchDepartmentIds: async () => [],
  });
  assert.equal(role, null);
});

test("开启但无 admin 部门规则 → null（避免误配把所有人当 admin）", async () => {
  let called = false;
  const role = await resolveOrgRole(feishu, {
    enabled: true,
    adminDeptIds: [],
    fetchDepartmentIds: async () => {
      called = true;
      return ["hr-dept"];
    },
  });
  assert.equal(role, null);
  assert.equal(called, false);
});

test("demo 访客无组织 → null", async () => {
  const role = await resolveOrgRole(
    { idp: "demo", unionId: "x", name: "访客" },
    { enabled: true, adminDeptIds: ["hr-dept"], fetchDepartmentIds: async () => ["hr-dept"] },
  );
  assert.equal(role, null);
});
