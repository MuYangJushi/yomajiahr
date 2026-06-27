import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLikelyCorruptFilename, resolveImportFilename, titleFromDocumentText } from "./import-filename.js";

const BAD_DOCX = "ä_ªäººå_å_è_å_ï¼_IDPï¼_ç_ç_æ_å¼---eae8cf8c-ad33-41f7-9a15-ad9d9c3277c2.docx";

test("isLikelyCorruptFilename：识别飞书 media pipeline 的不可逆乱码文件名", () => {
  assert.equal(isLikelyCorruptFilename(BAD_DOCX), true);
  assert.equal(isLikelyCorruptFilename("个人发展计划（IDP）管理指引.docx"), false);
  assert.equal(isLikelyCorruptFilename("résumé_2026.docx"), false);
});

test("resolveImportFilename：坏名优先按 workspace inbound 同内容副本恢复正确中文名", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "import-filename-"));
  const inbound = join(stateDir, "workspaces", "hr-admin", "media", "inbound");
  mkdirSync(inbound, { recursive: true });
  const body = Buffer.from("same-content");
  writeFileSync(join(inbound, "个人发展计划（IDP）管理指引-1782579155766.docx"), body);

  const resolved = await resolveImportFilename({
    filePath: join(stateDir, "media", "inbound", BAD_DOCX),
    fileBuffer: body,
    agentId: "hr-admin",
    stateDir,
  });

  assert.equal(resolved.source, "workspace-hash");
  assert.equal(resolved.filename, "个人发展计划（IDP）管理指引.docx");
});

test("resolveImportFilename：坏名且无 workspace 副本时不返回乱码，走友好占位兜底", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "import-filename-"));
  const resolved = await resolveImportFilename({
    filePath: join(stateDir, "media", "inbound", BAD_DOCX.replace(/\.docx$/, ".pdf")),
    fileBuffer: Buffer.from("not-a-pdf"),
    agentId: "hr-admin",
    stateDir,
    now: new Date("2026-06-27T17:30:00.000Z"),
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.filename, "渠道导入文档-20260627-173000Z.pdf");
});

test("titleFromDocumentText：从 HR 知识库文档首行提取标题", () => {
  assert.equal(
    titleFromDocumentText("个人发展计划（IDP）管理指引 HR 知识库文档 | 文档编号：SYN-IDP-001\n正文"),
    "个人发展计划（IDP）管理指引",
  );
});
