// ADR-015 技能可编辑化（CRUD）单测：listSkills 透出新 frontmatter、create/update/delete、
// 删除被引用时拒绝（SKILL_IN_USE）、不触发 apply（纯文件 I/O）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-skills-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
mkdirSync(join(stateDir, "config-store"), { recursive: true });
mkdirSync(join(stateDir, "skills"), { recursive: true });
writeFileSync(join(stateDir, "config-store", "agents.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "bindings.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "channels.json"), "[]\n");

const {
  SKILL_NAME_RE,
  createSkill,
  updateSkill,
  deleteSkill,
  getSkill,
  listSkills,
  listSkillMetas,
  agentsUsingSkill,
} = await import("./skills.js");

function seedSkill(name: string, fm: string, body = "# body\n"): void {
  mkdirSync(join(stateDir, "skills", name), { recursive: true });
  writeFileSync(join(stateDir, "skills", name, "SKILL.md"), `---\n${fm}\n---\n${body}`);
}

test("SKILL_NAME_RE 拒绝大写/空/非法首字符", () => {
  assert.ok(SKILL_NAME_RE.test("hr-policy-qa"));
  assert.ok(SKILL_NAME_RE.test("a1_b"));
  assert.ok(!SKILL_NAME_RE.test("Hr"));
  assert.ok(!SKILL_NAME_RE.test(""));
  assert.ok(!SKILL_NAME_RE.test("-bad"));
  assert.ok(!SKILL_NAME_RE.test("has space"));
});

test("listSkills 透出 requiredRole / requiresKnowledge，并按 name 排序", () => {
  seedSkill("z-last", "name: z-last\ndescription: z");
  seedSkill("a-first", "name: a-first\ndescription: a");
  seedSkill("hr-admin", "name: hr-admin\ndescription: admin\nrequiredRole: admin");
  seedSkill("hr-policy-qa", "name: hr-policy-qa\ndescription: qa\nrequiresKnowledge: true");
  const list = listSkills();
  const names = list.map((s) => s.name);
  assert.deepEqual(names, [...names].sort());
  const admin = list.find((s) => s.name === "hr-admin")!;
  assert.equal(admin.requiredRole, "admin");
  assert.ok(!admin.requiresKnowledge);
  const qa = list.find((s) => s.name === "hr-policy-qa")!;
  assert.equal(qa.requiresKnowledge, true);
  assert.ok(!qa.requiredRole);
  // body 也在 listSkills 里（路由 listSkillMetas 才裁掉）
  assert.ok(qa.body.includes("# body"));
  // 非法 requiredRole 值不透出
  seedSkill("bad-role", "name: bad-role\ndescription: x\nrequiredRole: superuser");
  assert.equal(listSkills().find((s) => s.name === "bad-role")!.requiredRole, undefined);
});

test("listSkillMetas 不含 body", () => {
  const metas = listSkillMetas();
  assert.ok(metas.every((m) => !("body" in m)));
});

test("createSkill 写 SKILL.md，拒绝重名与非法 ID", () => {
  const skill = createSkill({ name: "new-skill", description: "a new skill", requiredRole: "employee", body: "# hello\n" });
  assert.equal(skill.name, "new-skill");
  assert.equal(skill.requiredRole, "employee");
  assert.ok(existsSync(join(stateDir, "skills", "new-skill", "SKILL.md")));
  const raw = readFileSync(join(stateDir, "skills", "new-skill", "SKILL.md"), "utf-8");
  assert.match(raw, /^name: new-skill$/m);
  assert.match(raw, /^description: a new skill$/m);
  assert.match(raw, /^requiredRole: employee$/m);
  assert.ok(!/requiresKnowledge/.test(raw), "未声明 requiresKnowledge 时不应写出该行");
  // 重名
  assert.throws(() => createSkill({ name: "new-skill", description: "dup" }), /已存在/);
  // 非法 ID
  assert.throws(() => createSkill({ name: "Bad ID", description: "x" }), /非法/);
  // 空 description
  assert.throws(() => createSkill({ name: "no-desc", description: "   " }), /description/);
});

test("updateSkill 改 description/requiredRole/requiresKnowledge/body，name 不可改", () => {
  createSkill({ name: "edit-me", description: "orig", body: "orig body" });
  const updated = updateSkill("edit-me", {
    description: "changed",
    requiredRole: "admin",
    requiresKnowledge: true,
    body: "# new body\n",
  });
  assert.equal(updated.description, "changed");
  assert.equal(updated.requiredRole, "admin");
  assert.equal(updated.requiresKnowledge, true);
  assert.ok(updated.body.includes("# new body"));
  // 仅传 body：其余字段保留
  const onlyBody = updateSkill("edit-me", { body: "# only body changed\n" });
  assert.equal(onlyBody.description, "changed");
  assert.equal(onlyBody.requiredRole, "admin");
  // requiredRole 传 null 清空
  const cleared = updateSkill("edit-me", { requiredRole: null });
  assert.equal(cleared.requiredRole, undefined);
  // 不存在
  assert.throws(() => updateSkill("nope", { description: "x" }), /不存在/);
});

test("deleteSkill 被引用时拒绝 SKILL_IN_USE，无引用时删目录", () => {
  createSkill({ name: "deletable", description: "d" });
  deleteSkill("deletable");
  assert.ok(!existsSync(join(stateDir, "skills", "deletable")));
  assert.throws(() => deleteSkill("deletable"), /不存在/);
});

test("agentsUsingSkill 读 store.agents[].skills", () => {
  // 直接写 store 制造引用
  writeFileSync(
    join(stateDir, "config-store", "agents.json"),
    JSON.stringify([{ id: "agent-x", role: "employee", skills: ["hr-policy-qa"], workspace: "~/.openclaw/workspaces/agent-x" }]),
  );
  assert.deepEqual(agentsUsingSkill("hr-policy-qa"), ["agent-x"]);
  assert.deepEqual(agentsUsingSkill("hr-admin"), []);
  // 被引用的技能删除应抛 SKILL_IN_USE
  let caught: Error & { referencedBy?: string[] } | undefined;
  try {
    deleteSkill("hr-policy-qa");
  } catch (err) {
    caught = err as Error & { referencedBy?: string[] };
  }
  assert.ok(caught);
  assert.match(caught!.message, /SKILL_IN_USE/);
  assert.deepEqual(caught!.referencedBy, ["agent-x"]);
  // 清理 store
  writeFileSync(join(stateDir, "config-store", "agents.json"), "[]\n");
});
