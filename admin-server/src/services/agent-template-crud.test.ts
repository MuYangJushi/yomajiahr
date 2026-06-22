// 员工模板 CRUD 单测（ADR-018 §决策 2.3）。
// 不走 HTTP；直接调 service 层（路由层只做 schema 校验 + 审计 + 状态码，service 已覆盖核心语义）。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-template-crud-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.HOME = stateDir;
mkdirSync(join(stateDir, "config-store"), { recursive: true });

const {
  createAgentTemplate,
  updateAgentTemplate,
  deleteAgentTemplate,
  restoreAgentTemplate,
} = await import("./agent-template-crud.js");
const { writeAgentTemplateOverlay, readAgentTemplateOverlay } = await import("./store.js");
const { listAgentTemplates } = await import("./agent-templates.js");

function resetOverlay() {
  writeAgentTemplateOverlay({ custom: [], hidden: [], overrides: {} });
}

const VALID_INPUT = {
  id: "finance-clerk",
  name: "财务出纳",
  role: "employee" as const,
  description: "出纳助理",
  department: "finance",
  profile: {
    jobTitle: "出纳",
    responsibilities: "管理日常出纳事务",
    personality: "严谨细致",
    tone: "专业克制",
    boundaries: "不审批支付，仅记录与对账",
  },
  suggestedSkills: [],
};

test("createAgentTemplate：合法输入 → 写 overlay.custom + 列表可见", () => {
  resetOverlay();
  const tpl = createAgentTemplate(VALID_INPUT);
  assert.equal(tpl.id, "finance-clerk");
  assert.equal(tpl.department, "finance");
  const list = listAgentTemplates();
  assert.ok(list.some((t) => t.id === "finance-clerk"));
  const overlay = readAgentTemplateOverlay();
  assert.equal(overlay.custom.length, 1);
});

test("createAgentTemplate：id 非法格式 → 抛错", () => {
  resetOverlay();
  assert.throws(() => createAgentTemplate({ ...VALID_INPUT, id: "Bad ID!" }), /id 非法/);
  assert.throws(() => createAgentTemplate({ ...VALID_INPUT, id: "X" }), /id 非法/); // 太短
});

test("createAgentTemplate：profile 必填段缺失 → 抛错", () => {
  resetOverlay();
  assert.throws(
    () => createAgentTemplate({ ...VALID_INPUT, profile: { ...VALID_INPUT.profile, boundaries: "" } }),
    /profile.boundaries 不能为空/,
  );
});

test("createAgentTemplate：department 不在注册表 → 抛错", () => {
  resetOverlay();
  assert.throws(
    () => createAgentTemplate({ ...VALID_INPUT, department: "not-a-dept" }),
    /department 非法/,
  );
});

test("createAgentTemplate：id 与内置冲突 → 抛错（即便内置已被 hidden）", () => {
  resetOverlay();
  // 直接和内置 hr-employee 撞
  assert.throws(
    () => createAgentTemplate({ ...VALID_INPUT, id: "hr-employee" }),
    /与内置模板冲突/,
  );
  // 把 hr-admin 隐藏后仍不允许同名 custom（避免假复活混淆）
  writeAgentTemplateOverlay({ custom: [], hidden: ["hr-admin"], overrides: {} });
  assert.throws(
    () => createAgentTemplate({ ...VALID_INPUT, id: "hr-admin" }),
    /与内置模板冲突/,
  );
});

test("createAgentTemplate：custom id 重复 → 抛错", () => {
  resetOverlay();
  createAgentTemplate(VALID_INPUT);
  assert.throws(() => createAgentTemplate(VALID_INPUT), /已存在/);
});

test("updateAgentTemplate：编辑自建 → 改 overlay.custom 项；id 不可改", () => {
  resetOverlay();
  createAgentTemplate(VALID_INPUT);
  const updated = updateAgentTemplate("finance-clerk", { name: "出纳新名" });
  assert.equal(updated.name, "出纳新名");
  assert.equal(updated.id, "finance-clerk");
  // 内部存储中 id 不变
  const overlay = readAgentTemplateOverlay();
  assert.equal(overlay.custom[0].id, "finance-clerk");
});

