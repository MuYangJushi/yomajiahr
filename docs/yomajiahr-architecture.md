# Yoma+HR 智能助手 — 多 Agent 架构设计文档

## 一、背景与目标

基于 OpenClaw 构建企业 HR 智能助手（Yoma+HR），覆盖政策问答、招聘、入离职、数据分析、排班考勤五大业务模块。需要在「用户体验」「权限隔离」「运维成本」「可扩展性」之间取得平衡。

本文档记录了三种候选架构方案的评估过程，以及最终采用 B+C 混合方案的决策理由。

---

## 二、OpenClaw 的三种 Agent 架构模式

### 方案 A：纯 Skills 模式

**原理**：一个 OpenClaw Agent 实例，通过加载不同的 Skill（SKILL.md）来响应不同类型的请求。Skill 本质上是给同一个 Agent 注入不同的 System Prompt 片段。

**架构**：

```
飞书 Bot (1个)
  └── OpenClaw Agent (1个实例)
        ├── 路由逻辑 (Skill 触发机制自动匹配)
        ├── hr-policy-rag Skill (政策问答)
        ├── hr-recruit Skill (招聘)
        ├── hr-onboard Skill (入离职)
        ├── hr-analytics Skill (数据分析)
        └── hr-schedule Skill (排班考勤)
```

**优势**：

- 实现最简单，开发速度最快
- 单个 Agent 实例，运维成本最低
- Skill 之间天然共享上下文，跨模块对话无缝衔接
- 扩展新功能只需添加新 Skill

**劣势**：

- **权限隔离为软隔离**：所有 Skill 共享同一个 Agent 的工具权限，只能通过 Prompt 指令限制行为，无法从系统层面阻止越权访问
- **上下文窗口共享**：所有 Skill 的 Prompt 占用同一个上下文窗口，随着 Skill 增多上下文会被压缩
- **可靠性耦合**：一个 Skill 的异常可能影响整个 Agent 的对话状态
- **不适合敏感操作**：无法在系统层面区分"政策问答可以做什么"和"数据分析可以做什么"

### 方案 B：Sub-agents 模式

**原理**：利用 OpenClaw 原生的 Sub-agent 能力（`sessions_spawn`），主 Agent 作为编排器，将请求分发给独立的子 Agent 执行。每个 Sub-agent 拥有独立的 session、上下文窗口和工具权限。

**架构**：

```
飞书 Bot (1个)
  └── OpenClaw Agent (主)
        ├── 全员 Agent (orchestrator, depth=0)
        │     ├── 政策问答 Sub-agent (depth=1)
        │     ├── 入离职 Sub-agent (depth=1)
        │     └── 排班考勤 Sub-agent (depth=1)
        └── (可嵌套 depth=2 的 worker)
```

**优势**：

- **硬权限隔离**：每个 Sub-agent 有独立的工具策略（tool policy），可精确控制哪些工具可用
- **独立上下文**：每个 Sub-agent 有自己的上下文窗口，互不干扰
- **统一入口**：用户只需和一个 Bot 交互，全员 Agent 自动分发
- **原生 announce 机制**：Sub-agent 完成后自动将结果报告给父 Agent
- **支持并发**：最多 8 个 Sub-agent 并行运行
- **支持嵌套**：最多 5 层深度，支持复杂编排

**劣势**：

- **配置复杂度较高**：需要配置 spawn 规则、工具策略、超时、并发限制等
- **跨 Agent 信息共享不如 Skills 自然**：需要通过 announce 机制传递结果
- **全部 Agent 共用一个飞书 Bot 身份**：无法在飞书侧做 Bot 级别的权限控制
- **单点问题**：主 Agent 故障会影响所有 Sub-agent 的路由

### 方案 C：多飞书 Bot 模式

**原理**：在飞书开放平台创建多个自建应用（Bot），每个 Bot 对应一个独立的 OpenClaw Agent 实例。用户通过选择不同的 Bot 来使用不同的功能。

**架构**：

