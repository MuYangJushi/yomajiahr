import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { normalizeUploadedFilename } from "./util.js";

test("normalizeUploadedFilename：飞书/钉钉附件 latin1 mojibake 还原为中文（fix/qa-fixes）", () => {
  const real = "个人发展计划（IDP）综合管理---98c10c6f-5029-46ce-a9fb-4259995173e5.docx";
  // openclaw 落地附件后 Node 读到的 basename：UTF-8 字节被当 latin1 解读成的 mojibake。
  const mojibake = Buffer.from(real, "utf8").toString("latin1");
  assert.notEqual(mojibake, real, "前置：mojibake 应不同于原名");
  assert.equal(normalizeUploadedFilename(mojibake), real);
});

test("normalizeUploadedFilename：已是正确中文名不被破坏", () => {
  const name = "星澜云谷科技有限公司-任职资格管理制度及实施方案（通用版）.docx";
  assert.equal(normalizeUploadedFilename(name), name);
});

test("normalizeUploadedFilename：纯 ASCII 名保持不变", () => {
  assert.equal(normalizeUploadedFilename("policy-v1.2.pdf"), "policy-v1.2.pdf");
});

test("normalizeUploadedFilename：剥目录、空名兜底", () => {
  assert.equal(normalizeUploadedFilename("/tmp/uploads/report.docx"), "report.docx");
  assert.equal(normalizeUploadedFilename("C:\\\\docs\\\\手册.pdf"), "手册.pdf");
  assert.equal(normalizeUploadedFilename(""), "upload.bin");
});
