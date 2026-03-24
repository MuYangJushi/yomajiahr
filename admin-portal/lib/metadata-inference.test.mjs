import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inferDocumentMetadata } from "./metadata-inference.mjs";

void test("classifies handbook-style documents as general before leave keywords", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "general"), { recursive: true });

  const markdown = `---
title: "上海江波龙存储技术有限公司员工手册（2025年版）"
source_file: "上海江波龙存储技术有限公司员工手册（2025年版）.docx"
source_format: "Word (docx)"
doc_id: ""
version: ""
effective_date: ""
category: ""
---

# 上海江波龙存储技术有限公司员工手册（2025年版）

二、HR相关
1、考勤休假
2、请假
3、福利
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "上海江波龙存储技术有限公司员工手册（2025年版）.docx",
    sourceFormat: "Word (docx)",
    policiesDir,
    stateDir: root,
  });

  assert.equal(metadata.category, "general");
  assert.equal(metadata.doc_id, "HR-GEN-001");
  assert.equal(metadata.source, "heuristic");
});

void test("classifies orientation guides as general before compensation keywords", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "general"), { recursive: true });

  const markdown = `---
title: "新员工须知"
source_file: "新员工须知.pdf"
source_format: "PDF"
doc_id: ""
version: ""
effective_date: ""
category: ""
---

# 新员工须知

1、OA 系统
2、考勤休假
3、我的薪酬
4、福利
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "新员工须知.pdf",
    sourceFormat: "PDF",
    policiesDir,
    stateDir: root,
  });

  assert.equal(metadata.category, "general");
  assert.equal(metadata.doc_id, "HR-GEN-001");
  assert.equal(metadata.source, "heuristic");
});