```
飞书 Bot 1: HR小助手 → OpenClaw Agent 1 (政策问答)
飞书 Bot 2: 招聘助手 → OpenClaw Agent 2 (招聘)
飞书 Bot 3: 数据分析师 → OpenClaw Agent 3 (数据分析)
...
```

**优势**：

- **最强隔离**：完全独立的 Agent 实例，进程级隔离
- **飞书侧原生权限控制**：不同 Bot 可设置不同的可见范围（全员/指定部门/指定人员）
- **独立身份**：每个 Bot 有自己的名称、头像、描述，用户感知清晰
- **故障隔离**：一个 Bot 崩溃不影响其他 Bot

**劣势**：

- **用户体验碎片化**：用户需要知道该找哪个 Bot，增加认知负担
- **跨 Agent 协作困难**：不同 Bot 之间没有直接通信机制，无法实现"入职流程需要同时查政策 + 触发招聘系统"等跨模块场景
- **运维成本最高**：每个 Bot 需要独立的飞书应用（App ID/Secret）、独立的 Agent 配置
- **扩展成本高**：每加一个功能模块就需要新建飞书应用
- **上下文割裂**：用户在 Bot 1 聊的内容，Bot 2 完全不知道

---

## 三、方案对比总览

| 维度             | A: 纯 Skills           | B: Sub-agents                | C: 多飞书 Bot        |
| ---------------- | ---------------------- | ---------------------------- | -------------------- |
| **用户入口**     | 1 个 Bot，自动路由     | 1 个 Bot，自动路由           | 多个 Bot，用户自选   |
| **用户体验**     | 最佳（无感切换）       | 优秀（统一入口）             | 一般（需选择 Bot）   |
| **权限隔离**     | 软隔离（Prompt 层）    | 硬隔离（session + 工具策略） | 最强隔离（进程级）   |
| **上下文**       | 共享（有竞争）         | 各自独立                     | 完全独立             |
| **跨模块协作**   | 天然共享               | announce 机制                | 需额外设计           |
| **飞书权限控制** | 仅 Prompt 层           | 仅 Prompt + 工具策略         | 飞书原生 Bot 可见性  |
| **运维复杂度**   | 最低                   | 中等                         | 最高                 |
| **扩展新 Agent** | 加 Skill               | 加 Skill + spawn 规则        | 新建飞书应用 + Agent |
| **故障影响面**   | 全局                   | 主 Agent 故障影响全部        | 互不影响             |
| **适合场景**     | 轻量、低权限、快速验证 | 需要隔离的统一入口           | 完全独立、用户群不同 |

---

## 四、最终方案：B+C 混合架构

### 决策理由

单一方案无法同时满足以下需求：

1. **全员通用功能需要统一入口**（政策问答、排班考勤）— 方案 B 最佳
2. **高权限功能需要飞书侧原生权限控制**（招聘仅招聘团队、数据分析仅管理层、知识库管理仅 HR 管理员）— 方案 C 最佳
3. **核心模块之间需要协作**（入离职需要查政策）— 方案 B 的 Sub-agent 机制支持
4. **独立模块需要故障隔离**（数据分析 SQL 出错不应影响政策问答）— 方案 C 提供
5. **知识库写操作需要读写分离**（全员只读问答 vs 管理员编辑知识库）— 方案 C 隔离写入权限

**B+C 混合方案**取两者所长：

- 方案 B 覆盖「统一入口 + 内部协作」的需求
- 方案 C 覆盖「强隔离 + 飞书原生权限 + 读写分离」的需求

### 整体架构

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                   前端入口层                                       │
│                                                                                  │
│  [飞书]                         [OpenClaw Web Portal]    [Admin Portal :18790]   │
│  Bot 1: HR小助手 (全员)          对话式管理 (HR管理员)     独立 Web 管理后台       │
│  Bot 2: 招聘助手 (招聘团队)                                - 文档上传 (PDF/Word)  │
│  Bot 3: HR数据分析师 (管理层)                              - 文档管理             │
│  Bot 4: HR管理后台 (HR管理员)                              - 审计日志/CSV 导出    │
└──┬─────────────┬──────────────┬────────────┬──────────────┬──────────────────────┘
   │             │              │            │              │
