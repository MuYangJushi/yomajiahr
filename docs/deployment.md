# Yoma+HR 智能助手 — 部署指南

本文档覆盖从代码仓库到云服务器运行的完整流程。

> 本项目不包含 openclaw 源码。openclaw 通过 `npm install -g openclaw` 安装，本仓库只包含 HR Agent 配置和 Admin Portal。

## 一条命令部署（推荐）

在全新 Ubuntu 24 服务器上，只需执行：

```bash
# 生产部署（安装 systemd 服务，开机自启）
curl -fsSL https://raw.githubusercontent.com/MorrisYangJushi/yomajiahr/main/install.sh | bash -s -- --systemd

# 测试部署（不安装 systemd，手动启动）
curl -fsSL https://raw.githubusercontent.com/MorrisYangJushi/yomajiahr/main/install.sh | bash
```

脚本会自动完成：安装 curl/git/ripgrep → 克隆仓库到 `/opt/yomajiahr` → 安装 Node.js 22 → 安装 openclaw → 创建目录结构并清理空的旧政策目录 → 编译配置 → 安装 admin-portal 依赖 → （可选）安装 systemd 服务。

完成后手动操作：填写 API 密钥（见 Step 2）→ 创建飞书 Bot（见飞书开放平台准备）→ 启动服务。

---

## 前置条件

### 服务器要求

- Linux（Ubuntu 22.04+ / Debian 12+）或 macOS
- curl（用于自动安装 Node.js，如果尚未安装）
- Node.js 22+（没有也可以，`install.sh` 会自动安装）
- 内存 2GB+，磁盘 10GB+
- 网络：可出站访问飞书 API（`open.feishu.cn`）和 LLM API

### 飞书开放平台准备

