import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-orchestrator-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_APPLY_DIRECT = "1";
mkdirSync(join(stateDir, "config-store"), { recursive: true });
mkdirSync(join(stateDir, "skills", "hr-general"), { recursive: true });
writeFileSync(join(stateDir, "skills", "hr-general", "SKILL.md"), "---\nname: hr-general\ndescription: test\n---\n");
writeFileSync(join(stateDir, "config-store", "agents.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "bindings.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "channels.json"), JSON.stringify([]));
writeFileSync(
  join(stateDir, ".env"),
  readFileSync(new URL("../../../config/.env.example", import.meta.url), "utf-8") + "\nEXISTING=value=with=equals\n",
);
const fakeBin = join(stateDir, "test-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeOpenclaw = join(fakeBin, "openclaw");
// 按 OPENCLAW_TEST_PROBE_ACCOUNTS 合并额外账号（ADR-013 #57 拆分后新路径要走 verifyChannel）。
writeFileSync(
  fakeOpenclaw,
  `#!/bin/sh
extra="$OPENCLAW_TEST_PROBE_ACCOUNTS"
node -e '
const extra = (process.env.OPENCLAW_TEST_PROBE_ACCOUNTS || "").split(",").filter(Boolean);
const feishu = [
  { accountId: "integration-agent", configured: true, running: true, probe: { ok: true } },
  { accountId: "attach-rollback-agent", configured: true, running: true, probe: { ok: true } },
  ...extra.map((a) => ({ accountId: a, configured: true, running: true, probe: { ok: true } })),
];
const dingtalk = [{ accountId: "integration-agent", configured: true, running: true, connected: true }];
process.stdout.write(JSON.stringify({ channelAccounts: { feishu, "dingtalk-connector": dingtalk } }) + "\\n");
'`,
);
chmodSync(fakeOpenclaw, 0o755);
const fakeSystemctl = join(fakeBin, "systemctl");
writeFileSync(fakeSystemctl, `#!/bin/sh
[ "$1" = "show" ] && printf '0\\n'
exit 0
`);
chmodSync(fakeSystemctl, 0o755);
const fakeCurl = join(fakeBin, "curl");
writeFileSync(fakeCurl, `#!/bin/sh
printf '200'
`);
chmodSync(fakeCurl, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.PROBE_WINDOW = "1";
process.env.READY_SUSTAIN = "1";

const {
  agentHasKbBinding,
  assembleCreateInput,
  bindAgentToChannel,
  createAgentFromCredentials,
  createAgentProfile,
  deleteAgent,
  getAgentSkillsView,
  knowledgeToolsBlock,
  listAgents,
  rerenderAgentWorkspace,
  unbindAgentFromChannel,
  updateAgent,
  updateAgentProfile,
  updateAgentSkills,
  validateAgentDraft,
} = await import("./orchestrator.js");
const { runtimeEnv } = await import("./secrets.js");
const { writeKnowledgeStore } = await import("./knowledge.js");

const baseDraft = {
  id: "test-agent",
  name: "测试助手",
  role: "employee" as const,
  skills: ["hr-general"],
  domain: "feishu" as const,
};

test("服务端生成飞书渠道配置，store 中只保留占位符", () => {
  const input = assembleCreateInput(baseDraft, { clientId: "cli_secret_id", clientSecret: "plain-secret" });
  assert.equal(input.channels[0].account.appId, "${FEISHU_TEST_AGENT_APP_ID}");
  assert.equal(input.channels[0].account.appSecret, "${FEISHU_TEST_AGENT_APP_SECRET}");
  assert.equal(JSON.stringify(input.channels[0].account).includes("plain-secret"), false);
  assert.equal(input.channels[0].secrets?.FEISHU_TEST_AGENT_APP_SECRET, "plain-secret");
});

test("服务端生成钉钉渠道配置", () => {
  const input = assembleCreateInput(
    { ...baseDraft, domain: "dingtalk-connector" },
    { clientId: "ding-id", clientSecret: "ding-secret" },
  );
  assert.equal(input.channels[0].account.clientId, "${DINGTALK_TEST_AGENT_CLIENT_ID}");
  assert.equal(input.channels[0].account.clientSecret, "${DINGTALK_TEST_AGENT_CLIENT_SECRET}");
});

test("草稿拒绝非法 ID 和未知渠道", () => {
  assert.throws(() => validateAgentDraft({ ...baseDraft, id: "Bad ID" }), /id 只能/);
  assert.throws(() => validateAgentDraft({ ...baseDraft, domain: "unknown" as any }), /渠道非法/);
  assert.throws(() => validateAgentDraft({ ...baseDraft, skills: ["missing-skill"] }), /技能不存在/);
});

test("runtimeEnv 保留等号后的完整值", () => {
  assert.equal(runtimeEnv().EXISTING, "value=with=equals");
});

test("完整成功路径写入 Agent、技能、渠道、binding、密钥并通过 apply/渠道验证", async () => {
  const result = await createAgentFromCredentials(
    {
      id: "integration-agent",
      name: "集成测试助手",
      role: "employee",
      skills: ["hr-general"],
      domain: "feishu",
    },
    { clientId: "cli-integration", clientSecret: "integration-secret" },
  );
  assert.equal(result.apply.status, "success");
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.deepEqual(agents[0].skills, ["hr-general"]);
  assert.equal(channels.find((c: any) => c.id === "integration-agent" && c.type === "feishu").account.appSecret, "${FEISHU_INTEGRATION_AGENT_APP_SECRET}");
  assert.deepEqual(bindings[0], {
    agentId: "integration-agent",
    match: { channel: "feishu", accountId: "integration-agent" },
  });
  assert.match(readFileSync(join(stateDir, ".env"), "utf-8"), /FEISHU_INTEGRATION_AGENT_APP_SECRET=integration-secret/);
});

test("修改数字员工时可同时新增另一渠道，并保留 MEMORY.md", async () => {
  const memoryPath = join(stateDir, "workspaces", "integration-agent", "MEMORY.md");
  writeFileSync(memoryPath, "custom memory\n");
  const result = await updateAgent("integration-agent", {
    name: "更新后的助手",
    role: "admin",
    persona: "负责集成测试",
    skills: ["hr-general"],
    addChannel: {
      domain: "dingtalk-connector",
      credentials: { clientId: "ding-integration", clientSecret: "ding-integration-secret" },
    },
  });
  assert.equal(result.agent.role, "admin");
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(agents[0].name, "更新后的助手");
  assert.equal(agents[0].persona, "负责集成测试");
  // ADR-012：admin agent 仅授予 exec，内置 memory 工具（含 memory_write）退役并入 deny。
  assert.deepEqual(agents[0].tools.allow, ["exec"]);
  assert.ok(agents[0].tools.deny.includes("memory_write"));
  assert.ok(!agents[0].tools.allow.includes("memory_search"));
  assert.match(readFileSync(join(stateDir, "workspaces", "integration-agent", "SOUL.md"), "utf-8"), /负责集成测试/);
  assert.equal(readFileSync(memoryPath, "utf-8"), "custom memory\n");
  assert.equal(
    channels.find((c: any) => c.id === "integration-agent" && c.type === "dingtalk").account.clientId,
    "${DINGTALK_INTEGRATION_AGENT_CLIENT_ID}",
  );
  const runtime = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf-8"));
  assert.equal("persona" in runtime.agents.list[0], false);
  assert.equal(
    bindings.some(
      (b: any) =>
        b.agentId === "integration-agent" &&
        b.match.channel === "dingtalk-connector" &&
        b.match.accountId === "integration-agent",
    ),
    true,
  );
  assert.match(readFileSync(join(stateDir, ".env"), "utf-8"), /DINGTALK_INTEGRATION_AGENT_CLIENT_SECRET=ding-integration-secret/);
  assert.equal(existsSync(join(stateDir, "workspaces", "integration-agent", "CLAUDE.md")), false);
});

test("修改数字员工时可解绑渠道并保留账号与凭据供复用", async () => {
  await updateAgent("integration-agent", {
    name: "更新后的助手",
    role: "admin",
    persona: "负责集成测试",
    skills: ["hr-general"],
    removeChannels: [{ domain: "dingtalk-connector", accountId: "integration-agent" }],
  });
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(
    Boolean(channels.find((c: any) => c.id === "integration-agent" && c.type === "dingtalk")),
    true,
  );
  assert.equal(
    bindings.some((binding: any) => binding.agentId === "integration-agent" && binding.match.channel === "dingtalk-connector"),
    false,
  );
  assert.match(readFileSync(join(stateDir, ".env"), "utf-8"), /DINGTALK_INTEGRATION_AGENT_/);
});

test("修改数字员工时可直接勾选并复用空闲已有账号", async () => {
  await updateAgent("integration-agent", {
    name: "更新后的助手",
    role: "admin",
    persona: "负责集成测试",
    skills: ["hr-general"],
    addChannel: {
      domain: "dingtalk-connector",
      accountId: "integration-agent",
      existing: true,
    },
  });
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(
    bindings.some(
      (binding: any) =>
        binding.agentId === "integration-agent" &&
        binding.match.channel === "dingtalk-connector" &&
        binding.match.accountId === "integration-agent",
    ),
    true,
  );
});

test("内置数字员工可以修改但不能删除", async () => {
  const agentsPath = join(stateDir, "config-store", "agents.json");
  const agents = JSON.parse(readFileSync(agentsPath, "utf-8"));
  agents[0].default = true;
  writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n");
  await updateAgent("integration-agent", { name: "内置员工已更新", role: "employee", skills: ["hr-general"] });
  await assert.rejects(deleteAgent("integration-agent"), /内置数字员工不能删除/);
  const updatedAgents = JSON.parse(readFileSync(agentsPath, "utf-8"));
  updatedAgents[0].default = false;
  writeFileSync(agentsPath, JSON.stringify(updatedAgents, null, 2) + "\n");
});

test("修改时新增渠道失败会恢复渠道、binding 和密钥", async () => {
  await createAgentFromCredentials(
    {
      id: "attach-rollback-agent",
      name: "渠道回滚助手",
      role: "employee",
      skills: ["hr-general"],
      domain: "feishu",
    },
    { clientId: "cli-attach-rollback", clientSecret: "attach-rollback-secret" },
  );
  const envBefore = readFileSync(join(stateDir, ".env"), "utf-8");
  process.env.PROBE_FORCE_FAIL = "1";
  try {
    await assert.rejects(
      updateAgent("attach-rollback-agent", {
        name: "渠道回滚助手",
        role: "employee",
        skills: ["hr-general"],
        addChannel: {
          domain: "dingtalk-connector",
          credentials: { clientId: "ding-rollback", clientSecret: "ding-rollback-secret" },
        },
      }),
      /更新失败/,
    );
  } finally {
    delete process.env.PROBE_FORCE_FAIL;
  }
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(
    Boolean(channels.find((c: any) => c.id === "attach-rollback-agent" && c.type === "dingtalk")),
    false,
  );
  assert.equal(
    bindings.some(
      (b: any) => b.agentId === "attach-rollback-agent" && b.match.channel === "dingtalk-connector",
    ),
    false,
  );
  assert.equal(readFileSync(join(stateDir, ".env"), "utf-8"), envBefore);
  await deleteAgent("attach-rollback-agent");
});

test("删除数字员工释放渠道账号并清理 workspace 和知识库绑定", async () => {
  mkdirSync(join(stateDir, "agents", "integration-agent"), { recursive: true });
  writeFileSync(
    join(stateDir, "config-store", "knowledge.json"),
    JSON.stringify({
      platform: "local",
      knowledgeBases: [{ id: "kb", name: "测试库", provider: "local", boundAgents: ["integration-agent"] }],
    }),
  );
  const result = await deleteAgent("integration-agent");
  assert.equal(result.apply.status, "success");
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  const knowledge = JSON.parse(readFileSync(join(stateDir, "config-store", "knowledge.json"), "utf-8"));
  assert.equal(agents.some((a: any) => a.id === "integration-agent"), false);
  assert.equal(Boolean(channels.find((c: any) => c.id === "integration-agent" && c.type === "feishu")), true);
  assert.equal(bindings.some((b: any) => b.agentId === "integration-agent"), false);
  assert.deepEqual(knowledge.knowledgeBases[0].boundAgents, []);
  assert.match(readFileSync(join(stateDir, ".env"), "utf-8"), /FEISHU_INTEGRATION_AGENT_/);
  assert.match(readFileSync(join(stateDir, ".env"), "utf-8"), /DINGTALK_INTEGRATION_AGENT_/);
  assert.equal(existsSync(join(stateDir, "workspaces", "integration-agent")), false);
  assert.equal(existsSync(join(stateDir, "agents", "integration-agent")), false);
});

test("配置应用失败时恢复 Agent、渠道、binding、密钥和 workspace", async () => {
  const envBefore = readFileSync(join(stateDir, ".env"), "utf-8");
  process.env.PROBE_FORCE_FAIL = "1";
  try {
    await assert.rejects(
      createAgentFromCredentials(
        {
          id: "rollback-agent",
          name: "回滚测试助手",
          role: "employee",
          skills: ["hr-general"],
          domain: "feishu",
        },
        { clientId: "cli-rollback", clientSecret: "rollback-secret" },
      ),
      /上线失败/,
    );
  } finally {
    delete process.env.PROBE_FORCE_FAIL;
  }
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(agents.some((a: any) => a.id === "rollback-agent"), false);
  assert.equal(Boolean(channels.find((c: any) => c.id === "rollback-agent" && c.type === "feishu")), false);
  assert.equal(bindings.some((b: any) => b.agentId === "rollback-agent"), false);
  assert.equal(readFileSync(join(stateDir, ".env"), "utf-8"), envBefore);
  assert.equal(existsSync(join(stateDir, "workspaces", "rollback-agent")), false);
});

// ============================================================================
// ADR-013 #57 拆分：createAgentProfile + bindAgentToChannel + unbind + updateAgentProfile
// ============================================================================

test("createAgentProfile 允许空 skills + 无渠道，listAgents 派生 pendingSkills/pendingChannels", async () => {
  const result = await createAgentProfile({
    id: "profile-only",
    name: "档案员",
    role: "employee",
    profile: { jobTitle: "薪酬顾问", responsibilities: "薪酬答疑", personality: "细致", tone: "温和", boundaries: "不审批" },
  });
  assert.equal(result.agent.id, "profile-only");
  assert.deepEqual(result.agent.skills, []);
  assert.equal(result.agent.profile?.jobTitle, "薪酬顾问");
  // ADR-016 §3：创建 agent 走 runtime-only，不重启 gateway。
  assert.equal(result.apply.mode, "runtime-only");
  assert.equal(result.apply.status, "success");
  // 关键：profile 不在 store 的"运行时字段"列表里（id/role/name/skills/workspace/tools/heartbeat），
  // 但 profile 字段本身保留供 workspace 渲染。
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const stored = agents.find((a: any) => a.id === "profile-only");
  assert.deepEqual(stored.skills, []);
  assert.equal(stored.profile.jobTitle, "薪酬顾问");

  const listed = listAgents().find((a) => a.id === "profile-only")!;
  assert.equal(listed.derived.pendingSkills, true);
  assert.equal(listed.derived.pendingChannels, true);
});

test("createAgentProfile 拒绝空名字 / 重复 ID", async () => {
  await assert.rejects(
    createAgentProfile({ id: "bad", name: "  ", role: "employee" }),
    /name 不能为空/,
  );
  await assert.rejects(
    createAgentProfile({ id: "profile-only", name: "重复", role: "employee" }),
    /agent id 已存在/,
  );
});

test("bindAgentToChannel：新建账号 + 占用检查 + 同 agent 同渠道重复拒绝", async () => {
  // 验证路径要 probe 找到 profile-only，给 fake openclaw 注一个
  process.env.OPENCLAW_TEST_PROBE_ACCOUNTS = "profile-only";
  // 新建渠道
  const bindResult = await bindAgentToChannel({
    agentId: "profile-only",
    domain: "feishu",
    credentials: { clientId: "cli-bind-1", clientSecret: "sec-bind-1" },
  });
  // ADR-016 §3：渠道绑定走 restart。
  assert.equal(bindResult.apply.mode, "restart");
  assert.equal(bindResult.apply.status, "success");
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.ok(bindings.some((b: any) => b.agentId === "profile-only" && b.match.accountId === "profile-only"));

  // 同 agent 同渠道再绑（无论新建还是复用） → 拒绝
  await assert.rejects(
    bindAgentToChannel({
      agentId: "profile-only",
      domain: "feishu",
      credentials: { clientId: "cli-bind-2", clientSecret: "sec-bind-2" },
    }),
    /(已接入该渠道|渠道账号已存在)/,
  );
  await assert.rejects(
    bindAgentToChannel({
      agentId: "profile-only",
      domain: "feishu",
      existing: true,
      accountId: "profile-only",
    }),
    /(已接入该渠道|渠道账号已被)/,
  );

  // listAgents 派生 pendingChannels = false
  const listed = listAgents().find((a) => a.id === "profile-only")!;
  assert.equal(listed.derived.pendingChannels, false);
  assert.equal(listed.channels.length, 1);
});

test("unbindAgentFromChannel 释放 binding 但保留账号与凭证供复用", async () => {
  const channelsBefore = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const envBefore = readFileSync(join(stateDir, ".env"), "utf-8");
  assert.ok(
    channelsBefore.find((c: any) => c.id === "profile-only" && c.type === "feishu"),
    "账号应保留",
  );
  assert.ok(envBefore.includes("FEISHU_PROFILE_ONLY_APP_ID"), "凭据应保留");

  await unbindAgentFromChannel("profile-only", "feishu", "profile-only");

  const channelsAfter = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindingsAfter = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  const envAfter = readFileSync(join(stateDir, ".env"), "utf-8");
  assert.ok(
    channelsAfter.find((c: any) => c.id === "profile-only" && c.type === "feishu"),
    "账号保留为平台资产",
  );
  assert.equal(bindingsAfter.some((b: any) => b.agentId === "profile-only"), false);
  assert.ok(envAfter.includes("FEISHU_PROFILE_ONLY_APP_ID"), "凭据保留供复用");

  const listed = listAgents().find((a) => a.id === "profile-only")!;
  assert.equal(listed.derived.pendingChannels, true);
});

test("updateAgentProfile 只改资料和权限，保留 skills 与 MEMORY.md", async () => {
  const memPath = join(stateDir, "workspaces", "profile-only", "MEMORY.md");
  writeFileSync(memPath, "# 关键记忆\n- 不可丢\n");
  await updateAgentProfile("profile-only", {
    name: "档案员-改名",
    role: "admin",
    profile: { jobTitle: "HR 高级顾问" },
  });
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  const stored = agents.find((a: any) => a.id === "profile-only");
  assert.equal(stored.name, "档案员-改名");
  assert.equal(stored.role, "admin");
  assert.deepEqual(stored.skills, []);
  assert.equal(stored.profile.jobTitle, "HR 高级顾问");
  // MEMORY.md 保留
  assert.equal(readFileSync(memPath, "utf-8"), "# 关键记忆\n- 不可丢\n");
  // 派生状态更新
  const listed = listAgents().find((a) => a.id === "profile-only")!;
  assert.equal(listed.derived.pendingSkills, true);
});

test("knowledgeToolsBlock：未绑库时禁止绕路、不出现 knowledge_search 名字", () => {
  const employeeBlock = knowledgeToolsBlock("employee", false);
  assert.match(employeeBlock, /当前未绑定/);
  assert.match(employeeBlock, /没有/);
  // 关键：未绑库时不能出现 knowledge_search/knowledge_import（避免 AI 据此妄称工具可用）
  assert.equal(employeeBlock.includes("`knowledge_search`"), false);
  assert.equal(employeeBlock.includes("`knowledge_import`"), false);
  // 必含明确禁绕路指令（exec/curl/网络请求）
  assert.match(employeeBlock, /exec|curl|网络请求/);
});

test("knowledgeToolsBlock：admin 绑库后只暴露 knowledge_search/import，不暴露原始 API", () => {
  const block = knowledgeToolsBlock("admin", true);
  assert.match(block, /`knowledge_search`/);
  assert.match(block, /`knowledge_import`/);
  // 普通员工绑库后没有 import
  const employeeBlock = knowledgeToolsBlock("employee", true);
  assert.match(employeeBlock, /`knowledge_search`/);
  assert.equal(employeeBlock.includes("`knowledge_import`"), false);
});

test("rerenderAgentWorkspace：解绑 KB 后 TOOLS.md 不再写有 knowledge_search", async () => {
  // 准备：员工绑库 → workspace 写有 knowledge_search
  await createAgentProfile({
    id: "kb-rebind-agent",
    name: "解绑测试员",
    role: "admin",
    profile: { jobTitle: "测试" },
  });
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [{
      id: "kb-test", name: "test", provider: "fastgpt",
      externalKbId: "ds-x", boundAgents: ["kb-rebind-agent"],
    }],
  });
  rerenderAgentWorkspace("kb-rebind-agent");
  const toolsPathBound = join(stateDir, "workspaces", "kb-rebind-agent", "TOOLS.md");
  const boundContent = readFileSync(toolsPathBound, "utf-8");
  assert.match(boundContent, /`knowledge_search`/);
  assert.match(boundContent, /`knowledge_import`/);

  // 解绑 → workspace 不应再写有 knowledge_search/import 名字
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [{
      id: "kb-test", name: "test", provider: "fastgpt",
      externalKbId: "ds-x", boundAgents: [],
    }],
  });
  rerenderAgentWorkspace("kb-rebind-agent");
  const unboundContent = readFileSync(toolsPathBound, "utf-8");
  // 关键回归点：解绑后 TOOLS.md 不能让 AI 误以为 knowledge_search 可用
  assert.equal(unboundContent.includes("`knowledge_search`"), false);
  assert.equal(unboundContent.includes("`knowledge_import`"), false);
  assert.match(unboundContent, /未绑定/);
  // 必含禁绕路红线
  assert.match(unboundContent, /绝不|禁止/);
  assert.match(unboundContent, /exec|curl|网络请求/);

  await deleteAgent("kb-rebind-agent");
});