┌──▼──────────┐ ┌▼────────┐ ┌──▼────────┐ ┌─▼────────┐    │ (直接读写知识库目录)
│ Agent (主)  │ │ Agent   │ │ Agent     │ │ Agent    │◄───┘
│ 方案B       │ │ 招聘    │ │ 数据分析  │ │ 管理员   │
│             │ │         │ │           │ │          │
│ 全员 Agent  │ │         │ │           │ │ 知识库   │
│(orchestrator│ │         │ │           │ │ 管理     │
│ ├─政策问答  │ │         │ │           │ │ 权限管理 │
│ │ Sub-agent │ └─────────┘ └───────────┘ │ 操作审计 │
│ ├─入离职    │   方案C        方案C       └──────────┘
│ │ Sub-agent │                              方案C
│ └─排班考勤  │
│   Sub-agent │          ┌─────────────────────────┐
└─────────────┘          │  Admin Portal (独立服务)  │
    方案B                │  Express + multer         │
                         │  doc-converter            │
                         │  直接读写 memory 目录      │
                         │  审计日志 (JSONL)          │
                         └─────────────────────────┘
```

### Agent 分配逻辑

**核心 Bot（方案 B）— 全员可用**：

| Agent                     | 理由                                     |
| ------------------------- | ---------------------------------------- |
| 全员 Agent (orchestrator) | 统一入口，意图识别，请求分发             |
| 政策问答 Sub-agent        | 全员高频需求，只读访问知识库，无敏感权限 |
| 入离职 Sub-agent          | 需要与政策问答协作（查入职须知等）       |
| 排班考勤 Sub-agent        | 全员需求，权限要求不高                   |

**独立 Bot（方案 C）— 限定人群**：

| Agent        | 飞书可见范围 | 前端入口          | 理由                                            |
| ------------ | ------------ | ----------------- | ----------------------------------------------- |
| 招聘助手     | 招聘团队     | 飞书              | 涉及候选人隐私、薪资信息，需严格限定访问范围    |
| 数据分析师   | 管理层       | 飞书              | 涉及全局人员数据、离职率、薪资统计等敏感指标    |
| 管理员 Agent | HR 管理员    | 飞书 + Web Portal | 知识库写入/删除、权限管理、审计查询等高权限操作 |

### Sub-agent 跨模块接力机制

Sub-agent 之间不能直接通信（OpenClaw 架构限制：同级 Sub-agent 无横向通道）。但通过全员 Agent（orchestrator）居中调度，可实现 **跨 Sub-agent 接力**：一个 Sub-agent 在对话中识别到跨模块意图后，通过 announce 机制将结构化接力请求回传给全员 Agent，由全员 Agent 自动 spawn 目标 Sub-agent 继续处理。

#### 接力流程

以「政策问答 → 排班考勤（请假）」为例：

```
用户: "年假怎么算？"
  │
  ▼
全员 Agent (orchestrator, depth=0)
  │  识别意图 → 政策问答
  │  sessions_spawn → 政策问答 Sub-agent
  ▼
政策问答 Sub-agent (depth=1)
  │  memory_search → 返回年假政策
  │  回答: "根据公司制度，入职满1年享有5天年假..."
  │
用户: "好的，我要请3天年假"
  │
  ▼
政策问答 Sub-agent (depth=1)
  │  识别到跨模块意图: 请假申请 ≠ 政策问答
  │  announce 回传接力请求（结构化 payload）
  ▼
全员 Agent (orchestrator, depth=0)
  │  收到 announce，解析 handoff payload
  │  提取上下文: { action: "leave_request", days: 3, type: "annual" }
  │  sessions_spawn → 排班考勤 Sub-agent（携带上下文）
  ▼
排班考勤 Sub-agent (depth=1)
  │  收到预填上下文，继续处理请假流程
  │  "好的，正在为您发起3天年假申请..."
  │  announce 回传结果
  ▼
全员 Agent → 回复用户最终结果
```

#### 接力协议（Handoff Protocol）

Sub-agent 在 announce 时，如果识别到需要接力给其他模块，在回复末尾附加结构化 JSON 块：

```markdown
<!-- 正常回复内容 -->

根据公司制度，入职满1年享有5天年假。您当前剩余年假3天。

<!-- 接力请求（仅全员 Agent 解析，不展示给用户） -->

:::handoff
{
"target": "hr-schedule",
"action": "leave_request",
"reason": "用户在政策问答中明确表达了请假意图",
"context": {
"leave_type": "annual",
"days": 3,
"source_summary": "用户查询年假政策后，要求请3天年假"
}
}
:::
```

#### 全员 Agent 的接力处理规则

全员 Agent 收到包含 `:::handoff` 的 announce 后：

1. **解析**：提取 `target`（目标 Sub-agent）和 `context`（接力上下文）
2. **确认**：向用户发送过渡提示，如 "正在为您转接请假流程..."
3. **分发**：`sessions_spawn` 目标 Sub-agent，将 `context` 注入 task 描述
4. **透传结果**：目标 Sub-agent announce 后，将最终结果回复用户

```jsonc
// 全员 Agent spawn 排班考勤 Sub-agent 时的 task 示例
{
  "task": "用户从政策问答接力而来，请继续处理请假申请。\n\n接力上下文：\n- 请假类型: 年假\n- 请假天数: 3天\n- 前序对话摘要: 用户查询年假政策后要求请3天年假\n\n请直接进入请假流程，无需重新询问已知信息。",
  "label": "排班考勤-请假申请",
}
```

#### 支持的接力场景（Phase 2+）

| 来源 Sub-agent | 目标 Sub-agent | 触发条件                         | 接力上下文             |
| -------------- | -------------- | -------------------------------- | ---------------------- |
| 政策问答       | 排班考勤       | 用户表达请假/调班意图            | 假期类型、天数、日期   |
| 政策问答       | 入离职         | 用户询问入职材料后表达要办理入职 | 入职日期、材料清单     |
| 入离职         | 政策问答       | 入职流程中需要查询政策细节       | 查询关键词、政策分类   |
| 排班考勤       | 政策问答       | 考勤争议中需要引用政策条款       | 争议类型、相关政策编号 |

#### 设计要点

1. **单向接力，orchestrator 居中**：Sub-agent 不直接调用 sibling，必须通过全员 Agent 中转。这保证了全员 Agent 始终掌握全局对话流
2. **上下文压缩传递**：接力上下文只传关键字段（意图、参数），不传完整对话历史，避免上下文窗口膨胀
3. **用户可感知**：接力时向用户显示过渡提示（如"正在转接..."），保持体验连贯
4. **可回退**：如果目标 Sub-agent 不可用或超时，全员 Agent 回退为文本提示（如"请假功能暂时不可用，请稍后重试"）
5. **Phase 1 预埋**：Phase 1 仅实现政策问答，但全员 Agent 的接力解析逻辑提前写入，遇到 `:::handoff` 时回复"该功能正在开发中"，为 Phase 2 无缝衔接

### 管理员 Agent 设计

#### 职责范围

| 功能             | 说明                                                        |
| ---------------- | ----------------------------------------------------------- |
| **知识库管理**   | 上传/更新/删除政策文档；触发重新索引；查看索引状态          |
| **权限管理**     | 配置哪些部门/人员可访问特定政策分类（如薪资类仅管理层可查） |
| **操作审计**     | 查看知识库变更历史、权限变更记录                            |
| **文档版本管理** | 标记文档版本号、生效日期、废止旧版                          |

#### 读写分离：工具策略对比

```jsonc
// 管理员 Agent — 拥有知识库写权限
{
  "tools": {
    "allow": [
      "memory_write",       // 写入/更新知识库文档
      "memory_delete",      // 删除知识库文档
      "memory_search",      // 搜索验证
      "exec"                // 运行 doc-converter 转换脚本
    ],
    "deny": [
      "gateway",
      "sessions_spawn"      // 管理员 Bot 无需 Sub-agent
    ]
  }
}

// 政策问答 Sub-agent — 仅只读
{
  "tools": {
    "allow": [
      "memory_search"       // 只读搜索
    ],
    "deny": [
      "memory_write",
      "memory_delete",
      "exec"
    ]
  }
}
```

#### 为什么用方案 C（独立 Bot）而非方案 B（Sub-agent）

1. **读写分离原则**：知识库编辑、权限管理都是写操作，必须和面向全员的只读问答严格隔离
2. **飞书原生权限**：只有指定的 HR 管理员能看到这个 Bot，从入口层就杜绝越权
3. **审计需求**：独立 Bot 的对话记录天然就是操作审计日志
4. **故障隔离**：管理员误操作不会卡住全员问答服务

### 管理员前端入口

管理员有三个前端入口，各有侧重：

| 入口                    | 技术方案                                | 端口  | 适用场景                                                             |
| ----------------------- | --------------------------------------- | ----- | -------------------------------------------------------------------- |
| **Admin Portal** (推荐) | 独立 Express Web 服务 (`admin-portal/`) | 18790 | 文档上传（拖拽 PDF/Word/文本）、文档列表管理、审计日志查看/筛选/导出 |
| **OpenClaw Web Portal** | OpenClaw 内置 Web Provider              | 18789 | 对话式管理（快捷删除、查询等）                                       |
| **飞书 Bot 4**          | 飞书 WebSocket                          | -     | 移动端快捷操作（"删除 HR-LEAVE-001"、"查看本周操作记录"）            |

#### Admin Portal（独立管理后台）

Admin Portal 是独立于 OpenClaw 的轻量 Web 服务，解决了 OpenClaw Web Portal 不支持文件上传的限制：

```
Admin Portal (http://<server>:18790)
  ├── /#upload        文档上传
  │   ├── 拖拽或选择文件（PDF / Word docx / 文本）
  │   ├── 选择分类、填写元数据（文档编号、版本、生效日期）
  │   └── 自动转换为 Markdown 写入知识库
  ├── /#documents     文档管理
  │   ├── 分类筛选、关键词搜索
  │   ├── 查看文档内容
  │   └── 删除文档（二次确认）
  └── /#audit-log     审计日志
      ├── 按操作类型 / 文档编号 / 日期范围筛选
      ├── 分页浏览
      └── CSV 导出（兼容 Excel）
```

**技术栈**：

- 后端：Express + multer (文件上传) + doc-converter (多格式转换)
- 前端：原生 HTML/CSS/JS（SPA，无框架依赖）
- 认证：复用 `OPENCLAW_WEB_AUTH_TOKEN`
- 存储：直接读写 `~/.openclaw/memory/hr-policies/` 目录和 `audit-log.jsonl`

**支持的文档格式**：

| 格式 | 扩展名    | 转换引擎   | 说明                                   |
| ---- | --------- | ---------- | -------------------------------------- |
| PDF  | .pdf      | pdfjs-dist | 提取文本，低文本页面警告（疑似扫描件） |
| Word | .docx     | mammoth    | 转为 Markdown，保留基本格式            |
| 文本 | .txt, .md | 直接读取   | 原样写入                               |

#### OpenClaw Web Portal（对话式管理）

基于 OpenClaw 内置 Web Provider，提供聊天界面与管理员 Agent 交互。适合快捷的查询和删除操作，但**不支持文件上传**。

#### 飞书 Bot 4

与 OpenClaw Web Portal 功能相同，通过飞书消息与管理员 Agent 对话。适合移动端快速操作。

### 飞书 Channel 配置结构

```jsonc
// openclaw.json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "domain": "feishu",
      "connectionMode": "websocket",
      "accounts": {
        // 核心 Bot - 全员
        "hr-assistant": {
          "appId": "${FEISHU_HR_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_HR_BOT_APP_SECRET" },
          "botName": "HR小助手",
          "enabled": true,
        },
        // 招聘 Bot - 招聘团队
        "hr-recruit": {
          "appId": "${FEISHU_RECRUIT_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_RECRUIT_BOT_APP_SECRET" },
          "botName": "招聘助手",
          "enabled": true,
        },
        // 数据分析 Bot - 管理层
        "hr-analytics": {
          "appId": "${FEISHU_ANALYTICS_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_ANALYTICS_BOT_APP_SECRET" },
          "botName": "HR数据分析师",
          "enabled": true,
        },
        // 管理员 Bot - HR管理员
        "hr-admin": {
          "appId": "${FEISHU_ADMIN_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_ADMIN_BOT_APP_SECRET" },
          "botName": "HR管理后台",
          "enabled": true,
        },
      },
      "dmPolicy": "open",
      "groupPolicy": "open",
      "streaming": true,
    },
  },
  "web": {
    "enabled": true,
  },
}
```

### Sub-agent 配置（全员 Bot 内部）

```jsonc
// agents 配置
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5,
        "maxConcurrent": 8,
        "runTimeoutSeconds": 300,
      },
    },
  },
}
```

---

## 五、Phase 1 实施范围

按照「渐进式落地」策略，Phase 1 实现全员政策问答 + 管理员知识库管理：

```
前端入口:
  ├── 飞书 Bot 1: HR小助手 (全员, WebSocket)
  │     └── OpenClaw Agent (全员 Agent)
  │           ├── 意图识别 + 请求分发 (orchestrator)
  │           └── 政策问答 Sub-agent (只读)
  │                 └── RAG: memory_search
  │                       └── 20+ PDF 政策文档 (分类子目录)
  │
  ├── 飞书 Bot 4: HR管理后台 (HR管理员)
  │     └── OpenClaw Agent (管理员 Agent)
  │           ├── 知识库 CRUD (读写)
  │           ├── 文档转换（对话触发）
  │           └── 操作审计日志
  │
  ├── Admin Portal :18790 (HR管理员, 推荐)
  │     └── 独立 Express Web 服务
  │           ├── 文档上传（拖拽 PDF/Word/文本，自动转换）
  │           ├── 文档管理（列表/搜索/删除）
  │           └── 审计日志（筛选/分页/CSV 导出）
  │
  └── OpenClaw Web Portal :18789 (HR管理员)
        └── 复用管理员 Agent（对话式管理）
