# 管理操作详细规范（ADR-010）

> ADR-010：文档交 FastGPT 原生解析/存储，平台不再本地转换/切片/归档。导入经 `fastgpt__knowledge_import`（聊天）或 Admin Portal（web）直传 FastGPT；列表/删除/切片预览/新建库走 Admin Portal「知识库」页。

## 操作权限矩阵

| 操作 | 入口 / 工具 | 二次确认 | 审计记录 |
| --- | --- | --- | --- |
| 导入文档（聊天） | `fastgpt__knowledge_import` | 否（确认目标库即可） | 是（IMPORT）|
| 导入文档（web） | Admin Portal 知识库页 | 否 | 是（IMPORT）|
| 列表 / 切片预览 | Admin Portal 知识库页 | 否 | 否 |
| 删除文档 | Admin Portal 知识库页 | 是（必须） | 是（DELETE）|
| 新建知识库 | Admin Portal 知识库页 | 否 | 是（CREATE_KB）|
| 检索（验证/答疑） | `fastgpt__knowledge_search` | 否 | 否 |

## 导入流程（聊天）

### 步骤 1: 接收文件

- 管理员提供**服务器上的文件绝对路径**，或渠道把附件注入成 `[media attached: /path/to/file]`
- web 侧则在 Admin Portal 知识库页拖拽上传

### 步骤 2: 调用 `fastgpt__knowledge_import`

- 参数：`filePath`（服务器文件绝对路径，必填）、`datasetId`（目标库，省略=默认库）
- 工具把**原始文件**直传 FastGPT，由 FastGPT 解析/切片/向量化（平台不再本地转换，**不要**用 `exec` 手搓 PDF/DOCX 解析）
- 支持格式由 FastGPT 决定（pdf/docx/txt/md/pptx/xlsx/csv/html 等）

### 步骤 3: 反馈与验证

- 成功返回 collectionId；FastGPT 后台切片/向量化，索引状态在知识库页可见
- 可用 `fastgpt__knowledge_search` 检索验证；或让管理员在知识库页看「文档管理」列表
- 导入失败如实告知（无本地兜底，ADR-010），不要谎称已导入

> 「更新文档」= 在 Admin Portal 删除旧 collection + 重新导入（FastGPT 按 collection 管理，无原地改内容）。不再有自研 `doc_id`/`version` 编号治理；引用到文件名级。

## 审计日志格式

存储在 `../data/hr-admin/audit-log.jsonl`，JSONL 追加（每行一条）：

```json
{"timestamp":"2026-06-13T14:30:00.000Z","action":"IMPORT","file":"overtime-policy.pdf","details":{"status":"success","platform":"fastgpt","collectionId":"...","kbId":"...","via":"chat","operator":{"id":"hr-admin","name":"hr-admin"}}}
{"timestamp":"2026-06-13T16:00:00.000Z","action":"DELETE","file":"old-policy.pdf","details":{"collectionId":"...","kbId":"...","operator":{...}}}
{"timestamp":"2026-06-13T17:00:00.000Z","action":"CREATE_KB","file":"kb_...","details":{"name":"薪酬库","externalKbId":"...","operator":{...}}}
```

查看：Admin Portal 审计页（筛选/分页/CSV 导出）或聊天查询。

## 知识库与受限

- 文档托管在 FastGPT 知识库（dataset）；多库由 Admin Portal「知识库」页管理（列表/新建库/绑定数字员工）
- **受限库**（薪酬/绩效等）：在新建库时勾选「受限库」，其文档列表与切片预览仅 `admin` 可见（员工召回侧由 hr-policy-qa 回答层数据分级拦截）
- 导入到哪个库由 `datasetId` 指定；省略则默认库
