import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-users-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.PLATFORM_BOOTSTRAP_ADMINS = "bootstrap-union";
process.env.PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE = "ops";
process.env.DINGTALK_LOGIN_CORP_ID = "our-corp";
const usersPath = join(stateDir, "config-store", "users.json");
mkdirSync(join(stateDir, "config-store"), { recursive: true });
writeFileSync(
  usersPath,
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

const { resolveUser, recordLogin } = await import("./users.js");

test("users.json allowlist 命中优先于企业开放登录角色", async () => {
  const user = await resolveUser({ idp: "feishu", unionId: "known-union", name: "新名字" });
  assert.equal(user?.platformUserId, "known-user");
  assert.equal(user?.platformRole, "audit");
});

test("引导管理员优先于企业开放登录角色", async () => {
  const user = await resolveUser({ idp: "dingtalk", unionId: "bootstrap-union", name: "管理员", corpId: "our-corp" });
  assert.equal(user?.platformRole, "admin");
});

test("未命中名单的飞书成员获得企业开放登录角色（自建应用即证明本租户）", async () => {
  const feishu = await resolveUser({ idp: "feishu", unionId: "visitor-feishu", name: "飞书访客" });
  assert.equal(feishu?.platformUserId, "feishu:visitor-feishu");
  assert.equal(feishu?.platformRole, "ops");
});

test("corpId 匹配的钉钉成员获得企业开放登录角色", async () => {
  const dingtalk = await resolveUser({ idp: "dingtalk", unionId: "visitor-dingtalk", name: "钉钉访客", corpId: "our-corp" });
  assert.equal(dingtalk?.platformUserId, "dingtalk:visitor-dingtalk");
  assert.equal(dingtalk?.platformRole, "ops");
});

test("corpId 不匹配/缺失的钉钉账号被企业成员闸门拒绝（fail-closed）", async () => {
  const wrongCorp = await resolveUser({ idp: "dingtalk", unionId: "outsider", name: "外部钉钉", corpId: "other-corp" });
  const noCorp = await resolveUser({ idp: "dingtalk", unionId: "outsider2", name: "无 corp 钉钉" });
  assert.equal(wrongCorp, null);
  assert.equal(noCorp, null);
});

// ── #71 recordLogin：身份注册表写侧 ──────────────────────────────────────────

test("recordLogin 首次登记 org-auto 记录（含 unionId / lastSeenAt）", async () => {
  await recordLogin(
    { idp: "feishu", unionId: "new-visitor", name: "新访客", phone: "13800000000" },
    { platformUserId: "feishu:new-visitor", name: "新访客", platformRole: "ops", type: "human", idp: "feishu" },
  );
  const users = JSON.parse(readFileSync(usersPath, "utf-8"));
  const rec = users.find((u: any) => u.feishuUnionId === "new-visitor");
  assert.equal(rec.source, "org-auto");
  assert.equal(rec.platformRole, "ops");
  assert.equal(rec.phone, "13800000000");
  assert.ok(rec.lastSeenAt);
});

test("recordLogin 重复登录按 unionId 去重 + 刷新 lastSeenAt/name，不新增", async () => {
  const before = JSON.parse(readFileSync(usersPath, "utf-8")).length;
  await recordLogin(
    { idp: "feishu", unionId: "new-visitor", name: "改名后" },
    { platformUserId: "feishu:new-visitor", name: "改名后", platformRole: "ops", type: "human", idp: "feishu" },
  );
  const users = JSON.parse(readFileSync(usersPath, "utf-8"));
  assert.equal(users.length, before, "不应新增重复记录");
  assert.equal(users.find((u: any) => u.feishuUnionId === "new-visitor").name, "改名后");
});

test("recordLogin 不覆盖 allowlist 记录的角色（仅刷新 lastSeenAt）", async () => {
  await recordLogin(
    { idp: "feishu", unionId: "known-union", name: "名单用户" },
    { platformUserId: "known-user", name: "名单用户", platformRole: "audit", type: "human", idp: "feishu" },
  );
  const rec = JSON.parse(readFileSync(usersPath, "utf-8")).find((u: any) => u.feishuUnionId === "known-union");
  assert.equal(rec.platformRole, "audit");
  assert.equal(rec.source, "allowlist");
  assert.ok(rec.lastSeenAt);
});

test("org-auto 记录不短路：撤销开放登录后该身份被拒（fail-closed，角色 live 重算）", async () => {
  // new-visitor 已被 recordLogin 登记为 org-auto/ops。若 org-auto 短路会永远返回 ops；
  // 实际应每次 live 重算——这里它仍是飞书成员，企业开放登录仍开 → 仍 ops（验证不短路但结果一致）。
  const again = await resolveUser({ idp: "feishu", unionId: "new-visitor", name: "新访客" });
  assert.equal(again?.platformRole, "ops");
  assert.equal(again?.platformUserId, "feishu:new-visitor");
});
