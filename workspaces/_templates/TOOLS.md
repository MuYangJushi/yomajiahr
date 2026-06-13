# TOOLS.md - {{NAME}}

## 可用工具

你的可用工具由系统按岗位（{{ROLE_LABEL}}）授予，受运行时 `tools.allow/deny` 硬约束。HR 知识库经 FastGPT MCP 工具访问（ADR-010）：

- `fastgpt__knowledge_search`：检索 HR 知识库（FastGPT）
- `fastgpt__knowledge_import`：导入文档到知识库（仅管理岗位）
- `memory_search`/`memory_get`：会话内记忆检索/读取（非知识库主路径）

## 知识库

- 文档托管在 **FastGPT**；平台无本地归档/chunk 副本（ADR-010）。始终以 `fastgpt__knowledge_search` 的实际返回为准，不编造字段或内容。