test("agentHasKbBinding：仅 provider=fastgpt + externalKbId 非空 + boundAgents 含该 agent 才算已绑", () => {
  // 默认 FASTGPT_KB_ID 兜底（旧部署无 knowledge.json）：测试环境无该 env 变量，应返回 false
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [
      { id: "kb-1", name: "n", provider: "fastgpt", externalKbId: "ds1", boundAgents: ["foo"] },
      { id: "kb-2", name: "n", provider: "fastgpt", externalKbId: "", boundAgents: ["bar"] }, // 空 externalKbId 不算
      { id: "kb-3", name: "n", provider: "local", boundAgents: ["baz"] }, // local 不算
    ],
  });
  assert.equal(agentHasKbBinding("foo"), true);
  assert.equal(agentHasKbBinding("bar"), false);
  assert.equal(agentHasKbBinding("baz"), false);
  assert.equal(agentHasKbBinding("nobody"), false);
});

// ============================================================================
// ADR-015 §3：员工↔技能分配（updateAgentSkills / getAgentSkillsView）
// ============================================================================

function seedSkillFile(name: string, fm: string, body = "# body\n"): void {
  mkdirSync(join(stateDir, "skills", name), { recursive: true });
  writeFileSync(join(stateDir, "skills", name, "SKILL.md"), `---\n${fm}\n---\n${body}`);
}

