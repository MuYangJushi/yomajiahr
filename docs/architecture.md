# Yoma+HR 智能助手 — 架构设计文档

> **2026-06-19 全面修订**：此前版本描述的是 Sprint 1-3 时代架构（固定 hr-assistant/hr-admin 双 Agent、`memory_search` 本地切片检索、`data/hr-policies/` 本地分类目录）。这些已被后续 ADR 整体取代：知识库换成 FastGPT 唯一源（ADR-006/010），工具体系改为按知识库绑定派生的 per-agent MCP（ADR-011），本地 `memory_search` 回退链退役（ADR-012），平台从"两个写死的 Bot"演进为"可招募任意数量数字员工 + 独立渠道管理"（ADR-013/014）。本次修订对齐现状。

## 一、背景与目标

基于 OpenClaw 构建企业 HR 数字员工管理平台（Yoma+HR），覆盖政策问答、招聘、入离职、数据分析、排班考勤五大业务模块。

当前采用 **Plan A（纯 Agent + Skills，不用 Sub-agent）**：

- 每个数字员工是一个独立 Agent + 若干 Skill，Skill 内调用 MCP 工具完成检索/管理
- 权限隔离靠角色（`platformRole`：`employee` / `admin`）+ `tools.deny` 硬隔离，不靠 LLM 提示词约束

### 为什么选 Plan A（历史决策，仍然有效）

之前采用 B+C 混合架构（Sub-agent 编排器 + 独立管理 Bot）在实际运行中暴露三个问题：

1. **Sub-agent 上下文传递 bug**：`sessions_spawn` 导致多用户会话间上下文泄漏
2. **OpenClaw 源码修改**：为支持 Sub-agent 改了 gateway 和 memory-tool 源码，无法跟进上游
3. **延迟**：Agent→Sub-agent 转发增加 2-5 秒响应延迟

