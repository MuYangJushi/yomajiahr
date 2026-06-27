import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.SESSION_SECRET = "demo-direct-login-test-session-secret";
process.env.PLATFORM_DEMO_ACCESS_CODE = "demo-access-code-at-least-16";
process.env.PLATFORM_DEMO_ACCESS_ROLE = "ops";
process.env.PLATFORM_DEMO_DIRECT_LOGIN = "1";

const { createApp } = await import("../app.js");
const app = createApp();
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务监听失败");
const baseUrl = `http://127.0.0.1:${address.port}/api`;

test.after(() => server.close());

test("裸链接直达登录开启后签发 demo session", async () => {
  const providers = await fetch(`${baseUrl}/auth/providers`).then((r) => r.json());
  assert.deepEqual(providers.demo_direct_login, { enabled: true, role: "ops" });
  assert.equal(JSON.stringify(providers).includes(process.env.PLATFORM_DEMO_ACCESS_CODE!), false);

  const accepted = await fetch(`${baseUrl}/auth/demo/direct-login`, { method: "POST" });
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie");
  assert.match(cookie || "", /hr_portal_session=/);

  const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookie || "" } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.match(body.platformUserId, /^demo:/);
  assert.equal(body.name, "比赛访客");
  assert.equal(body.platformRole, "ops");
  assert.equal(body.idp, "demo");
});
