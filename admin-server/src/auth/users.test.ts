import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-users-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.PLATFORM_BOOTSTRAP_ADMINS = "bootstrap-union";
process.env.PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE = "ops";
process.env.DINGTALK_LOGIN_CORP_ID = "our-corp";
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

test("users.json 命中优先于企业开放登录角色", () => {
  const user = resolveUser({ idp: "feishu", unionId: "known-union", name: "新名字" });
  assert.equal(user?.platformUserId, "known-user");
  assert.equal(user?.platformRole, "audit");
});

test("引导管理员优先于企业开放登录角色", () => {
  const user = resolveUser({ idp: "dingtalk", unionId: "bootstrap-union", name: "管理员", corpId: "our-corp" });
  assert.equal(user?.platformRole, "admin");
});

test("未命中名单的飞书成员获得企业开放登录角色（自建应用即证明本租户）", () => {
  const feishu = resolveUser({ idp: "feishu", unionId: "visitor-feishu", name: "飞书访客" });
  assert.equal(feishu?.platformUserId, "feishu:visitor-feishu");
  assert.equal(feishu?.platformRole, "ops");
});

test("corpId 匹配的钉钉成员获得企业开放登录角色", () => {
  const dingtalk = resolveUser({ idp: "dingtalk", unionId: "visitor-dingtalk", name: "钉钉访客", corpId: "our-corp" });
  assert.equal(dingtalk?.platformUserId, "dingtalk:visitor-dingtalk");
  assert.equal(dingtalk?.platformRole, "ops");
});

test("corpId 不匹配/缺失的钉钉账号被企业成员闸门拒绝（fail-closed）", () => {
  const wrongCorp = resolveUser({ idp: "dingtalk", unionId: "outsider", name: "外部钉钉", corpId: "other-corp" });
  const noCorp = resolveUser({ idp: "dingtalk", unionId: "outsider2", name: "无 corp 钉钉" });
  assert.equal(wrongCorp, null);
  assert.equal(noCorp, null);
});
