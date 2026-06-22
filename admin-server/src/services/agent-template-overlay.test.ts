// 员工模板 overlay + 合并语义（ADR-018 §决策 2）。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-template-overlay-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.HOME = stateDir; // STATE_DIR 派生用

// 先建好 config-store 目录骨架，避免 store.ts 的 STORE_DIR 读时找不到
mkdirSync(join(stateDir, "config-store"), { recursive: true });
// 内置模板留空，让 listAgentTemplates 走仓库源 fallback（仓库内 27 个）。

const { listAgentTemplates, listBuiltinAgentTemplates } = await import("./agent-templates.js");
const { writeAgentTemplateOverlay, readAgentTemplateOverlay } = await import("./store.js");

function resetOverlay(overlay: any) {
  writeAgentTemplateOverlay(overlay);
}

test("listAgentTemplates：空 overlay 时与无 overlay 行为一致（向后兼容）", () => {
  resetOverlay({ custom: [], hidden: [], overrides: {} });
  const list = listAgentTemplates();
  const builtins = listBuiltinAgentTemplates();
  assert.equal(list.length, builtins.length, "空 overlay 时列表 = 内置模板");
  assert.ok(list.some((x) => x.id === "hr-employee"));
  assert.ok(list.some((x) => x.id === "engineer"));
});

test("listAgentTemplates：hidden 隐藏内置模板", () => {
  resetOverlay({ custom: [], hidden: ["hr-employee"], overrides: {} });
  const list = listAgentTemplates();
  assert.ok(!list.some((x) => x.id === "hr-employee"), "hr-employee 应被隐藏");
  assert.ok(list.some((x) => x.id === "hr-admin"), "hr-admin 仍可见");
});

test("listAgentTemplates：overrides 字段级覆盖内置模板，id 不变", () => {
  resetOverlay({
    custom: [],
    hidden: [],
    overrides: {
      "hr-employee": {
        name: "覆盖后的 HR 员工",
        emoji: "💚",
        profile: { jobTitle: "新岗位", responsibilities: "新职责" },
      },
    },
  });
  const list = listAgentTemplates();
  const t = list.find((x) => x.id === "hr-employee");
  assert.ok(t, "hr-employee 仍存在");
  assert.equal(t!.name, "覆盖后的 HR 员工");
  assert.equal(t!.emoji, "💚");
  assert.equal(t!.profile.jobTitle, "新岗位");
  assert.equal(t!.profile.responsibilities, "新职责");
  // 未覆盖字段保留内置值
  assert.ok(t!.profile.personality && t!.profile.personality.length > 0);
});

test("listAgentTemplates：custom 用户模板加入列表", () => {
  resetOverlay({
    custom: [
      {
        id: "finance-clerk",
        name: "财务出纳",
        role: "employee",
        description: "出纳助理",
        suggestedId: "finance-clerk",
        department: "finance",
        profile: {
          jobTitle: "出纳",
          responsibilities: "出纳事务",
          personality: "严谨",
          tone: "克制",
          boundaries: "不审批支付",
        },
        suggestedSkills: [],
      },
    ],
    hidden: [],
    overrides: {},
  });
  const list = listAgentTemplates();
  const t = list.find((x) => x.id === "finance-clerk");
  assert.ok(t, "custom 模板应进入列表");
  assert.equal(t!.name, "财务出纳");
  assert.equal(t!.department, "finance");
  assert.equal(t!.role, "employee");
});

test("listAgentTemplates：合并 hidden + overrides + custom 同时生效", () => {
  resetOverlay({
    custom: [
      {
        id: "cs-rep",
        name: "客服专员",
        role: "employee",
        description: "客服",
        suggestedId: "cs-rep",
        department: "customer",
        profile: { jobTitle: "客服", responsibilities: "x", personality: "x", tone: "x", boundaries: "x" },
      },
    ],
    hidden: ["hr-admin"],
    overrides: { engineer: { name: "覆盖工程师" } },
  });
  const list = listAgentTemplates();
  assert.ok(!list.some((x) => x.id === "hr-admin"), "hr-admin 已隐藏");
  assert.equal(list.find((x) => x.id === "engineer")?.name, "覆盖工程师");
  assert.ok(list.some((x) => x.id === "cs-rep"));
});

test("listAgentTemplates：部门兜底（custom 无 department + category）→ other", () => {
  resetOverlay({
    custom: [
      {
        id: "loose-1",
        name: "无部门",
        role: "employee",
        suggestedId: "loose-1",
        profile: { jobTitle: "x", responsibilities: "x", personality: "x", tone: "x", boundaries: "x" },
      },
    ],
    hidden: [],
    overrides: {},
  });
  const list = listAgentTemplates();
  assert.equal(list.find((x) => x.id === "loose-1")?.department, "other");
});

test("listAgentTemplates：按 (department.order, id) 排序", () => {
  resetOverlay({ custom: [], hidden: [], overrides: {} });
  const list = listAgentTemplates();
  // ceo 在 leadership(order=10) 应早于 hr-* 在 hr(order=20)
  const ceoIdx = list.findIndex((x) => x.id === "ceo");
  const hrAdminIdx = list.findIndex((x) => x.id === "hr-admin");
  assert.ok(ceoIdx >= 0 && hrAdminIdx >= 0);
  assert.ok(ceoIdx < hrAdminIdx, `ceo(leadership) 应早于 hr-admin(hr)，实际 ${ceoIdx} vs ${hrAdminIdx}`);
});

test("readAgentTemplateOverlay：文件不存在返回空 overlay（旧部署兼容）", () => {
  // 删 overlay 文件
  const p = join(stateDir, "config-store", "agent-templates.json");
  try {
    require("node:fs").unlinkSync(p);
  } catch {
    /* 已删 */
  }
  const o = readAgentTemplateOverlay();
  assert.deepEqual(o, { custom: [], hidden: [], overrides: {} });
});

test("readAgentTemplateOverlay：JSON 损坏返回空 overlay（不崩主流程）", () => {
  const p = join(stateDir, "config-store", "agent-templates.json");
  writeFileSync(p, "this is not json");
  const o = readAgentTemplateOverlay();
  assert.deepEqual(o, { custom: [], hidden: [], overrides: {} });
});