```

### Phase 1 交付物

1. **飞书 Channel 配置**
   - WebSocket 模式
   - Bot 1（全员）+ Bot 4（HR 管理员）两个飞书应用
   - 环境变量模板 `.env.ymjhr.example`

2. **Web Portal 配置**
   - 启用顶层 `web.enabled`
   - Gateway 认证复用 `OPENCLAW_GATEWAY_TOKEN`

3. **全员 Agent Skill**
   - 简单意图识别（政策问答 vs 其他）
   - "其他" 回复"功能开发中，敬请期待"

4. **政策问答 Sub-agent Skill**
   - RAG 基于 OpenClaw built-in memory_search（sqlite-vec + hybrid search）
   - 20+ PDF 文档批量导入，分类子目录存储
   - 回答附引用（文档名 + 版本号 + 行号）
   - 多轮对话上下文理解
   - 未命中时 @mention HR 专员

5. **管理员 Agent Skill**
   - 知识库文档 CRUD（上传、更新、删除、查询）
   - 文档版本管理（版本号、生效日期）
   - 操作审计日志查询

6. **Admin Portal（独立管理后台）**
   - 独立 Express Web 服务（`admin-portal/`），端口 18790
   - 文档上传页：拖拽上传 PDF/Word(docx)/文本，选分类，填元数据，自动转换写入知识库
   - 文档管理页：分类筛选、搜索、查看内容、删除（二次确认）
   - 审计日志页：按操作类型/文档编号/日期筛选，分页浏览，CSV 导出
   - Token 认证（复用 `OPENCLAW_WEB_AUTH_TOKEN`）

7. **多格式文档转换器**
   - `admin-portal/lib/doc-converter.mjs`（通用转换库）
   - 支持 PDF（pdfjs-dist）、Word/docx（mammoth）、文本（直接读取）
   - `skills/hr-policy-rag/scripts/pdf-to-markdown.mjs`（PDF 专用命令行工具，保留兼容）

8. **部署配置**
   - `.env.ymjhr.example` 环境变量模板
   - 飞书 channel 配置（2 个 Bot）
   - 顶层 web 配置
   - Sub-agent 配置
   - Admin Portal systemd 服务配置
   - Nginx 反向代理（双服务：Web Portal + Admin Portal）

---

## 六、后续阶段规划

| 阶段    | 时间   | 内容                                                                             |
| ------- | ------ | -------------------------------------------------------------------------------- |
| Phase 2 | 2-4 月 | 全员 Bot 增加入离职 Sub-agent + 招聘独立 Bot（方案C）；管理员 Agent 增加权限管理 |
| Phase 3 | 4-6 月 | 全员 Bot 增加排班考勤 + 数据分析独立 Bot（方案C）；Web Portal 增加权限配置界面   |

---

## 七、Phase 1 实施步骤

### Step 1: 初始化 Skill 骨架

```bash
# 全员 Agent Skill
skills/skill-creator/scripts/init_skill.py hr-assistant --path skills --resources scripts,references

