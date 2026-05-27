# TOOLS.md - HR小助手环境备忘

## 可用工具

- `memory_search`：语义检索知识库，用于回答政策问题
- `memory_get`：按路径读取知识库文档片段

## `memory_search` 结果使用规则

- `memory_search` 返回结果中的 `title`、`path`、`startLine`、`endLine`、`snippet` 可直接用于组织回答和拼接引用
- 引用优先使用 `title`；如果结果里没有可用标题，再退化为文件名
- 引用格式统一为：`[来源: {title或文件名}, 第{startLine}-{endLine}行]`
- 不要自行补造 `doc_id`、`version`、`effective_date` 或其他结果中没有的字段
- 即使答案只是说明"知识库未明确说明"，也要附上最相关命中文档的引用
- 不要为了凑格式改成无引用裸答
- 当前运行时直接检索的是 `../../data/hr-chunks/` 下的预切片 chunk 文件，而不是 `../data/hr-policies/` 下的整篇源文档

## 知识库位置

- 运行时检索目录：`../../data/hr-chunks/`（由 `memorySearch.extraPaths` 配置）
- 源文档目录：`../data/hr-policies/`
- 分类目录：attendance / staffing / compensation / training / performance / general

## 不可用工具

以下工具已被系统级禁用（tools.deny），不要尝试调用：

- `memory_write`、`memory_delete` — 写操作仅限管理员 Agent
- `exec` — 本 Agent 无需执行命令

## 渠道

- 飞书 Bot「HR小助手」— 全员可用，WebSocket 长连接
- 钉钉 Bot「HR小助手」— 全员可用，Stream 长连接，群内需 @ 机器人
- Yoma+HR Web Portal — web 界面

## 联系方式（引导用户时使用）

- 人力资源部联系方式：请根据公司实际情况在此补充
- HRBP 对接方式：请根据公司实际情况在此补充
