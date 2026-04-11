# Yoma+HR 智能助手
> 📚 项目计划、Sprint 看板、知识库在独立仓库:[yomajiahr-kb](https://github.com/MuYangJushi/yomajiahr-kb)

基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建的企业 HR 多 Agent 智能系统，通过飞书 Bot + Web 界面为全员提供 HR 自助服务。

> 本仓库只包含 HR 定制配置（Agent workspace、Skills、配置文件和 Admin Portal），不包含 openclaw 源码。openclaw 通过 `npm install -g openclaw` 安装。

## 功能特性

| 模块       | 说明                                   | 状态       |
| ---------- | -------------------------------------- | ---------- |
| 政策问答   | RAG 检索知识库，回答员工 HR 政策问题   | Phase 1    |
| 知识库管理 | 管理员上传/更新/删除政策文档，审计日志 | Phase 1    |
| 入离职管理 | 入职引导、离职流程、转正提醒           | Phase 2    |
| 排班考勤   | 请假申请、调班、打卡异常处理           | Phase 3    |

## 架构

```
          飞书 Bot 1          飞书 Bot 4
         (HR小助手)          (HR管理后台)
              |                   |
              v                   v
        hr-assistant          hr-admin          Admin Portal
        Skills:               Skill:            (:18790)
        - hr-policy-qa        - hr-admin
        - hr-general
              |                   |
              v                   v
        memory_search         memory_write
        (知识库只读)          (知识库读写)
              |                   |
              +-------+-----------+
                      |
               ~/.openclaw/data/hr-policies/
```

- **hr-assistant**：员工入口，绑定飞书 Bot 1，只读知识库
- **hr-admin**：管理入口，绑定飞书 Bot 4，读写知识库 + 审计日志
- **Admin Portal**：独立 Web 服务（端口 18790），文档上传/管理/审计日志

## 前置条件

- curl（用于自动安装 Node.js）
- Node.js >= 22（没有也可以，`install.sh` 会自动安装）

## 一键部署

```bash
git clone <repo-url> yomajiahr
cd yomajiahr
./install.sh
```

`install.sh` 会自动：
1. 安装 openclaw（`npm install -g openclaw@latest`）
2. 创建 `~/.openclaw/` 目录结构
3. 复制 workspace 文件和 skills
4. 编译配置文件（JSONC -> JSON）
5. 复制 .env 模板
6. 安装 admin-portal 依赖

### 配置 API Keys

编辑 `~/.openclaw/.env`，填入实际的 API 密钥：

```bash
vi ~/.openclaw/.env
```

### 启动服务

```bash
# 启动 gateway
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw gateway run --bind loopback --port 18789

# 启动 admin portal（另一个终端）
cd admin-portal && node server.mjs
```

### systemd 部署（Linux）

```bash
./install.sh --systemd
sudo systemctl enable --now openclaw-gateway
sudo systemctl enable --now openclaw-admin
```

## 目录结构

```
yomajiahr/
  install.sh              # 一键部署脚本
  config/
    openclaw.jsonc         # gateway 配置模板
    .env.example           # 环境变量模板
    openclaw-*.service     # systemd 服务文件
  workspaces/
    hr-assistant/          # 员工 Agent workspace 模板
    hr-admin/              # 管理 Agent workspace 模板
  skills/
    hr-policy-qa/          # 政策问答 Skill
    hr-admin/              # 知识库管理 Skill
    hr-general/            # 通用对话 Skill
  admin-portal/            # 独立 Admin Web 服务
  docs/                    # 项目文档
```

## 更新

```bash
cd yomajiahr
git pull
./install.sh    # 重新部署配置和 skills
```

## 文档

- [架构说明](docs/architecture.md)
- [部署指南](docs/deployment.md)
- [品牌命名](docs/branding.md)
- [重构计划](docs/restructure-plan.md)