test("getAgentSkillsView：返回当前技能 + 可分配列表 + unmet", async () => {
  seedSkillFile("admin-only-skill", "name: admin-only-skill\ndescription: x\nrequiredRole: admin");
  seedSkillFile("kb-skill", "name: kb-skill\ndescription: y\nrequiresKnowledge: true");
  await createAgentProfile({
    id: "skills-view-agent",
    name: "技能视图员",
    role: "employee",
    profile: { jobTitle: "助理", responsibilities: "助理", personality: "稳", tone: "和", boundaries: "不越权" },
  });
  const view = getAgentSkillsView("skills-view-agent");
  assert.deepEqual(view.skills, []);
  const names = view.available.map((s) => s.name);
  assert.ok(names.includes("hr-general"));
  assert.ok(names.includes("admin-only-skill"));
  assert.ok(names.includes("kb-skill"));
  // 未分配技能 → 无 unmet
  assert.deepEqual(view.unmet, []);
  await deleteAgent("skills-view-agent");
});

test("updateAgentSkills：分配 hr-general，apply 成功 + workspace 重渲染 + before/after", async () => {
  await createAgentProfile({
    id: "skills-assign-agent",
    name: "分配员",
    role: "employee",
    profile: { jobTitle: "助理", responsibilities: "助理", personality: "稳", tone: "和", boundaries: "不越权" },
  });
  const result = await updateAgentSkills("skills-assign-agent", ["hr-general"]);
  assert.equal(result.apply.status, "success");
  assert.deepEqual(result.before, []);
  assert.deepEqual(result.after, ["hr-general"]);
  // store 落地
  const agents = JSON.parse(readFileSync(join(stateDir, "config-store", "agents.json"), "utf-8"));
  assert.deepEqual(agents.find((a: any) => a.id === "skills-assign-agent").skills, ["hr-general"]);
  // workspace AGENTS.md 重渲染含技能
  const agentsMd = readFileSync(join(stateDir, "workspaces", "skills-assign-agent", "AGENTS.md"), "utf-8");
  assert.match(agentsMd, /- hr-general/);
  await deleteAgent("skills-assign-agent");
});

