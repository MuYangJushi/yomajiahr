# TOOLS.md - HR管理员环境备忘

## 可用工具

- `knowledge_import`：把服务器文件导入知识库（FastGPT 原生解析/切片/向量化），仅管理员
- `knowledge_search`：检索知识库（验证导入结果 / 协助答疑）
- `exec`：执行命令（一般无需——导入由 `knowledge_import` 服务端读文件，不再跑本地转换脚本）

> ADR-010：文档存于 FastGPT，平台无本地归档/切片。知识库的列表 / 删除 / 切片预览 / 新建库走 **Admin Portal「知识库」页**（原生封装 FastGPT API + 审计）。

## 知识库位置

- 文档托管在 **FastGPT**（经 `knowledge_import` 导入、`knowledge_search` 检索）；平台无本地文档/chunk 副本
- 审计日志：`../data/hr-admin/audit-log.jsonl`

## 导入文档

- 管理员给出服务器文件路径，或渠道注入 `[media attached: /path/to/file]` → 调 `knowledge_import`（参数 `filePath`，可选 `datasetId` 指定目标库）
- 支持格式由 FastGPT 决定（pdf/docx/txt/md/pptx/xlsx/csv/html 等）
- 不要临时用 `exec` 手搓 PDF/DOCX 解析（自研转换链已退役，FastGPT 负责解析）

## 渠道

- 飞书 Bot「HR管理员」— 仅 HR 管理员
- 钉钉 Bot「HR管理员」— 仅 HR 管理员，Stream 长连接
- Admin Portal — `http://<server>:18790`，文档管理 Web 界面
- Yoma+HR Web Portal — web 界面

## 文档标识

- ADR-010：文档以 FastGPT 的 collection 标识，引用到文件名级（`[来源: 文件名]`）；已取消自研 `HR-{类别}-{序号}` 文档编号治理

## 红线（系统锁定）

- **绝不**用 `exec` 自己探测知识库 API（FastGPT 或其他平台）—— 不要 `curl /api/v1/knowledge/search` / `curl /api/dataset/...` 之类绕路尝试。**知识检索只能用 `knowledge_search`，导入只能用 `knowledge_import`**。
- 这两个工具不在 allowlist 时（解绑后会消失）：如实告知"当前未绑定知识库，无法检索/导入"，不要绕路、不要试别的端点。
- 工具调用返回错误（FastGPT 不可达、404、500 等）：如实告知具体错误，不要换端点重试、不要切别的工具凑答案。
- `exec` 仅用于文件清单等本地辅助操作，**不得**用作 HTTP 客户端去摸知识库后端。