# 政策问答 Sub-agent Skill
skills/skill-creator/scripts/init_skill.py hr-policy-rag --path skills --resources scripts,references,assets

# 管理员 Agent Skill
skills/skill-creator/scripts/init_skill.py hr-admin --path skills --resources scripts,references
```

### Step 2: 编写 PDF 批量转换脚本

`skills/hr-policy-rag/scripts/pdf-to-markdown.mjs`

- 基于 `pdfjs-dist/legacy/build/pdf.mjs`（参考 `src/media/pdf-extract.ts`）
- 输入: `node pdf-to-markdown.mjs <input-dir> --out-dir memory/hr-policies/ --category <分类名>`
- 输出: 结构化 Markdown，含元数据头（文档编号、版本、生效日期）+ `## Page N` 分页
- 支持批量模式 + 自动创建分类子目录
- 低文本页面警告（疑似扫描件）

### Step 3: 创建示例政策文档

`skills/hr-policy-rag/assets/sample-policies/` 下 3 份中文示例：

```
assets/sample-policies/
├── leave/
│   ├── annual-leave-policy.md    # 年假制度
│   └── sick-leave-policy.md      # 病假制度
└── onboarding/
    └── probation-policy.md       # 试用期管理办法
```

每份含文档编号 + 版本号，用于测试引用链路。

