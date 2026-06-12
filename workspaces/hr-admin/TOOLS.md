# TOOLS.md - HR管理员环境备忘

## 可用工具

- `memory_search`：搜索知识库（验证文档、定位文档）
- `memory_get`：读取知识库文档内容
- `memory_write`：写入/更新知识库文档
- `memory_delete`：删除知识库文档
- `exec`：执行命令（文档格式转换等）

## 知识库位置

- 政策文档：`../data/hr-policies/`
- 分类目录：attendance / staffing / compensation / training / performance / general
- 审计日志：`../data/hr-admin/audit-log.jsonl`

## 文档转换工具

- 对话链路统一优先：`skills/hr-admin/scripts/doc-to-markdown.mjs`
- Admin Portal 内置转换：`admin-server/lib/doc-converter.mjs`
- 支持格式：PDF (.pdf) / Word (.docx) / 文本 (.txt, .md)
- 如果消息中出现 `[media attached: /path/to/file]`，优先直接拿这个服务器路径调用脚本
- 不要临时改用手搓 PDF / DOCX 解析，除非脚本不可用

## 渠道

- 飞书 Bot「HR管理员」— 仅 HR 管理员
- 钉钉 Bot「HR管理员」— 仅 HR 管理员，Stream 长连接
- Admin Portal — `http://<server>:18790`，文档管理 Web 界面
- Yoma+HR Web Portal — web 界面

## 文档编号规范

- 格式：`HR-{CATEGORY}-{SEQ}`
- 示例：HR-ATT-001、HR-STAFF-001、HR-PERF-001、HR-COMP-010
- 分类缩写：ATT / STAFF / COMP / TRAIN / PERF / GEN
