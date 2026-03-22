# 管理操作详细规范

## 操作权限矩阵

| 操作             | 工具                | 二次确认             | 审计记录 |
| ---------------- | ------------------- | -------------------- | -------- |
| 上传文档         | memory_write + exec | 否（确认元数据即可） | 是       |
| 更新文档         | memory_write        | 是（展示变更内容）   | 是       |
| 删除文档         | memory_delete       | 是（必须）           | 是       |
| 批量删除（>5份） | memory_delete       | 是（逐一列出）       | 是       |
| 查询文档         | memory_search       | 否                   | 否       |
| 查询审计日志     | memory_search       | 否                   | 否       |

## 上传流程详解

### 步骤 1: 接收文件

管理员可通过以下方式提供文档：

- **Admin Portal 上传（推荐）**：拖拽或选择文件，支持 PDF/Word(docx)/文本
- 提供文件路径（服务器上的文件）
- 飞书消息中直接发送附件（受限于飞书 channel 支持的格式）

### 步骤 2: 文档转换

**方式 A: Admin Portal 自动转换**

通过 Admin Portal 上传时，系统自动调用 `doc-converter.mjs` 完成转换，无需手动操作。

**方式 B: 命令行转换**

```bash
# 使用独立的多格式转换器
node admin-portal/lib/doc-converter.mjs  # 作为库被 server.mjs 调用

# 或使用原有 PDF 专用脚本
node skills/hr-policy-rag/scripts/pdf-to-markdown.mjs <pdf-path> \
  --out-dir memory/hr-policies/ \
  --category <category>
```

支持的格式：PDF (.pdf)、Word (.docx)、文本 (.txt, .md)。

转换完成后检查警告：

- 如有"possible scanned image"警告，通知管理员该页面可能需要 OCR 处理
- 建议管理员核对转换后的文本准确性

### 步骤 3: 元数据补充

转换后的 Markdown 文件需要补充以下 frontmatter 字段：

- `doc_id`：文档编号（HR 管理员提供）
- `version`：版本号（HR 管理员提供）
- `effective_date`：生效日期（HR 管理员提供）

### 步骤 4: 写入知识库

使用 `memory_write` 将完整的 Markdown 文件写入对应分类目录。

### 步骤 5: 验证

写入后立即使用 `memory_search` 搜索该文档编号，确认索引成功。

## 审计日志格式

审计日志存储在 `memory/hr-admin/audit-log.jsonl`，JSONL 格式追加写入（每行一条 JSON 记录）：

```json
{"timestamp":"2026-03-22T14:30:00.000Z","action":"UPLOAD","file":"annual-leave-policy.md","details":{"doc_id":"HR-LEAVE-001","version":"2.1","category":"leave","source_format":"PDF"}}
{"timestamp":"2026-03-22T15:00:00.000Z","action":"UPDATE","file":"annual-leave-policy.md","details":{"doc_id":"HR-LEAVE-001","version":"2.2","category":"leave"}}
{"timestamp":"2026-03-22T16:00:00.000Z","action":"DELETE","file":"old-policy.md","details":{"doc_id":"HR-OLD-001","version":"1.0","category":"leave","reason":"版本替换"}}
```

**查看方式：**

- **Admin Portal**（推荐）：`http://<server>:18790/#audit-log`，支持筛选、分页、CSV 导出
- **对话查询**：通过飞书 Bot 或 Web Portal 向 Admin Agent 提问

## 分类管理

### 预定义分类

| 分类名       | 说明     | 目录                             |
| ------------ | -------- | -------------------------------- |
| leave        | 假期制度 | memory/hr-policies/leave/        |
| onboarding   | 入离职   | memory/hr-policies/onboarding/   |
| attendance   | 考勤制度 | memory/hr-policies/attendance/   |
| compensation | 薪酬福利 | memory/hr-policies/compensation/ |
| training     | 培训制度 | memory/hr-policies/training/     |
| general      | 通用制度 | memory/hr-policies/general/      |

### 新增分类

管理员可自定义新分类，Agent 自动创建对应子目录。

## 版本管理规范

- 新文档从 1.0 开始
- 小修改递增小版本（1.0 → 1.1）
- 重大修订递增大版本（1.x → 2.0）
- 废止旧版时记录废止原因和替代文档编号
- 同一文档编号的新旧版本不共存：上传新版前应删除旧版
