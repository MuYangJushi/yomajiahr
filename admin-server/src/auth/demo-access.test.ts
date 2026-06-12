import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.SESSION_SECRET = "demo-access-test-session-secret";
process.env.PLATFORM_DEMO_ACCESS_CODE = "demo-access-code-at-least-16";
process.env.PLATFORM_DEMO_ACCESS_ROLE = "ops";

const { createApp } = await import("../app.js");
const app = createApp();
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务监听失败");
const baseUrl = `http://127.0.0.1:${address.port}/api`;

test.after(() => server.close());

test("访问码登录不暴露密钥，错误码拒绝，正确码签发 demo session", async () => {
  const providers = await fetch(`${baseUrl}/auth/providers`).then((r) => r.json());
  assert.deepEqual(providers.demo_access_code, { enabled: true, role: "ops" });
  assert.equal(JSON.stringify(providers).includes(process.env.PLATFORM_DEMO_ACCESS_CODE!), false);

  const denied = await fetch(`${baseUrl}/auth/demo/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "wrong-code" }),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/auth/demo/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: process.env.PLATFORM_DEMO_ACCESS_CODE }),
  });
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
