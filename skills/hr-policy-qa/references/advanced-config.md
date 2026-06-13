# 知识库结构与导入规范（ADR-010）

> 历史说明：本文件原描述自研「源文档 `hr-policies/` + 预切片 `hr-chunks/` + frontmatter `doc_id`/`version` + `memory_search`」体系。该体系已被 **ADR-010** 整体退役。

## 现状

- **知识库托管在 FastGPT**：文档以原始文件直传 FastGPT 由其解析、切片、向量化（`collection/create/localFile`）。平台**不再**本地转换、预切片或归档 Markdown。
- **检索**：员工侧 `hr-policy-qa` 经 `fastgpt__knowledge_search`（FastGPT 唯一知识源，无本地 `memory_search` 回退）。FastGPT 不可用时如实告知不可用、不编造。
- **引用**：到文件名级 `[来源: {文件名}]`。已取消自研 `HR-XXX` 文档编号与版本治理（FastGPT 文件导入不携带这些元数据）。
- **数据分级**：受限内容（薪酬/绩效）在回答层拦截不变；受限**库**（KB 级 `restricted` 标记）的管理页内容仅 admin 可见。

## 导入 / 管理

- 导入与文档管理见 [hr-admin skill](../../hr-admin/SKILL.md) 与 [admin-operations.md](../../hr-admin/references/admin-operations.md)：聊天经 `fastgpt__knowledge_import`，web 经 Admin Portal「知识库」页（列表/切片预览/删除/新建库 + 审计）。

## 相关决策

- ADR-006（引入 FastGPT）、ADR-008/009/010（知识库集成形态演进 → 原生解析导入 + 弃本地回退）。
