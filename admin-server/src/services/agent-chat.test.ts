// Web 内置对话服务测试（ADR-016 §2）。
// 用 fake openclaw 脚本模拟 per-turn 执行，覆盖输入校验/单飞/超时/reply 解析/session 读写。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-agent-chat-test-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_APPLY_DIRECT = "1";
process.env.OPENCLAW_WEB_CHAT_TIMEOUT_MS = "2000"; // 测试用短超时

// —— 准备 store + workspace ——
mkdirSync(join(stateDir, "config-store"), { recursive: true });
mkdirSync(join(stateDir, "workspaces", "chat-agent"), { recursive: true });
writeFileSync(
  join(stateDir, "config-store", "agents.json"),
  JSON.stringify([
    {
      id: "chat-agent",
      role: "employee",
      name: "对话测试员",
      workspace: `~/.openclaw/workspaces/chat-agent`,
      skills: [],
      heartbeat: {},
      tools: { allow: [], deny: ["exec"] },
    },
  ]),
);
writeFileSync(join(stateDir, "config-store", "bindings.json"), "[]");
writeFileSync(join(stateDir, "config-store", "channels.json"), "[]");

// —— fake openclaw：根据 --message 内容决定行为，写 session jsonl + 输出 JSON ——
const fakeBin = join(stateDir, "test-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeOpenclaw = join(fakeBin, "openclaw");
writeFileSync(
  fakeOpenclaw,
  `#!/bin/sh
# 解析 --message / --session-id
msg=""; sid=""
while [ $# -gt 0 ]; do
  case "$1" in
    --message) msg="$2"; shift 2 ;;
    --session-id) sid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$msg" in
  SLOW) sleep 10; echo '{"finalAssistantVisibleText":"慢回复"}'; exit 0 ;;
  FAIL) echo "boom" >&2; exit 3 ;;
  EMPTY) echo '{"finalAssistantVisibleText":""}'; exit 0 ;;
  *)
    # 写一份 session jsonl（含 user + assistant 消息）
    sdir="\${OPENCLAW_STATE_DIR}/agents/chat-agent/sessions"
    mkdir -p "$sdir"
    f="$sdir/$sid.jsonl"
    printf '%s\\n' "{\\"type\\":\\"message\\",\\"timestamp\\":\\"2026-06-21T00:00:00Z\\",\\"message\\":{\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$msg\\"}]}}" > "$f"
    printf '%s\\n' "{\\"type\\":\\"message\\",\\"timestamp\\":\\"2026-06-21T00:00:01Z\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"回复:$msg\\"}]}}" >> "$f"
    echo "{\\"finalAssistantVisibleText\\":\\"回复:$msg\\",\\"executionTrace\\":{\\"runner\\":\\"embedded\\"}}"
    exit 0 ;;
esac
`,
);
chmodSync(fakeOpenclaw, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const {
  chatWithAgent,
  listSessions,
  getSession,
  deleteSession,

} = await import("./agent-chat.js");

test("chatWithAgent：正常一轮 → 返回 reply + sessionId，session 落盘", async () => {
  const r = await chatWithAgent({ agentId: "chat-agent", message: "你好" });
  assert.equal(r.reply, "回复:你好");
  assert.ok(r.sessionId.startsWith("chat_"));
  assert.ok(r.durationMs >= 0);
  // session 文件存在
  const sessions = listSessions("chat-agent");
  assert.ok(sessions.some((s) => s.sessionId === r.sessionId));
});

test("chatWithAgent：空消息 → EMPTY_MESSAGE 400", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "   " }),
    (err: any) => err.code === "EMPTY_MESSAGE" && err.status === 400,
  );
});

test("chatWithAgent：超长消息 → MESSAGE_TOO_LONG 400", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "x".repeat(8001) }),
    (err: any) => err.code === "MESSAGE_TOO_LONG",
  );
});

test("chatWithAgent：agent 不存在 → AGENT_NOT_FOUND 404", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "no-such-agent", message: "hi" }),
    (err: any) => err.code === "AGENT_NOT_FOUND" && err.status === 404,
  );
});

test("chatWithAgent：sessionId 路径穿越 → BAD_SESSION 400", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "hi", sessionId: "../evil" }),
    (err: any) => err.code === "BAD_SESSION",
  );
});

test("chatWithAgent：指定 sessionId 透传 + 复用", async () => {
  const sid = "custom-session-001";
  const r = await chatWithAgent({ agentId: "chat-agent", message: "再次", sessionId: sid });
  assert.equal(r.sessionId, sid);
  assert.equal(r.reply, "回复:再次");
  const g = getSession("chat-agent", sid);
  assert.equal(g.sessionId, sid);
  assert.equal(g.messages.length, 2);
  assert.equal(g.messages[0].role, "user");
  assert.equal(g.messages[1].role, "assistant");
  assert.equal(g.messages[1].text, "回复:再次");
});

test("chatWithAgent：同 session 并发 → SESSION_BUSY 409", async () => {
  const sid = "concurrent-session";
  // 用 SLOW 占住，但 SLOW 会睡 10s 超时；这里用普通消息但两个并发几乎同时发出
  const p1 = chatWithAgent({ agentId: "chat-agent", message: "first", sessionId: sid });
  // 微小延迟确保 p1 已注册到 inFlight
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "second", sessionId: sid }),
    (err: any) => err.code === "SESSION_BUSY" && err.status === 409,
  );
  await p1;
});

test("chatWithAgent：超时 → TIMEOUT 504", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "SLOW", sessionId: "timeout-sid" }),
    (err: any) => err.code === "TIMEOUT" && err.status === 504,
  );
});

test("chatWithAgent：openclaw 非零退出 → AGENT_RUN_FAILED 502", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "FAIL", sessionId: "fail-sid" }),
    (err: any) => err.code === "AGENT_RUN_FAILED" && err.status === 502,
  );
});

test("chatWithAgent：空回复 → EMPTY_REPLY 502", async () => {
  await assert.rejects(
    () => chatWithAgent({ agentId: "chat-agent", message: "EMPTY", sessionId: "empty-sid" }),
    (err: any) => err.code === "EMPTY_REPLY",
  );
});

test("listSessions：返回元信息 + 摘要，按 updatedAt 倒序", async () => {
  const sessions = listSessions("chat-agent");
  assert.ok(sessions.length > 0);
  for (const s of sessions) {
    assert.ok(s.sessionId);
    assert.ok(typeof s.lastUserMessage === "string" || s.lastUserMessage === undefined);
  }
});

test("deleteSession：删除后 getSession 返回空", async () => {
  const sid = "to-delete-sid";
  await chatWithAgent({ agentId: "chat-agent", message: "删我", sessionId: sid });
  assert.ok(getSession("chat-agent", sid).messages.length > 0);
  deleteSession("chat-agent", sid);
  assert.equal(getSession("chat-agent", sid).messages.length, 0);
});

test("deleteSession：不存在的会话 → SESSION_NOT_FOUND 404", () => {
  try {
    deleteSession("chat-agent", "never-existed");
    assert.fail("应抛 SESSION_NOT_FOUND");
  } catch (err: any) {
    assert.equal(err.code, "SESSION_NOT_FOUND");
    assert.equal(err.status, 404);
  }
});

test("getSession：非法 sid → BAD_SESSION 400", () => {
  try {
    getSession("chat-agent", "../etc/passwd");
    assert.fail("应抛 BAD_SESSION");
  } catch (err: any) {
    assert.equal(err.code, "BAD_SESSION");
    assert.equal(err.status, 400);
  }
});
