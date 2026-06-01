# OpenClaw HR 智能助手 — 多 Agent 架构设计文档

## 一、背景与目标

基于 OpenClaw 构建企业 HR 智能助手，覆盖政策问答、招聘、入离职、数据分析、排班考勤五大业务模块。需要在「用户体验」「权限隔离」「运维成本」「可扩展性」之间取得平衡。

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

**原理**：利用 OpenClaw 原生的 Sub-agent 能力（`sessions_spawn`），主 Agent 作为路由编排器，将请求分发给独立的子 Agent 执行。每个 Sub-agent 拥有独立的 session、上下文窗口和工具权限。

**架构**：

```
飞书 Bot (1个)
  └── OpenClaw Agent (主)
        ├── 路由 Agent (orchestrator, depth=0)
        │     ├── 政策问答 Sub-agent (depth=1)
        │     ├── 入离职 Sub-agent (depth=1)
        │     └── 排班考勤 Sub-agent (depth=1)
        └── (可嵌套 depth=2 的 worker)
```

**优势**：

- **硬权限隔离**：每个 Sub-agent 有独立的工具策略（tool policy），可精确控制哪些工具可用
- **独立上下文**：每个 Sub-agent 有自己的上下文窗口，互不干扰
- **统一入口**：用户只需和一个 Bot 交互，路由 Agent 自动分发
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

| 维度 | A: 纯 Skills | B: Sub-agents | C: 多飞书 Bot |
|------|-------------|---------------|--------------|
| **用户入口** | 1 个 Bot，自动路由 | 1 个 Bot，自动路由 | 多个 Bot，用户自选 |
| **用户体验** | 最佳（无感切换） | 优秀（统一入口） | 一般（需选择 Bot） |
| **权限隔离** | 软隔离（Prompt 层） | 硬隔离（session + 工具策略） | 最强隔离（进程级） |
| **上下文** | 共享（有竞争） | 各自独立 | 完全独立 |
| **跨模块协作** | 天然共享 | announce 机制 | 需额外设计 |
| **飞书权限控制** | 仅 Prompt 层 | 仅 Prompt + 工具策略 | 飞书原生 Bot 可见性 |
| **运维复杂度** | 最低 | 中等 | 最高 |
| **扩展新 Agent** | 加 Skill | 加 Skill + spawn 规则 | 新建飞书应用 + Agent |
| **故障影响面** | 全局 | 主 Agent 故障影响全部 | 互不影响 |
| **适合场景** | 轻量、低权限、快速验证 | 需要隔离的统一入口 | 完全独立、用户群不同 |

---

## 四、最终方案：B+C 混合架构

### 决策理由

单一方案无法同时满足以下需求：

1. **全员通用功能需要统一入口**（政策问答、排班考勤）— 方案 B 最佳
2. **高权限功能需要飞书侧原生权限控制**（招聘仅招聘团队、数据分析仅管理层）— 方案 C 最佳
3. **核心模块之间需要协作**（入离职需要查政策）— 方案 B 的 Sub-agent 机制支持
4. **独立模块需要故障隔离**（数据分析 SQL 出错不应影响政策问答）— 方案 C 提供

**B+C 混合方案**取两者所长：

- 方案 B 覆盖「统一入口 + 内部协作」的需求
- 方案 C 覆盖「强隔离 + 飞书原生权限」的需求

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      飞书前端层                           │
│                                                         │
│  Bot 1: HR小助手 (全员)                                  │
│  Bot 2: 招聘助手 (招聘团队)                               │
│  Bot 3: HR数据分析师 (管理层)                             │
└────────────┬──────────────────┬──────────────┬──────────┘
             │                  │              │
   ┌─────────▼─────────┐  ┌────▼────┐   ┌─────▼─────┐
   │  OpenClaw Agent    │  │ Agent   │   │  Agent    │
   │  (主 - 方案B)      │  │ (独立)  │   │  (独立)   │
   │                    │  │         │   │           │
   │  路由 Agent        │  │ 招聘    │   │ 数据分析  │
   │  (orchestrator)    │  │ 全功能  │   │ 全功能    │
   │   ├── 政策问答     │  │         │   │           │
   │   │   Sub-agent    │  └─────────┘   └───────────┘
   │   ├── 入职/离职    │    方案C           方案C
   │   │   Sub-agent    │
   │   └── 排班考勤     │
   │       Sub-agent    │
   └────────────────────┘
          方案B
```

### Agent 分配逻辑

**核心 Bot（方案 B）— 全员可用**：

| Agent | 理由 |
|-------|------|
| 路由 Agent | 统一入口，意图识别 |
| 政策问答 | 全员高频需求，无敏感权限 |
| 入离职流程 | 需要与政策问答协作（查入职须知等） |
| 排班考勤 | 全员需求，权限要求不高 |

**独立 Bot（方案 C）— 限定人群**：

| Agent | 飞书可见范围 | 理由 |
|-------|-------------|------|
| 招聘助手 | 招聘团队 | 涉及候选人隐私、薪资信息，需严格限定访问范围 |
| 数据分析师 | 管理层 | 涉及全局人员数据、离职率、薪资统计等敏感指标 |

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
          "enabled": true
        },
        // 招聘 Bot - 招聘团队
        "hr-recruit": {
          "appId": "${FEISHU_RECRUIT_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_RECRUIT_BOT_APP_SECRET" },
          "botName": "招聘助手",
          "enabled": true
        },
        // 数据分析 Bot - 管理层
        "hr-analytics": {
          "appId": "${FEISHU_ANALYTICS_BOT_APP_ID}",
          "appSecret": { "source": "env", "id": "FEISHU_ANALYTICS_BOT_APP_SECRET" },
          "botName": "HR数据分析师",
          "enabled": true
        }
      },
      "dmPolicy": "open",
      "groupPolicy": "open",
      "streaming": true
    }
  }
}
```

