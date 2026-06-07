import assert from "node:assert/strict";
import test from "node:test";
import { publicSession, registerDingTalkApplication, registerFeishuApplication } from "./onboarding.js";

test("飞书注册通过官方 SDK 回调二维码并返回服务端凭证", async () => {
  const abort = new AbortController();
  let qr = "";
  let status = "";
  const credentials = await registerFeishuApplication(
    {
      id: "feishu-test",
      name: "飞书测试助手",
      role: "employee",
      skills: ["hr-general"],
      domain: "feishu",
    },
    {
      signal: abort.signal,
      onQRCode(url) { qr = url; },
      onStatus(message) { status = message; },
    },
    (async (options: any) => {
      options.onQRCodeReady({ url: "https://example.test/feishu-qr", expireIn: 600 });
      options.onStatusChange({ status: "slow_down" });
      return { client_id: "cli-test", client_secret: "feishu-secret" };
    }) as any,
  );
  assert.equal(qr, "https://example.test/feishu-qr");
  assert.equal(status, "飞书处理中，请稍候");
  assert.deepEqual(credentials, { clientId: "cli-test", clientSecret: "feishu-secret" });
});

test("钉钉注册严格执行 init → begin → WAITING → SUCCESS", async () => {
  const abort = new AbortController();
  const calls: Array<{ path: string; body: any }> = [];
  const responses = [
    { errcode: 0, nonce: "nonce" },
    {
      errcode: 0,
      device_code: "device",
      verification_uri_complete: "https://example.test/dingtalk-qr",
      expires_in: 600,
      interval: 1,
    },
    { errcode: 0, status: "WAITING" },
    { errcode: 0, status: "SUCCESS", client_id: "ding-test", client_secret: "dingtalk-secret" },
  ];
  let qr = "";
  const credentials = await registerDingTalkApplication(
    {
      signal: abort.signal,
      onQRCode(url) { qr = url; },
    },
    async (path, body) => {
      calls.push({ path, body });
      return responses.shift();
    },
    async () => {},
  );
  assert.equal(qr, "https://example.test/dingtalk-qr");
  assert.deepEqual(calls, [
    { path: "/app/registration/init", body: { source: "openClaw" } },
    { path: "/app/registration/begin", body: { nonce: "nonce" } },
    { path: "/app/registration/poll", body: { device_code: "device" } },
    { path: "/app/registration/poll", body: { device_code: "device" } },
  ]);
  assert.deepEqual(credentials, { clientId: "ding-test", clientSecret: "dingtalk-secret" });
});

test("钉钉注册在 FAIL 时停止并返回失败原因", async () => {
  const responses = [
    { errcode: 0, nonce: "nonce" },
    {
      errcode: 0,
      device_code: "device",
      verification_uri_complete: "https://example.test/dingtalk-qr",
      expires_in: 600,
      interval: 1,
    },
    { errcode: 0, status: "FAIL", fail_reason: "用户拒绝授权" },
  ];
  await assert.rejects(
    registerDingTalkApplication(
      { signal: new AbortController().signal, onQRCode() {} },
      async () => responses.shift(),
      async () => {},
    ),
    /用户拒绝授权/,
  );
  assert.equal(responses.length, 0);
});

test("钉钉注册在 EXPIRED 时标记授权过期", async () => {
  const responses = [
    { errcode: 0, nonce: "nonce" },
    {
      errcode: 0,
      device_code: "device",
      verification_uri_complete: "https://example.test/dingtalk-qr",
      expires_in: 600,
      interval: 1,
    },
    { errcode: 0, status: "EXPIRED" },
  ];
  await assert.rejects(
    registerDingTalkApplication(
      { signal: new AbortController().signal, onQRCode() {} },
      async () => responses.shift(),
      async () => {},
    ),
    (err: any) => err.expired === true && /已过期/.test(err.message),
  );
  assert.equal(responses.length, 0);
});

test("公开会话只返回二维码和流程状态，不包含凭证、草稿或内部结果", () => {
  const response = publicSession({
    id: "session-id",
    owner: "admin",
    draft: {
      id: "agent-id",
      name: "Agent",
      role: "employee",
      skills: ["hr-general"],
      domain: "feishu",
    },
    status: "awaiting_scan",
    qrUrl: "https://example.test/qr",
    expiresAt: 1000,
    createdAt: 0,
    abort: new AbortController(),
    clientSecret: "must-not-leak",
    result: { client_secret: "must-not-leak" },
  } as any);
  const serialized = JSON.stringify(response);
  assert.deepEqual(Object.keys(response).sort(), ["expires_at", "id", "message", "qr_url", "status"]);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("draft"), false);
  assert.equal(serialized.includes("result"), false);
});
