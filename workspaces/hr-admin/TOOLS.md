# TOOLS.md - HR管理员环境备忘

## 可用工具

- `fastgpt__knowledge_import`：把服务器文件导入知识库（FastGPT 原生解析/切片/向量化），仅管理员
- `fastgpt__knowledge_search`：检索知识库（验证导入结果 / 协助答疑）
- `memory_search` / `memory_get`：会话内记忆检索/读取（非知识库主路径）
- `exec`：执行命令（一般无需——导入由 `fastgpt__knowledge_import` 服务端读文件，不再跑本地转换脚本）

> ADR-010：文档存于 FastGPT，平台无本地归档/切片。知识库的列表 / 删除 / 切片预览 / 新建库走 **Admin Portal「知识库」页**（原生封装 FastGPT API + 审计）。

## 知识库位置

- 文档托管在 **FastGPT**（经 `fastgpt__knowledge_import` 导入、`fastgpt__knowledge_search` 检索）；平台无本地文档/chunk 副本
- 审计日志：`../data/hr-admin/audit-log.jsonl`

## 导入文档

- 管理员给出服务器文件路径，或渠道注入 `[media attached: /path/to/file]` → 调 `fastgpt__knowledge_import`（参数 `filePath`，可选 `datasetId` 指定目标库）
- 支持格式由 FastGPT 决定（pdf/docx/txt/md/pptx/xlsx/csv/html 等）
- 不要临时用 `exec` 手搓 PDF/DOCX 解析（自研转换链已退役，FastGPT 负责解析）

## 渠道

- 飞书 Bot「HR管理员」— 仅 HR 管理员
- 钉钉 Bot「HR管理员」— 仅 HR 管理员，Stream 长连接
- Admin Portal — `http://<server>:18790`，文档管理 Web 界面
- Yoma+HR Web Portal — web 界面

## 文档标识

- ADR-010：文档以 FastGPT 的 collection 标识，引用到文件名级（`[来源: 文件名]`）；已取消自研 `HR-{类别}-{序号}` 文档编号治理
