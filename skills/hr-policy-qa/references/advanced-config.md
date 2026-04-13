# Memory Search 高级配置

## 当前运行态

当前 `hr-policy-qa` 在运行时直接检索的是预切片目录：

```text
../../data/hr-chunks/
```

该目录与源文档目录使用相同的分类结构：

- `attendance`
- `staffing`
- `compensation`
- `training`
- `performance`
- `general`

`memory_search` 命中的通常是 chunk 级 Markdown 文件，而不是 `hr-policies/` 下的整篇源文档。

## 知识库目录结构

源文档仍保存在以下目录：

```
../data/hr-policies/
├── attendance/         # 考勤与请假制度
│   └── *.md
├── staffing/           # 人员配置/入离职
│   └── *.md
├── compensation/       # 薪酬福利（受限级）
├── training/           # 培训制度
├── performance/        # 绩效管理
└── general/            # 通用制度
```

这些源文档会被转换并切片后，同步到运行时检索目录 `../../data/hr-chunks/`。

## 文档格式规范

每份文档必须包含 YAML frontmatter：

```yaml
---
title: "文档标题"
source_file: "原始文件名.pdf"
doc_id: "HR-ATT-001" # 文档编号，格式: HR-{类别}-{序号}
version: "2.1" # 版本号
effective_date: "2025-01-01" # 生效日期
category: "attendance" # 分类名
total_pages: 3 # 原始 PDF 页数
---
```

## 文档编号规范

| 前缀      | 分类           | 示例          |
| --------- | -------------- | ------------- |
| HR-ATT    | 考勤与请假制度 | HR-ATT-001    |
| HR-STAFF  | 人员配置/入离职 | HR-STAFF-001 |
| HR-COMP   | 薪酬福利       | HR-COMP-001   |
| HR-TRAIN  | 培训制度       | HR-TRAIN-001  |
| HR-PERF   | 绩效管理       | HR-PERF-001   |
| HR-GEN    | 通用制度       | HR-GEN-001    |

## 搜索策略

### 关键词提取

从用户问题中提取搜索关键词：

1. 移除停用词（的、了、吗、呢、是、有、在）
2. 识别政策术语（年假、病假、社保、公积金等）
3. 识别文档编号模式（HR-XXXX-NNN）

### 搜索优先级

1. 将文档编号作为高优先级检索关键词
2. 标题关键词匹配
3. 正文语义检索

说明：

- 这是检索建议，不是运行时硬保证
- 最终回答必须以 `memory_search` 的实际返回结果为准
- 不要假设文档编号检索一定只返回单个结果

### 结果数量

- 默认优先查看最相关的前几条 chunk 结果
- 是否只返回单条结果，取决于实际 `memory_search` 返回，不要在 skill 中写成硬保证

## 知识库导入边界

政策问答 Agent 只负责检索已经建好索引的知识库内容，不负责导入或写入文档。

- 源文档目录：`../data/hr-policies/`
- 运行时检索目录：`../../data/hr-chunks/`

如需导入新文档，请改走 `hr-admin` / `admin-portal`：

- 推荐：通过 `admin-portal` 上传 PDF、Word、文本并自动转换为 Markdown
- 命令行：使用 `skills/hr-admin/scripts/doc-to-markdown.mjs` 处理 PDF、Word、文本并自动分析元数据
