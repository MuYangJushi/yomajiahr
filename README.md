# Yoma+HR 智能助手

基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建的企业 HR 多 Agent 智能系统，通过飞书 Bot + Web 界面为全员提供 HR 自助服务。

## 功能特性

| 模块       | 说明                                   | 状态       |
| ---------- | -------------------------------------- | ---------- |
| 政策问答   | RAG 检索知识库，回答员工 HR 政策问题   | Phase 1 ✅ |
| 知识库管理 | 管理员上传/更新/删除政策文档，审计日志 | Phase 1 ✅ |
| 入离职管理 | 入职引导、离职流程、转正提醒           | Phase 2    |
| 招聘助手   | 简历筛选、面试安排、招聘进度跟踪       | Phase 2    |
| 排班考勤   | 请假申请、调班、打卡异常处理           | Phase 3    |
| 数据分析   | HR 数据看板、人员统计、趋势分析        | Phase 3    |

## 架构概览

采用 **B+C 混合架构** — Sub-agent 统一入口 + 独立 Bot 权限隔离：

```
前端入口
├── 飞书 Bot 1: HR小助手（全员）
├── 飞书 Bot 2: 招聘助手（招聘团队）      ← Phase 2
├── 飞书 Bot 3: HR数据分析师（管理层）    ← Phase 3
├── 飞书 Bot 4: HR管理后台（HR管理员）
├── Web Portal (:18789)
└── Admin Portal (:18790)

Agent 层
├── hr-assistant (orchestrator)
│   ├── hr-policy-rag (政策问答 Sub-agent, 只读)
│   ├── hr-onboard (入离职 Sub-agent)       ← Phase 2
│   └── hr-schedule (排班考勤 Sub-agent)    ← Phase 3
├── hr-admin (管理员 Agent, 知识库读写)
├── hr-recruit (招聘 Agent)                 ← Phase 2
└── hr-analytics (数据分析 Agent)           ← Phase 3

数据层
├── ~/.ymjhr/memory/hr-policies/   知识库（Markdown + YAML frontmatter）
└── ~/.ymjhr/memory/hr-admin/      审计日志（JSONL）
```

## 快速开始

### 前置条件

- Node.js 22+
- pnpm 10+
- 飞书开放平台自建应用（至少 2 个 Bot）
- LLM API Key（Anthropic / OpenAI）

### 安装与启动

```bash
# 1. 克隆并构建
git clone https://github.com/MorrisYangJushi/yomajiahr.git
cd yomajiahr
pnpm install && pnpm build

# 2. 注册 CLI 命令
npm link    # 注册 ymjhr 到全局 PATH

# 3. 配置环境变量
cp config/.env.ymjhr.example ~/.ymjhr/.env
# 编辑 ~/.ymjhr/.env 填入 API Key、飞书 Bot 凭据等

# 4. 生成配置文件
# 参考 config/ymjhr.jsonc，去掉注释后写入 ~/.ymjhr/ymjhr.json

# 5. 链接 Skills
ln -s /path/to/yomajiahr/skills/hr-assistant   ~/.ymjhr/skills/hr-assistant
ln -s /path/to/yomajiahr/skills/hr-policy-rag  ~/.ymjhr/skills/hr-policy-rag
ln -s /path/to/yomajiahr/skills/hr-admin       ~/.ymjhr/skills/hr-admin

# 6. 启动 Gateway
ymjhr gateway run --bind loopback --port 18789

# 7. 启动 Admin Portal
cd admin-portal && npm install && node server.mjs
```

详细部署步骤请参考 [部署指南](docs/yomajiahr-deployment.md)。

## 项目结构

```
yomajiahr/
├── openclaw.mjs              # CLI 入口（ymjhr / openclaw 双命令）
├── src/cli/cli-name.ts       # CLI 命名逻辑
├── config/
│   ├── ymjhr.jsonc           # Agent/Channel/Tool 策略配置模板
│   └── .env.ymjhr.example    # 环境变量模板
├── skills/
│   ├── hr-assistant/         # 全员 orchestrator Agent
│   ├── hr-policy-rag/        # 政策问答 Sub-agent（含示例政策文档）
│   └── hr-admin/             # 管理员 Agent
├── admin-portal/
│   ├── server.mjs            # Admin Portal Express 服务
│   ├── lib/doc-converter.mjs # 文档转换器（PDF/Word/Text → Markdown）
│   └── public/               # 前端 SPA
├── docs/
│   ├── yomajiahr-architecture.md  # 架构设计
│   ├── yomajiahr-deployment.md    # 部署指南
│   ├── yomajiahr-branding.md      # 品牌命名指南
│   └── design/                    # 设计文档
└── src/                           # OpenClaw 引擎源码
```

## 命名约定

| 层级       | 名称       | 用途                                 |
| ---------- | ---------- | ------------------------------------ |
| 品牌显示名 | `Yoma+HR`  | 文档标题、UI 界面                    |
| 技术命令名 | `ymjhr`    | CLI 命令、目录路径、systemd 服务     |
| 引擎层     | `openclaw` | 环境变量名（`OPENCLAW_*`）、npm 包名 |

详见 [品牌命名指南](docs/yomajiahr-branding.md)。

## 相关文档

- [架构设计](docs/yomajiahr-architecture.md) — B+C 混合架构、Sub-agent handoff 协议
- [部署指南](docs/yomajiahr-deployment.md) — 从零到生产的完整流程
- [品牌命名指南](docs/yomajiahr-branding.md) — CLI/目录/服务命名对照表
- [设计文档](docs/design/) — 原始需求与方案评审

## License

[MIT](LICENSE)
