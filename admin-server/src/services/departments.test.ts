// 部门注册表测试（ADR-018 §1.1）。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-departments-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;

const { listDepartments, resolveTemplateDepartment, CATEGORY_TO_DEPARTMENT } = await import("./departments.js");

test("listDepartments：仓库源含 12 个部门，按 order 排序", () => {
  // 默认从仓库源读取（STATE_DIR 未播种部门表时回退）
  const list = listDepartments();
  assert.ok(list.length >= 12, `应至少 12 个部门，实际 ${list.length}`);
  const ids = list.map((d) => d.id);
  for (const need of ["leadership", "hr", "engineering", "other"]) {
    assert.ok(ids.includes(need), `应含 ${need} 部门`);
  }
  // 排序验证：order 递增
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].order <= list[i].order, "部门按 order 升序排列");
  }
  // other 必为最后
  assert.equal(list[list.length - 1].id, "other");
});

test("listDepartments：STATE_DIR 副本优先于仓库源", () => {
  const dir = join(stateDir, "workspaces", "_templates");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "departments.json"),
    JSON.stringify([
      { id: "alpha", label: "Alpha 部门", order: 5 },
      { id: "other", label: "其他", order: 999 },
    ]),
  );
  const list = listDepartments();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "alpha");
});

test("resolveTemplateDepartment：显式 department 优先", () => {
  const known = new Set(["hr", "engineering", "other"]);
  assert.equal(resolveTemplateDepartment("hr", "engineering", known), "hr");
});

test("resolveTemplateDepartment：未声明 department 按 category 兜底", () => {
  const known = new Set(["hr", "engineering", "marketing", "operations", "other"]);
  assert.equal(resolveTemplateDepartment(undefined, "hr", known), "hr");
  assert.equal(resolveTemplateDepartment(undefined, "communication", known), "marketing");
  assert.equal(resolveTemplateDepartment(undefined, "event", known), "operations");
});

test("resolveTemplateDepartment：兜底 other（未知 department 且无 category 映射）", () => {
  const known = new Set(["hr", "other"]);
  assert.equal(resolveTemplateDepartment("unknown", undefined, known), "other");
  assert.equal(resolveTemplateDepartment(undefined, "unknown-cat", known), "other");
  assert.equal(resolveTemplateDepartment(undefined, undefined, known), "other");
});

test("CATEGORY_TO_DEPARTMENT：映射表覆盖现有 10 个 category", () => {
  // ADR-018 §1.3 一次性映射表
  const expected = ["hr", "leadership", "product", "engineering", "data", "research", "communication", "event", "education", "general"];
  for (const cat of expected) {
    assert.ok(CATEGORY_TO_DEPARTMENT[cat], `category=${cat} 应有映射`);
  }
});
