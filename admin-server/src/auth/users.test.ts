import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-users-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.PLATFORM_BOOTSTRAP_ADMINS = "bootstrap-union";
process.env.PLATFORM_DEMO_OPEN_LOGIN_ROLE = "ops";
mkdirSync(join(stateDir, "config-store"), { recursive: true });
writeFileSync(
  join(stateDir, "config-store", "users.json"),
  JSON.stringify([
    {
      platformUserId: "known-user",
      name: "名单用户",
      platformRole: "audit",
      feishuUnionId: "known-union",
      source: "allowlist",
    },
  ]),
);

const { resolveUser } = await import("./users.js");

test("users.json 命中优先于比赛展示临时角色", () => {
  const user = resolveUser({ idp: "feishu", unionId: "known-union", name: "新名字" });
  assert.equal(user?.platformUserId, "known-user");
  assert.equal(user?.platformRole, "audit");
});

test("引导管理员优先于比赛展示临时角色", () => {
  const user = resolveUser({ idp: "dingtalk", unionId: "bootstrap-union", name: "管理员" });
  assert.equal(user?.platformRole, "admin");
});

test("未命中名单的飞书或钉钉账号获得比赛展示临时角色", () => {
  const feishu = resolveUser({ idp: "feishu", unionId: "visitor-feishu", name: "飞书访客" });
  const dingtalk = resolveUser({ idp: "dingtalk", unionId: "visitor-dingtalk", name: "钉钉访客" });
  assert.equal(feishu?.platformUserId, "feishu:visitor-feishu");
  assert.equal(feishu?.platformRole, "ops");
  assert.equal(dingtalk?.platformUserId, "dingtalk:visitor-dingtalk");
  assert.equal(dingtalk?.platformRole, "ops");
});
