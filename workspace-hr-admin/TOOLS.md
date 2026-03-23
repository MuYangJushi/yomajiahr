# TOOLS.md - HR管理后台环境备忘

## 可用工具

- `memory_search`：搜索知识库（验证文档、定位文档）
- `memory_get`：读取知识库文档内容
- `memory_write`：写入/更新知识库文档
- `memory_delete`：删除知识库文档
- `exec`：执行命令（文档格式转换等）

## 知识库位置

- 政策文档：`../data/hr-policies/`
- 分类目录：leave / onboarding / attendance / compensation / training / general
- 审计日志：`../data/hr-admin/audit-log.jsonl`

## 文档转换工具

- Admin Portal 内置转换：`admin-portal/lib/doc-converter.mjs`
- CLI 转换脚本：`scripts/doc-to-markdown.mjs`
- 支持格式：PDF (.pdf) / Word (.docx) / 文本 (.txt, .md)

## 渠道

- 飞书 Bot「HR管理后台」— 仅 HR 管理员
- Admin Portal — `http://<server>:18790`，文档管理 Web 界面
- Yoma+HR Web Portal — web 界面

## 文档编号规范

- 格式：`HR-{CATEGORY}-{SEQ}`
- 示例：HR-LEAVE-001、HR-ATT-003、HR-COMP-010
- 分类缩写：LEAVE / ATT / COMP / TRAIN / ONBOARD / GEN