### Sub-agent 配置（核心 Bot 内部）

```jsonc
// agents 配置
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5,
        "maxConcurrent": 8,
        "runTimeoutSeconds": 300
      }
    }
  }
}
```

---

## 五、Phase 1 实施范围

按照「渐进式落地」策略，Phase 1 仅实现核心 Bot 的政策问答功能：

```
飞书 Bot 1: HR小助手 (全员, WebSocket)
  └── OpenClaw Agent
        ├── 路由 Agent (简单路由：政策问答 vs 其他)
        └── 政策问答 Sub-agent
              └── RAG: OpenClaw built-in memory_search
                    └── 20+ PDF 政策文档 (分类子目录)
```

### Phase 1 交付物

1. **飞书 Channel 配置**
   - WebSocket 模式，全员开放
   - 环境变量模板 `.env.example`
   - 本地写好配置，云上零配置运行

2. **路由 Agent Skill**
   - 简单意图识别（政策问答 vs 其他）
   - "其他" 回复"功能开发中，敬请期待"
   - 消息前缀标识不同 Agent 角色

3. **政策问答 Sub-agent Skill**
   - RAG 基于 OpenClaw built-in memory_search（sqlite-vec + hybrid search）
   - 20+ PDF 文档批量导入，分类子目录存储
   - 回答附引用（文档名 + 版本号 + 行号）
   - 多轮对话上下文理解
   - 未命中时 @mention HR 专员

4. **PDF 批量转换脚本**
   - `pdf-to-markdown.mjs`（基于 pdfjs-dist）
   - 支持批量转换 + 分类输出

5. **部署配置**
   - `.env.example` 环境变量模板
   - 飞书 channel 配置
   - Sub-agent 配置

---

## 六、后续阶段规划

| 阶段 | 时间 | 内容 |
|------|------|------|
| Phase 2 | 2-4 月 | 核心 Bot 增加入离职 Sub-agent + 招聘独立 Bot（方案C） |
| Phase 3 | 4-6 月 | 核心 Bot 增加排班考勤 + 数据分析独立 Bot（方案C） |

---

## 七、Phase 1 实施步骤

### Step 1: 初始化 Skill 骨架

```bash
# 路由 Agent Skill
skills/skill-creator/scripts/init_skill.py hr-router --path skills --resources scripts,references

# 政策问答 Agent Skill
skills/skill-creator/scripts/init_skill.py hr-policy-rag --path skills --resources scripts,references,assets
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

### Step 4: 编写路由 Agent Skill

`skills/hr-router/SKILL.md`

- 简单意图分类：政策问答 → spawn 政策问答 Sub-agent
- 其他意图 → 回复"该功能正在开发中"
- 配置 `sessions_spawn` 参数
- 消息前缀标识：`[📄 政策问答]`

### Step 5: 编写政策问答 Agent Skill

`skills/hr-policy-rag/SKILL.md`

- Agent 行为规则：
  - 仅回答政策相关问题，非政策问题退回路由
  - 引用格式：`[来源: {文件名}, 文档编号: {编号}, 版本: {版本}, 第{X}-{Y}行]`
  - 仅使用中文回答
  - 多轮对话上下文理解
  - 未命中知识库 → @mention HR 专员
  - 禁止编造政策内容
  - 不暴露薪资/绩效数据（分级数据访问）

### Step 6: 编写参考文档

- `skills/hr-policy-rag/references/advanced-config.md` — memory search 调优
- `skills/hr-router/references/routing-rules.md` — 路由规则说明

### Step 7: 飞书 + 部署配置

- 在项目根目录创建 `.env.hr-assistant.example`
- 配置 `openclaw.json` 的 `channels.feishu` 节点
- 配置 `agents` 的 Sub-agent 参数

### Step 8: 打包验证

```bash
skills/skill-creator/scripts/package_skill.py skills/hr-router
skills/skill-creator/scripts/package_skill.py skills/hr-policy-rag
```

---

## 八、关键文件参考

| 文件 | 用途 |
|------|------|
| `skills/skill-creator/SKILL.md` | Skill 创建规范 |
| `src/media/pdf-extract.ts` | pdfjs-dist 提取模式参考 |
| `src/memory/internal.ts` | memory 文件发现机制 |
| `src/memory/manager-search.ts` | hybrid search 实现 |
| `docs/tools/subagents.md` | Sub-agent 配置与使用文档 |
| `extensions/feishu/src/config-schema.ts` | 飞书 channel 配置结构 |
| `openclaw_hr_assistant_fixed.html` | v2.0 系统设计方案（需求来源） |

---

## 九、验证方案

1. **PDF 转换**：`node scripts/pdf-to-markdown.mjs test.pdf --out-dir memory/hr-policies/leave/` → 检查输出 Markdown 格式
2. **索引验证**：复制示例文档到 `memory/hr-policies/`，确认 memory_search 能检索到
3. **Skill 打包**：`package_skill.py` 两个 Skill 均通过验证
4. **问答测试**：问"年假怎么算？"→ 验证回答包含引用（文档名+版本+行号）
5. **未命中测试**：问无关问题 → 验证返回"未找到相关信息"+ @mention HR
6. **路由测试**：问非政策问题 → 验证返回"功能开发中"
7. **部署验证**：云上 `.env` + `openclaw gateway run` → 飞书 Bot 可响应
