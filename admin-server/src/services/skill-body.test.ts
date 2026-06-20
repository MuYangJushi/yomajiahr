// skill-body 服务单测（design 重做技能编辑加 AI → 落地）。mock globalThis.fetch 拦截 MiniMax。
import assert from "node:assert/strict";
import test from "node:test";
import { generateSkillBody } from "./skill-body.js";

function setFetchMock(impl: (url: string, init?: any) => Promise<Response> | Response) {
  (globalThis as any).fetch = (url: string, init?: any) => Promise.resolve(impl(url, init));
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("generateSkillBody 入参校验：空 name", async () => {
  await assert.rejects(generateSkillBody({ name: "  " }), /name 不能为空/);
});

test("generateSkillBody 缺 MINIMAX_API_KEY", async () => {
  const orig = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  try {
    await assert.rejects(generateSkillBody({ name: "hr-policy-qa" }), /MINIMAX_API_KEY 未配置/);
  } finally {
    if (orig) process.env.MINIMAX_API_KEY = orig;
  }
});

test("generateSkillBody 正常返回 Markdown 正文 + 透传技能 ID/描述", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock((_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "MiniMax-Text-01");
    assert.equal(body.system.includes("技能"), true);
    assert.equal(body.messages[0].content.includes("hr-policy-qa"), true);
    assert.equal(body.messages[0].content.includes("考勤问答"), true);
    return jsonResponse({ content: [{ type: "text", text: "# HR 政策问答\n\n## 触发\n政策问题触发。" }] });
  });
  const out = await generateSkillBody({ name: "hr-policy-qa", hints: "考勤问答" });
  assert.equal(out.startsWith("# HR 政策问答"), true);
  assert.equal(out.includes("## 触发"), true);
});

test("generateSkillBody 容错：去 markdown 围栏，保留正文换行", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() => jsonResponse({ content: [{ type: "text", text: "```markdown\n# 标题\n正文\n```" }] }));
  const out = await generateSkillBody({ name: "x" });
  assert.equal(out, "# 标题\n正文");
});

test("generateSkillBody 空输出 → 抛可读错误", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() => jsonResponse({ content: [{ type: "text", text: "   " }] }));
  await assert.rejects(generateSkillBody({ name: "x" }), /模型输出为空/);
});

test("generateSkillBody HTTP 429 → 抛可读错误", async () => {
  process.env.MINIMAX_API_KEY = "sk-test";
  setFetchMock(() => jsonResponse({ error: "rate limit" }, 429));
  await assert.rejects(generateSkillBody({ name: "x" }), /MiniMax HTTP 429/);
});