### Step 4: 编写全员 Agent Skill

`skills/hr-assistant/SKILL.md`

- 简单意图分类：政策问答 → spawn 政策问答 Sub-agent
- 其他意图 → 回复"该功能正在开发中"
- 配置 `sessions_spawn` 参数

### Step 5: 编写政策问答 Sub-agent Skill

`skills/hr-policy-rag/SKILL.md`

- Agent 行为规则：
  - 仅回答政策相关问题，非政策问题退回全员 Agent
  - 引用格式：`[来源: {文件名}, 文档编号: {编号}, 版本: {版本}, 第{X}-{Y}行]`
  - 仅使用中文回答
  - 多轮对话上下文理解
  - 未命中知识库 → @mention HR 专员
  - 禁止编造政策内容
  - 不暴露薪资/绩效数据（分级数据访问）

### Step 6: 编写管理员 Agent Skill

`skills/hr-admin/SKILL.md`

- 知识库管理：
  - 上传文档（接收 PDF → 调用 pdf-to-markdown 转换 → memory_write 写入索引）
  - 更新文档（更新版本号、生效日期、内容）
  - 删除/废止文档（memory_delete + 记录废止原因）
  - 查询文档列表（按分类、状态筛选）
- 操作审计：
  - 记录所有写操作到审计日志
  - 支持按时间范围、操作类型查询