test("updateAgentTemplate：编辑内置 → 写 overlay.overrides[id]，不动 custom", () => {
  resetOverlay();
  const updated = updateAgentTemplate("hr-employee", { name: "覆盖后的 HR 员工", emoji: "💚" });
  assert.equal(updated.id, "hr-employee");
  assert.equal(updated.name, "覆盖后的 HR 员工");
  assert.equal(updated.emoji, "💚");
  const overlay = readAgentTemplateOverlay();
  assert.equal(overlay.custom.length, 0);
  assert.ok(overlay.overrides["hr-employee"]);
  assert.equal(overlay.overrides["hr-employee"].name, "覆盖后的 HR 员工");
});

test("updateAgentTemplate：不存在 → 抛错", () => {
  resetOverlay();
  assert.throws(() => updateAgentTemplate("does-not-exist", { name: "x" }), /模板不存在/);
});

test("updateAgentTemplate：profile 部分字段缺失 → 拒绝（避免半填半留）", () => {
  resetOverlay();
  assert.throws(
    () => updateAgentTemplate("hr-employee", { profile: { jobTitle: "x" } as any }),
    /profile/,
  );
});

test("updateAgentTemplate：department 非法 → 抛错", () => {
  resetOverlay();
  assert.throws(() => updateAgentTemplate("hr-employee", { department: "bogus" }), /department 非法/);
});

test("deleteAgentTemplate：内置 → kind=hidden，加入 hidden 列表，列表中消失", () => {
  resetOverlay();
  const result = deleteAgentTemplate("hr-employee");
  assert.equal(result.kind, "hidden");
  assert.equal(result.id, "hr-employee");
  const list = listAgentTemplates();
  assert.ok(!list.some((t) => t.id === "hr-employee"));
  const overlay = readAgentTemplateOverlay();
  assert.ok(overlay.hidden.includes("hr-employee"));
});

test("deleteAgentTemplate：内置 + 已有 overrides → 删时清除 overrides 残留", () => {
  resetOverlay();
  updateAgentTemplate("hr-employee", { name: "x" });
  let overlay = readAgentTemplateOverlay();
  assert.ok(overlay.overrides["hr-employee"]);
  deleteAgentTemplate("hr-employee");
  overlay = readAgentTemplateOverlay();
  assert.ok(!overlay.overrides["hr-employee"], "overrides 应被清空");
  assert.ok(overlay.hidden.includes("hr-employee"));
});

test("deleteAgentTemplate：自建 → kind=removed，从 custom 真删", () => {
  resetOverlay();
  createAgentTemplate(VALID_INPUT);
  const result = deleteAgentTemplate("finance-clerk");
  assert.equal(result.kind, "removed");
  const overlay = readAgentTemplateOverlay();
  assert.equal(overlay.custom.length, 0);
  assert.ok(!overlay.hidden.includes("finance-clerk"));
});

test("deleteAgentTemplate：不存在 → 抛错", () => {
  resetOverlay();
  assert.throws(() => deleteAgentTemplate("nothing"), /模板不存在/);
});

test("restoreAgentTemplate：恢复软隐藏的内置 → hidden 移除，列表重新可见", () => {
  resetOverlay();
  deleteAgentTemplate("hr-admin");
  let list = listAgentTemplates();
  assert.ok(!list.some((t) => t.id === "hr-admin"));
  const tpl = restoreAgentTemplate("hr-admin");
  assert.equal(tpl.id, "hr-admin");
  list = listAgentTemplates();
  assert.ok(list.some((t) => t.id === "hr-admin"));
});

test("restoreAgentTemplate：恢复未隐藏的内置 → 抛错", () => {
  resetOverlay();
  assert.throws(() => restoreAgentTemplate("hr-admin"), /未被隐藏/);
});

test("restoreAgentTemplate：自建模板不可恢复（已真删）", () => {
  resetOverlay();
  assert.throws(() => restoreAgentTemplate("finance-clerk"), /不是内置/);
});

// 清理
test.after(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});
