# Yoma+HR 智能助手 — 架构设计文档

## 一、背景与目标

基于 OpenClaw 构建企业 HR 智能助手（Yoma+HR），覆盖政策问答、招聘、入离职、数据分析、排班考勤五大业务模块。

当前采用 **Plan A（纯 Agent + Skills）** 架构：

- 员工侧：单 Agent + 多 Skill，不使用 Sub-agent
- 管理侧：独立 Agent，硬权限隔离

---

## 二、架构概览

```
飞书 Bot 1 "HR小助手" ──binding──> hr-assistant（单 Agent）
    Skills: [hr-policy-qa, hr-general]
    Tools: memory_search, memory_get
    Tools Deny: memory_write, memory_delete, exec
    memorySearch: DashScope embedding (text-embedding-v4)

飞书 Bot 4 "HR管理后台" ──binding──> hr-admin（独立 Agent）
    Skills: [hr-admin]
    Tools: memory_search, memory_write, memory_delete, exec

Admin Portal（独立 Express 服务，端口 18790）
    直接文件系统操作，不经过 Agent
```

### 为什么选 Plan A

之前采用 B+C 混合架构（Sub-agent 编排器 + 独立管理 Bot）在实际运行中暴露三个问题：

1. **Sub-agent 上下文传递 bug**：`sessions_spawn` 导致多用户会话间上下文泄漏
2. **OpenClaw 源码修改**：为支持 Sub-agent 改了 gateway 和 memory-tool 源码，无法跟进上游
3. **延迟**：Agent→Sub-agent 转发增加 2-5 秒响应延迟

Plan A 通过 Skills 隔离领域行为，在同一 Agent 内完成检索和回答，消除以上问题。

---

## 三、Agent 详解

### hr-assistant（员工入口）

**定位**：全员可用的 HR 对话窗口，绑定飞书 Bot 1。

**Skill 分工**：

| Skill          | 触发条件                            | 功能                                      |
| -------------- | ----------------------------------- | ----------------------------------------- |
| `hr-policy-qa` | 政策/制度/假期/考勤/福利/社保类问题 | 调用 memory_search 检索知识库，附引用回答 |
| `hr-general`   | 操作类请求、未上线功能、闲聊        | 占位回复、拦截非 HR 话题                  |

**工具权限**：

| 工具            | 权限 | 说明               |
| --------------- | ---- | ------------------ |
| `memory_search` | 允许 | 检索政策知识库     |
| `memory_get`    | 允许 | 读取知识库文档片段 |
| `memory_write`  | 禁止 | 员工不能修改知识库 |
| `memory_delete` | 禁止 | 员工不能删除知识库 |
| `exec`          | 禁止 | 员工不能执行脚本   |

**Embedding 配置**：

- Provider: 阿里百炼 DashScope（OpenAI-compatible）
- Model: `text-embedding-v4`
- 知识库路径: `../data/hr-policies`（相对于 workspace）

### hr-admin（管理入口）

**定位**：仅 HR 管理员可用，绑定飞书 Bot 4。拥有知识库写权限。

**管理入口**：

| 入口                 | 适用场景                               |
| -------------------- | -------------------------------------- |
| Admin Portal（推荐） | 拖拽上传文档、可视化文档管理、审计日志 |
| 飞书 Bot 4           | 快捷对话式操作                         |
| Web Portal           | 与飞书 Bot 功能相同                    |

**工具权限**：全部允许（memory_search, memory_write, memory_delete, exec）

---

## 四、权限隔离模型

```
                    ┌──────────────────────┐
                    │    政策知识库         │
                    │ data/hr-policies/    │
                    └──────┬───────┬───────┘
                           │       │
                    read   │       │ read + write + delete
                           │       │
              ┌────────────┴──┐  ┌─┴──────────────┐
              │ hr-assistant  │  │   hr-admin      │
              │ (tools.deny   │  │ (full access)   │
              │  write/delete)│  │                 │
              └───────┬───────┘  └────────┬────────┘
                      │                   │
              飞书 Bot 1            飞书 Bot 4
              (全员)               (HR管理员)
```

- `tools.deny` 是系统级硬隔离：即使 LLM 被诱导，被 deny 的工具也无法调用
- 两个 Agent 完全独立，无 parent-child 关系
- 飞书侧通过 Bot 可见范围控制用户访问

---

## 五、知识库架构

```
~/.openclaw/data/
├── hr-policies/
│   ├── leave/           # 假期制度
│   ├── onboarding/      # 入离职流程
│   ├── attendance/      # 考勤制度
│   ├── compensation/    # 薪酬福利（受限级）
│   ├── training/        # 培训制度
│   └── general/         # 通用制度
└── hr-admin/
    └── audit-log.jsonl  # 操作审计日志
```

**文档格式**：Markdown + YAML frontmatter（title, doc_id, version, effective_date, category）

**导入方式**：

1. Admin Portal 拖拽上传（推荐）：PDF/Word/Text → 自动转 Markdown + 元数据推理
2. CLI 脚本：`skills/hr-admin/scripts/doc-to-markdown.mjs`
3. 飞书 Bot 4 对话指令

---

## 六、Workspace 结构

每个 Agent 的 Workspace 包含身份和行为定义文件：

```
~/.openclaw/
├── workspaces/hr-assistant/
│   ├── AGENTS.md       # Agent 职责和行为规范
│   ├── SOUL.md         # 人格和语气定义
│   ├── IDENTITY.md     # 身份标识
│   ├── MEMORY.md       # 长期记忆
│   ├── TOOLS.md        # 环境备忘（可用工具、知识库路径等）
│   └── CLAUDE.md       # → AGENTS.md 的 symlink
└── workspaces/hr-admin/
    ├── AGENTS.md
    ├── SOUL.md
    ├── IDENTITY.md
    ├── MEMORY.md
    ├── TOOLS.md
    └── CLAUDE.md
```

---

## 七、Phase 1 功能范围

| 功能            | 状态   | 说明                  |
| --------------- | ------ | --------------------- |
| 政策问答（RAG） | 可用   | 知识库检索 + 引用回答 |
| 知识库管理      | 可用   | 上传/删除/查看/审计   |
| Admin Portal    | 可用   | Web 管理后台          |
| 入离职流程      | 开发中 | 占位回复              |
| 排班考勤        | 开发中 | 占位回复              |
| 招聘助手        | 规划中 | —                     |
| 数据分析        | 规划中 | —                     |

---

## 八、不修改 OpenClaw 源码

Yoma+HR 不包含 OpenClaw 源码，直接使用 `npm install -g openclaw` 安装的原生版本：

- CLI：直接使用 `openclaw` 命令，不创建别名
- 配置：通过 `OPENCLAW_CONFIG_PATH` 指向自定义配置文件
- Skills：复制到 `~/.openclaw/skills/`，OpenClaw 自动发现
- Workspace：通过 Agent 配置中的 `workspace` 字段指定
- 运行时目录：使用 openclaw 默认的 `~/.openclaw/`
- 服务账号：使用 `ubuntu` 用户，不需要专用系统账号