- 安全规则：
  - 删除操作需二次确认
  - 批量操作（超过 5 份文档）需明确列出清单后确认

### Step 7: 编写参考文档

- `skills/hr-policy-rag/references/advanced-config.md` — memory search 调优
- `skills/hr-assistant/references/routing-rules.md` — 路由规则说明
- `skills/hr-admin/references/admin-operations.md` — 管理操作规范

### Step 8: 实现 Admin Portal

`admin-portal/`

- Express Web 服务 (`server.mjs`)：文件上传 API、文档 CRUD API、审计日志 API
- 多格式文档转换器 (`lib/doc-converter.mjs`)：PDF/Word/文本 → Markdown
- 前端 SPA (`public/`)：文档上传、文档管理、审计日志三个页面
- 独立 `package.json`（express, multer, mammoth, pdfjs-dist）
- Token 认证，复用 `OPENCLAW_WEB_AUTH_TOKEN`

### Step 9: 飞书 + Web + 部署配置

- 在项目根目录创建 `.env.ymjhr.example`
- 配置 `openclaw.json` 的 `channels.feishu` 节点（Bot 1 + Bot 4）
- 配置 `openclaw.json` 的顶层 `web` 节点（管理员 Web Portal）
- 配置 `agents` 的 Sub-agent 参数