test("updateAgentSkills：角色不兼容阻断（admin 技能分给 employee）", async () => {
  await createAgentProfile({
    id: "role-compat-agent",
    name: "角色兼容员",
    role: "employee",
    profile: { jobTitle: "助理", responsibilities: "助理", personality: "稳", tone: "和", boundaries: "不越权" },
  });
  await assert.rejects(
    updateAgentSkills("role-compat-agent", ["admin-only-skill"]),
    /要求 admin 角色/,
  );
  // admin 角色员工可分配 admin 技能
  await createAgentProfile({
    id: "role-compat-admin",
    name: "角色兼容管理员",
    role: "admin",
    profile: { jobTitle: "管理员", responsibilities: "管理", personality: "细", tone: "专", boundaries: "守规" },
  });
  const ok = await updateAgentSkills("role-compat-admin", ["admin-only-skill"]);
  assert.deepEqual(ok.after, ["admin-only-skill"]);
  await deleteAgent("role-compat-agent");
  await deleteAgent("role-compat-admin");
});

test("updateAgentSkills：依赖未满足不阻断（requiresKnowledge 未绑库 → unmet 提示）", async () => {
  await createAgentProfile({
    id: "unmet-agent",
    name: "依赖员",
    role: "employee",
    profile: { jobTitle: "助理", responsibilities: "助理", personality: "稳", tone: "和", boundaries: "不越权" },
  });
  // 确保未绑库（测试环境无 FASTGPT_KB_ID / knowledge.json 兜底）
  writeKnowledgeStore({ platform: "fastgpt", knowledgeBases: [] });
  const result = await updateAgentSkills("unmet-agent", ["kb-skill", "hr-general"]);
  assert.equal(result.apply.status, "success");
  assert.deepEqual(result.after, ["kb-skill", "hr-general"]);
  const unmetSkills = result.unmet.map((u) => u.skill);
  assert.ok(unmetSkills.includes("kb-skill"));
  assert.ok(!unmetSkills.includes("hr-general"));
  await deleteAgent("unmet-agent");
});

test("updateAgentSkills：不存在技能阻断 / 空数组允许 / 去重", async () => {
  await createAgentProfile({
    id: "edge-agent",
    name: "边界员",
    role: "employee",
    profile: { jobTitle: "助理", responsibilities: "助理", personality: "稳", tone: "和", boundaries: "不越权" },
  });
  await assert.rejects(updateAgentSkills("edge-agent", ["missing-skill"]), /技能不存在/);
  const cleared = await updateAgentSkills("edge-agent", []);
  assert.deepEqual(cleared.after, []);
  const dedup = await updateAgentSkills("edge-agent", ["hr-general", "hr-general"]);
  assert.deepEqual(dedup.after, ["hr-general"]);
  await assert.rejects(updateAgentSkills("no-such-agent", ["hr-general"]), /agent 不存在/);
  await deleteAgent("edge-agent");
});
