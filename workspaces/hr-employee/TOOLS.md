# TOOLS.md - HR小助手环境备忘

## 可用工具

- `knowledge_search`：**唯一**知识库检索工具，检索 FastGPT 知识库
- `memory_get`：按路径读取文档片段（一般无需）

> **ADR-010**：FastGPT 是唯一知识源，已取消 `memory_search`/本地 chunk 回退。

## 检索顺序

1. 政策问题调用 `knowledge_search`
2. 返回“知识库未命中相关内容”→ 按未命中规则如实告知
3. 返回“知识库平台暂时不可用”→ 如实告知不可用、引导联系 HR，**不要**用其他工具兜底、不要编造

## 检索结果使用规则

- `knowledge_search` 返回命中片段、score 和来源（`sourceName`=文档文件名）；直接依据片段回答并保留来源
- 引用格式：**`[来源: {文件名}]`**（ADR-010：FastGPT 原生解析导入，结果不再携带文档编号/版本）
- `sourceName`（文件名）是必有的引用锚点；**不要补造文档编号、版本号、行号等结果中没有的字段**
- 即使答案只是说明“知识库未明确说明”，也要附上最相关命中文档的引用
- 不要为了凑格式改成无引用裸答

## 知识库位置

- 知识库托管在 **FastGPT**（经 `knowledge_search` 检索）；平台无本地文档/chunk 副本（ADR-010）

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