### Step 10: 打包验证

```bash
skills/skill-creator/scripts/package_skill.py skills/hr-assistant
skills/skill-creator/scripts/package_skill.py skills/hr-policy-rag
skills/skill-creator/scripts/package_skill.py skills/hr-admin
```

---

## 八、关键文件参考

| 文件                                     | 用途                              |
| ---------------------------------------- | --------------------------------- |
| `skills/skill-creator/SKILL.md`          | Skill 创建规范                    |
| `src/media/pdf-extract.ts`               | pdfjs-dist 提取模式参考           |
| `src/memory/internal.ts`                 | memory 文件发现机制               |
| `src/memory/manager-search.ts`           | hybrid search 实现                |
| `docs/tools/subagents.md`                | Sub-agent 配置与使用文档          |
| `src/provider-web.ts`                    | Web Provider 实现参考             |
| `extensions/feishu/src/config-schema.ts` | 飞书 channel 配置结构             |
| `admin-portal/server.mjs`                | Admin Portal 服务端               |
| `admin-portal/lib/doc-converter.mjs`     | 多格式文档转换器（PDF/Word/Text） |
| `admin-portal/public/`                   | Admin Portal 前端页面             |
| `yomajiahr_fixed.html`                   | v2.0 系统设计方案（需求来源）     |

---

## 九、验证方案

1. **PDF 转换**：`node scripts/pdf-to-markdown.mjs test.pdf --out-dir memory/hr-policies/leave/` → 检查输出 Markdown 格式
2. **多格式转换**：通过 Admin Portal 分别上传 PDF、Word(docx)、文本文件 → 验证均成功转换为 Markdown
3. **索引验证**：复制示例文档到 `memory/hr-policies/`，确认 memory_search 能检索到
4. **Skill 打包**：`package_skill.py` 三个 Skill 均通过验证
5. **问答测试**：问"年假怎么算？"→ 验证回答包含引用（文档名+版本+行号）
6. **未命中测试**：问无关问题 → 验证返回"未找到相关信息"+ @mention HR
7. **路由测试**：问非政策问题 → 验证返回"功能开发中"
8. **Admin Portal 上传测试**：拖拽 PDF 到上传页 → 填写元数据 → 验证转换成功并出现在文档列表
9. **Admin Portal 文档管理**：筛选分类、搜索文档编号、查看内容、删除文档 → 验证各功能正常
10. **Admin Portal 审计日志**：验证上传/删除操作自动记录 → 按日期筛选 → CSV 导出正常
11. **管理员 Bot 测试**：通过飞书 Bot 4 发送"列出所有文档"→ 验证返回文档列表
12. **Web Portal 测试**：浏览器访问 `http://<server>:18789/web` → 验证对话式管理可用
13. **端到端测试**：Admin Portal 上传新文档 → 全员 Bot 立即可查询到该文档
14. **部署验证**：云上启动 Gateway (18789) + Admin Portal (18790) → 飞书 Bot + Web Portal + Admin Portal 均可响应
