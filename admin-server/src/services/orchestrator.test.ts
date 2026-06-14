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
writeFileSync(join(stateDir, "config-store", "channels.json"), JSON.stringify({ feishu: {}, "dingtalk-connector": {} }));
writeFileSync(
  join(stateDir, ".env"),
  readFileSync(new URL("../../../config/.env.example", import.meta.url), "utf-8") + "\nEXISTING=value=with=equals\n",
);
const fakeBin = join(stateDir, "test-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeOpenclaw = join(fakeBin, "openclaw");
writeFileSync(fakeOpenclaw, `#!/bin/sh
printf '%s\\n' '{"channelAccounts":{"feishu":[{"accountId":"integration-agent","configured":true,"running":true,"probe":{"ok":true}},{"accountId":"attach-rollback-agent","configured":true,"running":true,"probe":{"ok":true}}],"dingtalk-connector":[{"accountId":"integration-agent","configured":true,"running":true,"connected":true}]}}'
`);
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
  assembleCreateInput,
  createAgentFromCredentials,
  deleteAgent,
  updateAgent,
  validateAgentDraft,
} = await import("./orchestrator.js");
const { runtimeEnv } = await import("./secrets.js");

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
  assert.equal(channels.feishu["integration-agent"].appSecret, "${FEISHU_INTEGRATION_AGENT_APP_SECRET}");
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
  assert.equal(channels["dingtalk-connector"]["integration-agent"].clientId, "${DINGTALK_INTEGRATION_AGENT_CLIENT_ID}");
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

test("修改数字员工时可解绑渠道并清理独占账号与凭据", async () => {
  await updateAgent("integration-agent", {
    name: "更新后的助手",
    role: "admin",
    persona: "负责集成测试",
    skills: ["hr-general"],
    removeChannels: [{ domain: "dingtalk-connector", accountId: "integration-agent" }],
  });
  const channels = JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));
  const bindings = JSON.parse(readFileSync(join(stateDir, "config-store", "bindings.json"), "utf-8"));
  assert.equal(Boolean(channels["dingtalk-connector"]["integration-agent"]), false);
  assert.equal(
    bindings.some((binding: any) => binding.agentId === "integration-agent" && binding.match.channel === "dingtalk-connector"),
    false,
  );
  assert.doesNotMatch(readFileSync(join(stateDir, ".env"), "utf-8"), /DINGTALK_INTEGRATION_AGENT_/);
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
  assert.equal(Boolean(channels["dingtalk-connector"]["attach-rollback-agent"]), false);
  assert.equal(
    bindings.some(
      (b: any) => b.agentId === "attach-rollback-agent" && b.match.channel === "dingtalk-connector",
    ),
    false,
  );
  assert.equal(readFileSync(join(stateDir, ".env"), "utf-8"), envBefore);
  await deleteAgent("attach-rollback-agent");
});

test("删除数字员工清理独占渠道、密钥、workspace 和知识库绑定", async () => {
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
  assert.equal(Boolean(channels.feishu["integration-agent"]), false);
  assert.equal(bindings.some((b: any) => b.agentId === "integration-agent"), false);
  assert.deepEqual(knowledge.knowledgeBases[0].boundAgents, []);
  assert.doesNotMatch(readFileSync(join(stateDir, ".env"), "utf-8"), /FEISHU_INTEGRATION_AGENT_/);
  assert.doesNotMatch(readFileSync(join(stateDir, ".env"), "utf-8"), /DINGTALK_INTEGRATION_AGENT_/);
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
  assert.equal(Boolean(channels.feishu["rollback-agent"]), false);
  assert.equal(bindings.some((b: any) => b.agentId === "rollback-agent"), false);
  assert.equal(readFileSync(join(stateDir, ".env"), "utf-8"), envBefore);
  assert.equal(existsSync(join(stateDir, "workspaces", "rollback-agent")), false);
});
