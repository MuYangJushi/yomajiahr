import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceRegistry, appendCitation, decideRewrite, extractSources, hasCitation } from "./lib.js";

const LONG = "根据公司考勤管理办法，员工忘记打卡应在异常发生后五个自然日内在星澜人事系统提交补签卡申请，并说明忘记打卡的原因；每名员工每月最多可提交三次补签卡申请，超过时限或次数的原则上不予补签，确有特殊原因的由部门负责人和 HR 审核处理。";

test("extractSources：解析检索结果中的来源并去重保序", () => {
  const text = "#1（score 0.7）...[来源: 考勤管理办法.docx]\n#2（score 0.6）...[来源: 新员工须知.docx]\n#3 ...[来源: 考勤管理办法.docx]";
  assert.deepEqual(extractSources(text), ["考勤管理办法.docx", "新员工须知.docx"]);
  assert.deepEqual(extractSources(null), []);
});

test("hasCitation / appendCitation 格式正确", () => {
  assert.equal(hasCitation("答案...\n[来源: 考勤管理办法.docx]"), true);
  assert.equal(hasCitation("参考《考勤管理办法》答案..."), false);
  const out = appendCitation("答案  \n", ["a.docx", "b.pdf"]);
  assert.equal(out, "答案\n\n[来源: a.docx]\n[来源: b.pdf]");
});

test("decideRewrite：缺引用且有登记 → 追加并清除（只补一次）", () => {
  const reg = new SourceRegistry();
  reg.add("run1", ["考勤管理办法.docx"]);
  const out = decideRewrite(reg, ["run1"], LONG);
  assert.ok(out && out.endsWith("[来源: 考勤管理办法.docx]"));
  assert.equal(decideRewrite(reg, ["run1"], LONG), null); // 第二段不重复补
});

test("decideRewrite：已有规范引用 → 不干预且清除登记", () => {
  const reg = new SourceRegistry();
  reg.add("run2", ["a.docx"]);
  assert.equal(decideRewrite(reg, ["run2"], LONG + "\n[来源: a.docx]"), null);
  assert.equal(reg.has("run2"), false);
});

test("decideRewrite：短消息 / 无登记 / 非字符串 → 不干预", () => {
  const reg = new SourceRegistry();
  reg.add("run3", ["a.docx"]);
  assert.equal(decideRewrite(reg, ["run3"], "好的，正在为您查询"), null);
  assert.equal(reg.has("run3"), true); // 短消息不消耗登记
  assert.equal(decideRewrite(reg, ["nope"], LONG), null);
  assert.equal(decideRewrite(reg, ["run3"], undefined), null);
});

test("decideRewrite：runId 优先，sessionKey 兜底", () => {
  const reg = new SourceRegistry();
  reg.add("sess-1", ["b.pdf"]);
  const out = decideRewrite(reg, [undefined, "sess-1"].filter(Boolean), LONG);
  assert.ok(out && out.includes("[来源: b.pdf]"));
});

test("SourceRegistry：TTL 过期清理", () => {
  let now = 0;
  const reg = new SourceRegistry(() => now);
  reg.add("old", ["a.docx"]);
  now = 11 * 60 * 1000;
  reg.add("new", ["b.pdf"]); // 触发惰性清扫
  assert.equal(reg.has("old"), false);
  assert.equal(reg.has("new"), true);
});
