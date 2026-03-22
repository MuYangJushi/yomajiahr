# Memory Search 高级配置

## 知识库目录结构

```
memory/hr-policies/
├── leave/              # 假期制度
│   ├── annual-leave-policy.md
│   └── sick-leave-policy.md
├── onboarding/         # 入离职
│   └── probation-policy.md
├── attendance/         # 考勤制度
├── compensation/       # 薪酬福利（受限级）
├── training/           # 培训制度
└── general/            # 通用制度
```

## 文档格式规范

每份文档必须包含 YAML frontmatter：

```yaml
---
title: "文档标题"
source_file: "原始文件名.pdf"
doc_id: "HR-LEAVE-001" # 文档编号，格式: HR-{类别}-{序号}
version: "2.1" # 版本号
effective_date: "2025-01-01" # 生效日期
category: "leave" # 分类名
total_pages: 3 # 原始 PDF 页数
---
```

## 文档编号规范

| 前缀       | 分类     | 示例           |
| ---------- | -------- | -------------- |
| HR-LEAVE   | 假期制度 | HR-LEAVE-001   |
| HR-ONBOARD | 入离职   | HR-ONBOARD-001 |
| HR-ATT     | 考勤制度 | HR-ATT-001     |
| HR-COMP    | 薪酬福利 | HR-COMP-001    |
| HR-TRAIN   | 培训制度 | HR-TRAIN-001   |
| HR-WORK    | 工作制度 | HR-WORK-001    |
| HR-GEN     | 通用制度 | HR-GEN-001     |

## 搜索策略

### 关键词提取

从用户问题中提取搜索关键词：

1. 移除停用词（的、了、吗、呢、是、有、在）
2. 识别政策术语（年假、病假、社保、公积金等）
3. 识别文档编号模式（HR-XXXX-NNN）

### 搜索优先级

1. 文档编号精确匹配（最高优先）
2. 标题关键词匹配
3. 正文全文搜索

### 结果数量

- 默认返回 top 3 相关文档
- 文档编号精确匹配时仅返回该文档

## 知识库导入边界

政策问答 Agent 只负责检索 `memory/hr-policies/` 中已经存在的 Markdown 知识库，不负责导入或写入文档。

如需导入新文档，请改走 `hr-admin` / `admin-portal`：

- 推荐：通过 `admin-portal` 上传 PDF、Word、文本并自动转换为 Markdown
- 命令行：使用 `skills/hr-admin/scripts/pdf-to-markdown.mjs` 处理 PDF，再由管理员补充元数据并写入知识库
