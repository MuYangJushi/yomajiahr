// Agent 模板文件化测试（ADR-016 §1）：读目录派生 + 新字段 + 缺失目录兜底。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-templates-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
// 仓库源 fallback：本测试用 STATE_DIR 部署副本验证读目录派生。

const { listAgentTemplates } = await import("./agent-templates.js");

test("listAgentTemplates：从 STATE_DIR 部署副本读目录派生，含新可选字段", () => {
  const dir = join(stateDir, "workspaces", "_templates", "agents");
  mkdirSync(join(dir, "onboarding-template"), { recursive: true });
  writeFileSync(
    join(dir, "onboarding-template", "template.json"),
    JSON.stringify({
      id: "onboarding",
      name: "入职专员",
      emoji: "🧭",
      description: "入职引导",
      suggestedId: "onboarding",
      role: "employee",
      tags: ["hr", "onboarding"],
      category: "hr",
      profile: {
        jobTitle: "入职专员",
        responsibilities: "引导入职",
        personality: "亲切",
        tone: "温和",
        boundaries: "不审批",
      },
      suggestedSkills: ["hr-general"],
      defaultSkills: ["hr-general"],
      status: "draft",
      source: { type: "builtin", version: "1.0.0" },
      workflowHints: { suggestedWorkflowIds: ["employee-onboarding"], defaultParticipation: "participant" },
    }),
  );

  const list = listAgentTemplates();
  const t = list.find((x) => x.id === "onboarding");
  assert.ok(t, "应读到 onboarding 模板");
  assert.equal(t!.name, "入职专员");
  assert.equal(t!.emoji, "🧭");
  assert.deepEqual(t!.tags, ["hr", "onboarding"]);
  assert.equal(t!.category, "hr");
  assert.equal(t!.status, "draft");
  assert.deepEqual(t!.defaultSkills, ["hr-general"]);
  assert.equal(t!.workflowHints?.defaultParticipation, "participant");
  assert.equal(t!.source?.type, "builtin");
});

test("listAgentTemplates：缺必填字段的模板被跳过，不崩", () => {
  const dir = join(stateDir, "workspaces", "_templates", "agents");
  mkdirSync(join(dir, "broken-template"), { recursive: true });
  writeFileSync(
    join(dir, "broken-template", "template.json"),
    JSON.stringify({ id: "broken", name: "无角色" }), // 缺 role / profile
  );
  const list = listAgentTemplates();
  assert.ok(!list.some((x) => x.id === "broken"));
});

test("listAgentTemplates：defaultSkills 兜底 suggestedSkills", () => {
  const dir = join(stateDir, "workspaces", "_templates", "agents");
  mkdirSync(join(dir, "fallback-skills-template"), { recursive: true });
  writeFileSync(
    join(dir, "fallback-skills-template", "template.json"),
    JSON.stringify({
      id: "fallback-skills",
      name: "兜底技能",
      role: "employee",
      profile: { jobTitle: "x", responsibilities: "x", personality: "x", tone: "x", boundaries: "x" },
      defaultSkills: ["hr-admin"],
    }),
  );
  const t = listAgentTemplates().find((x) => x.id === "fallback-skills");
  assert.ok(t);
  assert.deepEqual(t!.suggestedSkills, ["hr-admin"]);
});

test("listAgentTemplates：目录缺失 → 回退仓库源（hr-employee / hr-admin 内置模板）", () => {
  // 用一个不存在 STATE_DIR 的场景：清空 stateDir 的 templates 目录后另起进程级常量不可行，
  // 这里改为验证仓库源 fallback：临时指向空 STATE_DIR。
  const emptyState = join(tmpdir(), `yomajiahr-templates-empty-${process.pid}`);
  process.env.OPENCLAW_STATE_DIR = emptyState;
  const list = listAgentTemplates();
  // 仓库源里应至少含 hr-employee / hr-admin 两个内置模板文件
  assert.ok(list.length >= 2, `仓库源应含内置模板，实际 ${list.length}`);
  assert.ok(list.some((x) => x.id === "hr-employee"));
  assert.ok(list.some((x) => x.id === "hr-admin"));
  // 新字段在仓库源模板里也应存在
  const emp = list.find((x) => x.id === "hr-employee")!;
  assert.ok(emp.emoji, "hr-employee 模板应有 emoji");
  assert.ok(Array.isArray(emp.tags) && emp.tags.length > 0, "hr-employee 模板应有 tags");
  assert.ok(emp.workflowHints, "hr-employee 模板应有 workflowHints");
});