部署前需在 [飞书开放平台](https://open.feishu.cn) 创建两个自建应用。

**Bot 1: HR小助手（全员可用）**

1. 创建企业自建应用，命名 "HR小助手"
2. 添加「机器人」能力
3. 权限管理 -> 申请以下权限：
   - `im:message`（接收消息）
   - `im:message:send`（发送消息）
   - `im:resource`（访问资源）
   - `contact:user.id:readonly`（读取用户 ID）
4. 事件与回调 -> 添加事件：`im.message.receive_v1`（接收消息事件）
5. 事件与回调 -> 选择 **WebSocket** 连接方式
6. 版本管理与发布 -> 可用范围设为 **全部员工**
7. 记录 `App ID` 和 `App Secret`
8. 发布应用

**Bot 4: HR管理后台（仅 HR 管理员）**

1. 同上流程创建第二个应用，命名 "HR管理后台"
2. 权限同上
3. 可用范围设为 **仅指定人员**（选择 HR 管理员）
4. 记录 `App ID` 和 `App Secret`
5. 发布应用

---

## 部署步骤

### Step 1: 拉取代码并安装

```bash
git clone https://github.com/<your-username>/yomajiahr.git /opt/yomajiahr
cd /opt/yomajiahr
./install.sh
```

`install.sh` 会自动完成以下操作：

1. 检查 Node.js >= 22
2. 安装 openclaw（`npm install -g openclaw@latest`）
3. 创建 `~/.openclaw/` 目录结构
4. 复制 workspace 文件到 `~/.openclaw/workspaces/`
5. 复制 skills 到 `~/.openclaw/skills/`
6. 编译配置 JSONC -> JSON 写入 `~/.openclaw/openclaw.json`
7. 复制 .env 模板
8. 安装 admin-portal 依赖

当前仓库默认将 heartbeat 显式开启在 `hr-assistant` 和 `hr-admin` 两个 agent 上，公共 cadence 为 30 分钟，`target` 为 `none`，仅用于内部巡检与保活，不会直接向飞书用户外发心跳消息。

### Step 2: 配置环境变量

编辑 `~/.openclaw/.env`，填入真实的 API 密钥：

```bash
nano ~/.openclaw/.env
```

必须填写的字段：

| 变量 | 说明 |
|------|------|
| `MINIMAX_API_KEY` | MiniMax 模型 API Key |
| `DASHSCOPE_API_KEY` | 阿里百炼 Embedding API Key |
| `FEISHU_HR_BOT_APP_ID` | 飞书 Bot 1 App ID |
| `FEISHU_HR_BOT_APP_SECRET` | 飞书 Bot 1 App Secret |
| `FEISHU_ADMIN_BOT_APP_ID` | 飞书 Bot 4 App ID |
| `FEISHU_ADMIN_BOT_APP_SECRET` | 飞书 Bot 4 App Secret |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 认证 token（自定义长随机串） |
| `OPENCLAW_WEB_AUTH_TOKEN` | Admin Portal 认证 token |

### Step 3: 上传知识库文档

将 HR 政策文档（Markdown 格式）放入对应分类目录：

```bash
ls ~/.openclaw/data/hr-policies/
# attendance/  staffing/  compensation/  training/  performance/  general/
```

也可以通过 Admin Portal 上传 PDF/Word/文本文件，系统会自动转换为 Markdown。
`install.sh` 会保留 `admin-portal/lib/categories.mjs` 中定义的正式分类目录，并自动清理其它空的历史目录；若历史目录内仍有文件，脚本会保留目录并提示先迁移文档。

### Step 4: 验证安装

```bash
# 检查 openclaw 版本
openclaw --version

# 检查 skills
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw skills list

# 检查 channels
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw channels status --probe
```

如需确认 heartbeat 是否已注册，可额外检查各 agent 的会话索引里是否出现 `provider = "heartbeat"` 的主会话。

### Step 5: 启动服务

**手动启动（测试用）：**

```bash
# 终端 1: 启动 gateway
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json \
  openclaw gateway run --bind loopback --port 18789

# 终端 2: 启动 admin portal
cd /opt/yomajiahr/admin-portal
OPENCLAW_STATE_DIR=~/.openclaw node server.mjs
```

**systemd 部署（生产推荐）：**

```bash
cd /opt/yomajiahr
./install.sh --systemd

sudo systemctl enable --now openclaw-gateway
sudo systemctl enable --now openclaw-admin
```

### Step 6: 验证服务

```bash
# 检查服务状态
sudo systemctl status openclaw-gateway --no-pager
sudo systemctl status openclaw-admin --no-pager

# 查看日志
sudo journalctl -u openclaw-gateway -f
sudo journalctl -u openclaw-admin -f

# 检查端口
ss -ltnp | grep -E '18789|18790'
```

---

## 目录结构

### 代码仓库

```
/opt/yomajiahr/
  install.sh
  config/
    openclaw.jsonc              # 配置模板
    .env.example                # 环境变量模板
    openclaw-gateway.service    # systemd 服务
    openclaw-admin.service
  workspaces/                   # Agent workspace 模板
  skills/                       # HR Skills
  admin-portal/                 # Admin Web 服务
  docs/
```

### 运行时状态目录

```
~/.openclaw/
  openclaw.json                 # 运行时配置（由 install.sh 编译）
  .env                          # API 密钥
  workspaces/
    hr-assistant/               # 员工 Agent workspace
    hr-admin/                   # 管理 Agent workspace
  skills/
    hr-policy-qa/
    hr-admin/
    hr-general/
  memory/                       # 语义索引（自动生成）
  data/
    hr-policies/                # 知识库文档
      leave/
      onboarding/
      attendance/
      compensation/
      training/
      general/
    hr-admin/
      audit-log.jsonl           # 操作审计日志
```

---

## 日常运维

### 更新代码

```bash
cd /opt/yomajiahr
git pull
sudo systemctl stop openclaw-gateway
./install.sh --systemd          # 重新部署配置、skills 和 systemd unit
sudo systemctl restart openclaw-gateway
sudo systemctl restart openclaw-admin
```

### 查看日志

```bash
# systemd 日志
sudo journalctl -u openclaw-gateway -n 100 --no-pager
sudo journalctl -u openclaw-admin -n 100 --no-pager

# 审计日志
tail -n 20 ~/.openclaw/data/hr-admin/audit-log.jsonl
```

### 服务管理

```bash
sudo systemctl start openclaw-gateway
sudo systemctl stop openclaw-gateway
sudo systemctl restart openclaw-gateway
sudo systemctl status openclaw-gateway --no-pager
```

---

## 故障排查

| 问题 | 排查方式 |
|------|----------|
| Gateway 启动失败 | `journalctl -u openclaw-gateway -n 100` |
| 飞书 Bot 未响应 | `OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw channels status --probe` |
| Skills 未识别 | `OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw skills list` |
| 知识库搜不到文档 | 确认 `~/.openclaw/data/hr-policies/` 下有 .md 文件且含正确 frontmatter |
| Admin Portal 无法访问 | 确认端口 18790 开放；`journalctl -u openclaw-admin -n 100` |
| 审计日志为空 | 确认 `~/.openclaw/data/hr-admin/audit-log.jsonl` 存在且有写入权限 |
