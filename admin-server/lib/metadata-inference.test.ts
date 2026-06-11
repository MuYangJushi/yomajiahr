import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inferDocumentMetadata } from "./metadata-inference.js";

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
  assert.equal(metadata.doc_id, ""); // #43 降级：无显式编号即留空，不再自动生成
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
  assert.equal(metadata.doc_id, ""); // #43 降级：无显式编号即留空，不再自动生成
  assert.equal(metadata.source, "heuristic");
});

void test("classifies performance policy titles as performance before attendance-like body terms", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "performance"), { recursive: true });

  const markdown = `---
title: "个人绩效管理办法_1.3"
source_file: "个人绩效管理办法_1.3.pdf"
source_format: "PDF"
doc_id: ""
version: "1.3"
effective_date: "2024-11-26"
category: ""
---

# 个人绩效管理办法

本办法适用于考核期内已转正的公司正式员工。
本办法覆盖目标制定、绩效考核、绩效反馈和结果应用。
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "个人绩效管理办法_1.3.pdf",
    sourceFormat: "PDF",
    policiesDir,
    stateDir: root,
  });

  assert.equal(metadata.category, "performance");
  assert.equal(metadata.doc_id, ""); // #43 降级：无显式编号即留空，不再自动生成
  assert.equal(metadata.source, "heuristic");
});

void test("keeps performance titles in performance even when body mentions leave and attendance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "performance"), { recursive: true });

  const markdown = `---
title: "绩效考核管理制度"
source_file: "绩效考核管理制度.pdf"
source_format: "PDF"
doc_id: ""
version: ""
effective_date: ""
category: ""
---

# 绩效考核管理制度

绩效考核结果将作为晋升、调薪、培训的重要依据。
员工如请假、加班或存在考勤异常，主管应在绩效沟通中同步说明影响。
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "绩效考核管理制度.pdf",
    sourceFormat: "PDF",
    policiesDir,
    stateDir: root,
  });

  assert.equal(metadata.category, "performance");
  assert.equal(metadata.doc_id, ""); // #43 降级：无显式编号即留空，不再自动生成
  assert.equal(metadata.source, "heuristic");
});

void test("falls back to attendance when title has no strong signal and body is attendance-heavy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "attendance"), { recursive: true });

  const markdown = `---
title: "管理办法"
source_file: "管理办法.pdf"
source_format: "PDF"
doc_id: ""
version: ""
effective_date: ""
category: ""
---

# 管理办法

员工请假、休假、加班、调班和考勤打卡，均按本办法执行。
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "管理办法.pdf",
    sourceFormat: "PDF",
    policiesDir,
    stateDir: root,
  });

  assert.equal(metadata.category, "attendance");
  assert.equal(metadata.doc_id, ""); // #43 降级：无显式编号即留空，不再自动生成
  assert.equal(metadata.source, "heuristic");
});

void test("preserves an explicit doc_id from frontmatter (demotion keeps explicit, drops auto-gen)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-admin-metadata-"));
  const policiesDir = path.join(root, "hr-policies");
  await fs.mkdir(path.join(policiesDir, "attendance"), { recursive: true });

  const markdown = `---
title: "考勤管理办法"
source_file: "考勤管理办法.pdf"
source_format: "PDF"
doc_id: "HR-ATT-007"
version: "2.0"
effective_date: ""
category: "attendance"
---

# 考勤管理办法

员工请假、加班、考勤打卡均按本办法执行。
`;

  const metadata = await inferDocumentMetadata({
    markdown,
    originalName: "考勤管理办法.pdf",
    sourceFormat: "PDF",
    policiesDir,
    stateDir: root,
  });

  // #43：文档自带的正式编号必须保留（降级只砍自动生成，不砍显式声明）。
  assert.equal(metadata.doc_id, "HR-ATT-007");
  assert.equal(metadata.category, "attendance");
});
