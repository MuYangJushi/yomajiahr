import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-orchestrator-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
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
printf '%s\\n' '{"channelAccounts":{"feishu":[{"accountId":"integration-agent","configured":true,"running":true,"probe":{"ok":true}}]}}'
`);
chmodSync(fakeOpenclaw, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { assembleCreateInput, createAgentFromCredentials, validateAgentDraft } = await import("./orchestrator.js");
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