Plan A 通过 Skills 隔离领域行为，在同一 Agent 内完成检索和回答，消除以上问题（详见 [ADR-001](https://github.com/MuYangJushi/yomajiahr-kb/blob/main/10-decisions/ADR-001-Plan-A-单网关多Skills架构.md)）。

---

## 二、平台现状：空白起步 + 系统模板（ADR-013/014）

**平台不再硬编码固定的两个 Agent。** 新部署默认**无任何数字员工**（`agents.json`/`bindings.json` 种子为空数组）。`hr-employee`（原 `hr-assistant`）/ `hr-admin` 现在是**系统模板**（`admin-server/src/services/agent-templates.ts`，`GET /config/agent-templates`），招募向导可选"从系统模板创建"预填角色/权限/档案，也可以创建任意 ID、任意数量的其他数字员工。

```
飞书/钉钉渠道账号（独立资产，admin-web Channels 页管理）
        │ bind/unbind（bindings.json）
        ▼
数字员工 Agent（agents.json，role: employee | admin）
        │ Skills（markdown 能力提示词，正交于工具）
        │ Tools（按 role + 知识库绑定生成，knowledge.json）
        ▼
FastGPT（knowledge_search / knowledge_import，唯一知识源）

Admin Portal（独立 Express 服务，端口 18790）
    直接文件系统/配置存储操作，不经过 Agent
```

**关键认知（ADR-015）：技能 ≠ 工具授权，是正交两轴**：
- **技能**是 `skills/*.md` markdown 能力提示词，分配 = 往 `agent.skills[]` 增删，经生成器渲染进 workspace
- **工具**（如 `knowledge_search`）由**角色 + 知识库绑定**授予（ADR-011 绑定即真相），与技能分配无关——给员工配了 `hr-policy-qa` 技能，不代表它就能调 `knowledge_search`，必须在「知识库」页另外给它绑库

> ⚠️ 技能配置当前仅是设计草案（ADR-015），代码未实现——前端只有 `admin-web/src/App.tsx` 里禁用的占位菜单「技能配置（规划中）」。

---

## 三、角色与典型 Skill 配置

平台用 `platformRole`（`employee` / `admin`）区分**系统权限级别**，不代表真实岗位（真实岗位走 `profile.jobTitle`，AI 档案共创生成，见 ADR-013 §2）。下表是当前两个系统模板的典型配置，**不是平台上限**：

### employee 角色（典型代表：`hr-employee`，原 `hr-assistant`）

**Skill 分工**：

| Skill          | 触发条件                            | 功能                                          |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| `hr-policy-qa` | 政策/制度/假期/考勤/福利/社保类问题 | 调用 `knowledge_search` 检索 FastGPT 知识库，附引用回答 |
| `hr-general`   | 操作类请求、未上线功能、闲聊        | 占位回复、拦截非 HR 话题                      |

**工具权限**（绑库后才有，无绑定→无工具，双重守卫见 ADR-011）：

| 工具                              | 权限 | 说明                       |
| --------------------------------- | ---- | -------------------------- |
| `kb-<agentId>__knowledge_search`  | 绑库后允许 | 检索该 Agent 绑定的 FastGPT 知识库 |
| `knowledge_import`                 | 禁止 | 员工不能导入/修改知识库     |
| `exec`                             | 禁止 | 员工不能执行脚本           |

> ❌ 已退役：`memory_search` / `memory_get` / `memory_write` / `memory_delete`（OpenClaw 内置，ADR-012 退役）；本地 `data/hr-policies/` 自研分类目录（ADR-010 退役，FastGPT 是唯一源）。

### admin 角色（典型代表：`hr-admin`）

**定位**：拥有知识库写权限，处理文档导入、渠道管理、员工资料编辑。

**管理入口**：

| 入口                 | 适用场景                               |
| -------------------- | --------------------------------------- |
| Admin Portal（推荐） | 数字员工招募/编辑、渠道管理、知识库导入、审计 |
| 飞书/钉钉管理 Bot     | 快捷对话式操作                          |

**工具权限**：绑库后额外得 `kb-<agentId>__knowledge_import`；`tools.deny` 硬隔离 `gateway` / `sessions_spawn` / `memory_write` / `memory_delete`（守 ADR-003）。

---

## 四、权限隔离模型

```
                    ┌──────────────────────┐
                    │   FastGPT 知识库      │
                    │ （唯一源，ADR-010）   │
                    └──────┬───────┬───────┘
                           │       │
                  search   │       │ search + import
                           │       │
              ┌────────────┴──┐  ┌─┴──────────────┐
              │  employee 角色 │  │   admin 角色    │
              │ (tools.deny    │  │ (绑库后额外得   │
              │  knowledge_    │  │  knowledge_     │
              │  import)       │  │  import)        │
              └───────┬───────┘  └────────┬────────┘
                      │                   │
              飞书/钉钉渠道账号（独立资产，可绑定任意员工）
```

- `tools.deny` 是系统级硬隔离：即使 LLM 被诱导，被 deny 的工具也无法调用（ADR-003）
- 每个数字员工 Agent 完全独立，无 parent-child 关系
- 工具暴露按知识库**绑定**驱动（ADR-011）：`knowledge.json` 是单一真相源，生成器据此派生每 agent 的 `kb-<agentId>` MCP 注册 + `tools.allow`，无绑定→无 `knowledge_search`
- 渠道账号（飞书/钉钉）是独立资产，与员工的绑定关系在「渠道」页管理，一个账号最多绑一个员工

---

## 五、知识库架构（FastGPT 唯一源，ADR-006/010）

**不在文件系统维护 markdown 归档。** 所有政策文档通过 Admin Portal「知识库」页 → FastGPT 平台原生 `create/localFile` 解析导入；检索走 FastGPT `searchTest`。

```
yomakit（Admin Server + OpenClaw Gateway）
        │ WireGuard 隧道 10.99.0.1:3000
        ▼
yomajia1（FastGPT v4.8.22 精简栈：app + pgvector + mongo + oneapi）
```

- **受限标记**：`compensation` 等敏感库走 `knowledge.json` per-KB `restricted` 字段，不在平台侧绕开
- **引用规范**：`hr-policy-qa` 引用格式 `[来源: filename, 文档编号: HR-XXX, 版本: X.X]`；title 是强制锚点，文档编号/版本是 best-effort，缺失即省略，**绝不编造**；`doc_id` 不再自动生成
- **导入方式**：仅 Admin Portal「知识库」页 FastGPT 原生解析；不再有 CLI 转换脚本、不再有飞书/钉钉对话指令导入文档原文（导入操作走 `hr-admin` skill 调 `knowledge_import` 工具）

---

## 六、Workspace 结构

每个数字员工 Agent 的 Workspace 包含身份和行为定义文件，路径用 Agent 的真实 ID（例如系统模板创建出来的 `hr-employee`/`hr-admin`，而不是任意写死的名字）：

```
~/.openclaw/
└── workspaces/<agentId>/
    ├── AGENTS.md       # Agent 职责和行为规范（含「待配置技能/待接入渠道」状态提示，模板锁定不可覆盖）
    ├── SOUL.md         # 渲染 profile.personality + profile.tone + profile.boundaries
    ├── IDENTITY.md     # 渲染 profile.jobTitle + profile.responsibilities
    ├── MEMORY.md       # 长期记忆（模板锁定不可覆盖）
    ├── TOOLS.md        # 环境备忘（模板锁定不可覆盖，工具名按 per-agent 化泛指 knowledge_search，不硬编码）
    └── CLAUDE.md       # → AGENTS.md 的 symlink
```

`profile` 字段（`jobTitle`/`responsibilities`/`personality`/`tone`/`boundaries`）由 MiniMax AI 档案共创生成（ADR-013 §2），**只用于平台编辑与 workspace 渲染，不进入 OpenClaw 运行时配置**（生成器渲染时剔除）。

---

## 七、Admin Portal 页面结构

`admin-web/src/` 下页面平铺（**没有 `src/pages/` 子目录**）：

| 页面 | 文件 | 职责 |
| --- | --- | --- |
| 数字员工 | `Agents.tsx` + `CreateAgentWizard.tsx`（五步招募向导）+ `EditAgentModal.tsx` | 招募/编辑员工资料，不处理技能/渠道 |
| 员工模板 | `Templates.tsx`（只读） | 罗列系统模板，"用此模板招募"预填向导 |
| 渠道管理 | `Channels.tsx` | 账号资产 CRUD + 扫码/手工新增 + 绑定/解绑 + 健康探活 |
| 知识库 | `Knowledge.tsx` | FastGPT 导入/绑定 |
| 审计 | `Audit.tsx` | 操作审计日志 |
| 登录 | `Login.tsx` | 飞书/钉钉企业开放登录 |

一级菜单另含「技能配置（规划中）」「流程编排（规划中）」两个禁用占位入口（ADR-014 留的脚手架，分别对应 ADR-015 与 Phase 2）。

---

## 八、Phase 1 功能范围

| 功能              | 状态   | 说明                              |
| ----------------- | ------ | --------------------------------- |
| 政策问答（RAG）   | 可用   | FastGPT 检索 + 引用回答           |
| 知识库管理        | 可用   | 导入/删除/查看/审计（FastGPT 原生） |
| 数字员工招募/管理 | 可用   | 系统模板 + AI 档案共创 + 五步向导 |
| 渠道管理          | 可用   | 账号资产独立 CRUD + 绑定/探活     |
| Admin Portal      | 可用   | Web 管理后台                      |
| 技能配置          | 设计中 | ADR-015 草案，代码未实现          |
| 流程编排          | 规划中 | Phase 2，OpenClaw 无原生 workflow |
| 入离职流程        | 开发中 | 占位回复                          |
| 排班考勤          | 开发中 | 占位回复                          |
| 招聘助手          | 规划中 | —                                  |
| 数据分析          | 规划中 | —                                  |

---

## 九、不修改 OpenClaw 源码（ADR-002）

Yoma+HR 不包含 OpenClaw 源码，直接使用 `npm install -g openclaw` 安装的原生版本：

- CLI：直接使用 `openclaw` 命令，不创建别名
- 配置：通过 `OPENCLAW_CONFIG_PATH` 指向自定义配置文件，由 `config/src/generate-config.ts` 合并静态基座 + 动态 config-store 生成
- Skills：复制到 `~/.openclaw/skills/`，OpenClaw 自动发现
- Workspace：通过 Agent 配置中的 `workspace` 字段指定
- 运行时目录：使用 openclaw 默认的 `~/.openclaw/`
- 服务账号：使用 `ubuntu` 用户，不需要专用系统账号
