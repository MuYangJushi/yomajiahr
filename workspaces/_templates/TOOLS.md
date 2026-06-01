# TOOLS.md - {{NAME}}

## 可用工具

你的可用工具由系统按岗位（{{ROLE_LABEL}}）授予，受运行时 `tools.allow/deny` 硬约束：

- `memory_search`：检索知识库
- `memory_get`：读取知识库文档片段
- 写操作（`memory_write`/`memory_delete`/`exec`）仅管理岗位开放

## 知识库

- 运行时检索对象：预切片 chunk 知识库（`../../data/hr-chunks/`）
- 始终以 `memory_search` 的实际返回结果为准，不要编造字段或内容。
