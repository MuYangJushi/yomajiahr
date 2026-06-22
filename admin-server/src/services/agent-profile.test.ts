// agent-profile 服务单测（ADR-013 #59+#60）。mock globalThis.fetch 拦截 MiniMax。
import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAgentProfile,
  type ProfileGenerateInput,
} from "./agent-profile.js";

function setFetchMock(impl: (url: string, init?: any) => Promise<Response> | Response) {
  (globalThis as any).fetch = (url: string, init?: any) => Promise.resolve(impl(url, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("generateAgentProfile 入参校验：空 jobTitle", async () => {
  await assert.rejects(
    generateAgentProfile({ jobTitle: "  " } as ProfileGenerateInput),
    /jobTitle 不能为空/,
  );
});

test("generateAgentProfile 缺 MINIMAX_API_KEY", async () => {
  const orig = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  try {
    await assert.rejects(generateAgentProfile({ jobTitle: "薪酬顾问" }), /MINIMAX_API_KEY 未配置/);
  } finally {
    if (orig) process.env.MINIMAX_API_KEY = orig;
  }
});

test("generateAgentProfile 正常返回 → 5 字段齐 + 长度截断", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  const long = "x".repeat(800);
  setFetchMock((_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "MiniMax-Text-01");
    assert.equal(body.system.includes("Yoma 数字员工档案共创助手"), true);
    return jsonResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            jobTitle: "薪酬顾问",
            responsibilities: long, // 触发 400 字符截断
            personality: "细致, 耐心, 专业, 严谨, 守秘",
            tone: "简洁、就事论事",
            boundaries: "不替代 HR 完成人工审批",
          }),
        },
      ],
    });
  });
  const out = await generateAgentProfile({ jobTitle: "薪酬顾问" });
  assert.equal(out.jobTitle, "薪酬顾问");
  assert.equal(out.responsibilities.length, 400);
  assert.equal(out.personality.length <= 120, true);
  assert.equal(out.tone.length <= 80, true);
  assert.equal(out.boundaries.length <= 200, true);
});

test("generateAgentProfile 容错：模型返回 markdown 围栏", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() =>
    jsonResponse({
      content: [
        {
          type: "text",
          text: "```json\n{\"jobTitle\":\"入离职专员\",\"responsibilities\":\"接待、答疑、跟进\",\"personality\":\"耐心\",\"tone\":\"温和\",\"boundaries\":\"不审批\"}\n```",
        },
      ],
    }),
  );
  const out = await generateAgentProfile({ jobTitle: "入离职专员" });
  assert.equal(out.jobTitle, "入离职专员");
  assert.equal(out.boundaries, "不审批");
});

test("generateAgentProfile 缺字段 → 抛可读错误", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() =>
    jsonResponse({
      content: [{ type: "text", text: JSON.stringify({ jobTitle: "x", personality: "y" }) }],
    }),
  );
  await assert.rejects(generateAgentProfile({ jobTitle: "x" }), /缺字段/);
});

test("generateAgentProfile HTTP 502 → 抛可读错误", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() => jsonResponse({ error: "rate limit" }, 429));
  await assert.rejects(generateAgentProfile({ jobTitle: "x" }), /MiniMax HTTP 429/);
});
