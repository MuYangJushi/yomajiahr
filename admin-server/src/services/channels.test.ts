// 渠道账号删除路径单测（fix/channel-delete）。
// 覆盖：① 空闲账号删除成功（store + .env 同步清理）；② 不存在账号拒绝；③ 已绑定账号拒绝 CHANNEL_IN_USE。
// 复用 orchestrator.test.ts 的 fake-bin + OPENCLAW_APPLY_DIRECT=1 + 真实 stateDir 套路，
// 让 mutateChannels 内的 triggerApply 走 direct 模式快速完成（PROBE_WINDOW/READY_SUSTAIN=1）。
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-channels-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_APPLY_DIRECT = "1";
mkdirSync(join(stateDir, "config-store"), { recursive: true });
mkdirSync(join(stateDir, "skills", "hr-general"), { recursive: true });
writeFileSync(join(stateDir, "skills", "hr-general", "SKILL.md"), "---\nname: hr-general\ndescription: test\n---\n");
writeFileSync(join(stateDir, "config-store", "agents.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "bindings.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "channels.json"), "[]\n");
writeFileSync(
  join(stateDir, ".env"),
  readFileSync(new URL("../../../config/.env.example", import.meta.url), "utf-8") + "\n",
);

const fakeBin = join(stateDir, "test-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeOpenclaw = join(fakeBin, "openclaw");
writeFileSync(
  fakeOpenclaw,
  `#!/bin/sh
node -e 'process.stdout.write(JSON.stringify({ channelAccounts: { feishu: [], "dingtalk-connector": [] } }) + "\\n")'`,
);
chmodSync(fakeOpenclaw, 0o755);
const fakeSystemctl = join(fakeBin, "systemctl");
writeFileSync(fakeSystemctl, `#!/bin/sh\n[ "$1" = "show" ] && printf '0\\n'\nexit 0\n`);
chmodSync(fakeSystemctl, 0o755);
const fakeCurl = join(fakeBin, "curl");
writeFileSync(fakeCurl, `#!/bin/sh\nprintf '200'\n`);
chmodSync(fakeCurl, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.PROBE_WINDOW = "1";
process.env.READY_SUSTAIN = "1";

const { createChannelAsset, deleteChannelAsset } = await import("./channels.js");

const channelsFile = () => JSON.parse(readFileSync(join(stateDir, "config-store", "channels.json"), "utf-8"));

test("deleteChannelAsset：空闲账号删除成功并清理凭证", async () => {
  await createChannelAsset({
    id: "del-test", type: "feishu", displayName: "删除测试",
    clientId: "cli-del-1", secret: "sec-del-1",
  });
  assert.ok(channelsFile().some((c: any) => c.id === "del-test"));
  assert.ok(readFileSync(join(stateDir, ".env"), "utf-8").includes("FEISHU_DEL_TEST_APP_ID"));

  await deleteChannelAsset("feishu", "del-test");

  assert.ok(!channelsFile().some((c: any) => c.id === "del-test"), "账号应已从 channels.json 移除");
  assert.ok(
    !readFileSync(join(stateDir, ".env"), "utf-8").includes("FEISHU_DEL_TEST_APP_ID"),
    "对应 envKeys 应已从 .env 移除",
  );
});

test("deleteChannelAsset：不存在账号拒绝", async () => {
  await assert.rejects(deleteChannelAsset("feishu", "no-such-id"), /账号不存在/);
});

test("deleteChannelAsset：已绑定账号拒绝 CHANNEL_IN_USE", async () => {
  await createChannelAsset({
    id: "in-use", type: "feishu", displayName: "占用中",
    clientId: "cli-use-1", secret: "sec-use-1",
  });
  // 手写一条指向该账号的 binding 模拟「已绑定」。
  const bindingsPath = join(stateDir, "config-store", "bindings.json");
  writeFileSync(bindingsPath, JSON.stringify([{ agentId: "any-agent", match: { channel: "feishu", accountId: "in-use" } }]));
  await assert.rejects(deleteChannelAsset("feishu", "in-use"), /CHANNEL_IN_USE/);
  // 拒绝删除时账号应保留（回滚）。
  assert.ok(channelsFile().some((c: any) => c.id === "in-use"), "被占用账号应保留");
});
