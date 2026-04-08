# Yoma+HR 品牌命名指南

## 命名策略

| 层级           | 名称       | 用途                           | 示例                                           |
| -------------- | ---------- | ------------------------------ | ---------------------------------------------- |
| **品牌显示名** | `Yoma+HR`  | 文档标题、UI 界面、描述性文字  | "Yoma+HR 智能助手"                             |
| **引擎层**     | `openclaw` | CLI 命令、npm 包、环境变量名   | `openclaw gateway run`、`OPENCLAW_STATE_DIR`   |
| **项目目录**   | `yomajiahr`| 代码仓库、部署路径             | `/opt/yomajiahr/`                              |

**核心原则**：直接使用原生 openclaw，不修改源码，不创建命令别名。所有定制通过配置文件、workspace 和 skills 实现。

## CLI 命令

直接使用 `openclaw` 命令（通过 `npm install -g openclaw` 安装）：

```bash
openclaw gateway run --bind loopback --port 18789
openclaw channels status --probe
openclaw skills list
```

## 运行时目录

使用 openclaw 默认目录 `~/.openclaw/`：

| 路径 | 说明 |
|------|------|
| `~/.openclaw/openclaw.json` | 运行时配置 |
| `~/.openclaw/.env` | API 密钥 |
| `~/.openclaw/workspaces/hr-assistant/` | 员工 Agent workspace |
| `~/.openclaw/workspaces/hr-admin/` | 管理 Agent workspace |
| `~/.openclaw/skills/` | HR Skills |
| `~/.openclaw/memory/` | 语义索引（openclaw 默认） |
| `~/.openclaw/data/hr-policies/` | 知识库文档 |
| `~/.openclaw/data/hr-admin/` | 审计日志 |

## systemd 服务

| 服务 | 说明 |
|------|------|
| `openclaw-gateway.service` | Gateway 服务 |
| `openclaw-admin.service` | Admin Portal 服务 |

服务以 `ubuntu` 用户运行，不需要专用系统账号。

## 不改动的内容

| 项目 | 原因 |
|------|------|
| `OPENCLAW_*` 环境变量名称 | openclaw 原生约定 |
| `openclaw` CLI 命令 | 原生安装，不创建别名 |
| `openclaw` npm 包名 | 上游依赖 |
| 飞书 Bot 中文名（HR小助手等） | 面向用户的独立品牌 |
