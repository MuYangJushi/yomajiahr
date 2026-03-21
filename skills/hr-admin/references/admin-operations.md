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

管理员可通过以下方式提供 PDF：

- 飞书消息中直接发送 PDF 附件
- 提供文件路径（服务器上的 PDF 文件）
- 提供文件 URL（需下载后处理）

### 步骤 2: PDF 转换

调用转换脚本：

```bash
node skills/hr-policy-rag/scripts/pdf-to-markdown.mjs <pdf-path> \
  --out-dir memory/hr-policies/ \
  --category <category>
```

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

审计日志存储在 `memory/hr-admin/audit-log.md`，追加写入：

```markdown
## 操作记录

| 时间             | 操作   | 文件                   | 文档编号          | 操作人 | 备注       |
| ---------------- | ------ | ---------------------- | ----------------- | ------ | ---------- |
| 2026-03-22 14:30 | UPLOAD | annual-leave-policy.md | HR-LEAVE-001 v2.1 | admin  | 新增       |
| 2026-03-22 15:00 | UPDATE | annual-leave-policy.md | HR-LEAVE-001 v2.2 | admin  | 更新第三条 |
| 2026-03-22 16:00 | DELETE | old-policy.md          | HR-OLD-001 v1.0   | admin  | 版本替换   |
```

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
