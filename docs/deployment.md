# Yoma+HR 智能助手 — 部署指南

本文档覆盖从代码仓库到云服务器运行的完整流程。

> 本项目不包含 openclaw 源码。部署时先安装 `openclaw` 主包，再安装飞书官方插件与钉钉官方 connector；本仓库只包含 HR Agent 配置和 Admin Portal。

## 一条命令部署（推荐）

在全新 Ubuntu 24 服务器上，只需执行：

```bash
# 生产部署（安装 systemd 服务，开机自启）
curl -fsSL https://raw.githubusercontent.com/MuYangJushi/yomajiahr/main/install.sh | bash -s -- --systemd

# 测试部署（不安装 systemd，手动启动）
curl -fsSL https://raw.githubusercontent.com/MuYangJushi/yomajiahr/main/install.sh | bash
```

脚本会自动完成：安装 curl/git/ripgrep → 克隆仓库到 `/opt/yomajiahr` → 安装 Node.js 24 → 按需自动使用 `sudo` 安装 openclaw 主包 → 创建目录结构并清理空的旧政策目录 → 编译配置 → 安装飞书官方插件与钉钉官方 connector → 安装 admin-server 依赖 → （可选）安装 systemd 服务。

完成后手动操作：填写 API 密钥（见 Step 2）→ 创建飞书/钉钉 Bot（见开放平台准备）→ 启动服务。

---

## 前置条件

### 服务器要求

- Linux（Ubuntu 22.04+ / Debian 12+）或 macOS
- curl（用于自动安装 Node.js，如果尚未安装）
- Node.js 24+（没有也可以，`install.sh` 会自动安装）
- OpenClaw 2026.4.9+（钉钉官方 connector 的最低要求；`install.sh` 默认安装最新版）
- 内存 2GB+，磁盘 10GB+
- 网络：可出站访问飞书 API（`open.feishu.cn`）、钉钉 API/Stream 服务和 LLM API

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

运行时配置中，HR小助手允许加入群聊，但群内消息必须显式 @ 机器人后才会回复（`groupPolicy: "open"` + `requireMention: true`）。

**Bot 4: HR管理后台（仅 HR 管理员）**

1. 同上流程创建第二个应用，命名 "HR管理后台"
2. 权限同上
3. 可用范围设为 **仅指定人员**（选择 HR 管理员）
4. 记录 `App ID` 和 `App Secret`
5. 发布应用

### 钉钉开放平台准备

部署前需在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建两个企业内部应用机器人，并将消息接收模式设为 **Stream 模式**。v1 只申请消息收发所需权限，不启用钉钉文档、日历、待办、DING 等额外能力。

**Bot 1: HR小助手（全员可用）**

1. 创建企业内部应用，命名 "HR小助手"
2. 添加「机器人」能力
3. 消息接收模式选择 **Stream 模式**
4. 权限管理中申请机器人消息接收/发送所需权限
5. 版本管理与发布 -> 可见范围设为 **全部员工**
6. 记录 `AppKey`（Client ID）和 `AppSecret`（Client Secret）
7. 发布应用

运行时配置中，HR小助手允许加入群聊，但群内消息必须显式 @ 机器人后才会回复（`groupPolicy: "open"` + `requireMention: true`）。

**Bot 2: HR管理后台（仅 HR 管理员）**

1. 同上流程创建第二个企业内部应用机器人，命名 "HR管理后台"
2. 消息接收模式选择 **Stream 模式**
3. 可见范围设为 **仅指定人员**（选择 HR 管理员）
4. 记录 `AppKey`（Client ID）和 `AppSecret`（Client Secret）
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

1. 检查 Node.js >= 24
2. 安装 OpenClaw（默认装 **npm `latest` 通道**；可用 `OPENCLAW_VERSION=2026.6.6` 锁定具体版本，或 `OPENCLAW_VERSION=beta` 用灰度版；最低兼容版本 `2026.5.26`，可用 `OPENCLAW_MIN_VERSION` 覆盖）。脚本会通过 `npm view` 解析 dist-tag 到具体版本号避免抖动，并在重启 systemd 前用新版本 `openclaw config validate` 校验现有 `openclaw.json`，校验失败则**不重启服务、保留旧版运行**。
3. 创建 `~/.openclaw/` 目录结构
4. 复制 workspace 文件到 `~/.openclaw/workspaces/`
5. 复制 skills 到 `~/.openclaw/skills/`
6. 编译配置 JSONC -> JSON 写入 `~/.openclaw/openclaw.json`
7. 复制 .env 模板
8. 通过飞书官方 CLI 的非交互更新命令安装插件（`OPENCLAW_STATE_DIR=... npx -y @larksuite/openclaw-lark update`）
9. 通过 OpenClaw 插件命令安装钉钉官方 connector（`openclaw plugins install @dingtalk-real-ai/dingtalk-connector`）
10. 安装 admin-server 依赖

系统模板（`hr-employee`/`hr-admin`）默认将 heartbeat 显式开启，公共 cadence 为 30 分钟，`target` 为 `none`，仅用于内部巡检与保活，不会直接向聊天渠道用户外发心跳消息；从模板招募的新员工沿用同一配置。

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
| `DINGTALK_HR_BOT_CLIENT_ID` | 钉钉 HR小助手 AppKey / Client ID |
| `DINGTALK_HR_BOT_CLIENT_SECRET` | 钉钉 HR小助手 AppSecret / Client Secret |
| `DINGTALK_ADMIN_BOT_CLIENT_ID` | 钉钉 HR管理后台 AppKey / Client ID |
| `DINGTALK_ADMIN_BOT_CLIENT_SECRET` | 钉钉 HR管理后台 AppSecret / Client Secret |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 认证 token（自定义长随机串） |
| `OPENCLAW_WEB_AUTH_TOKEN` | Admin Portal 认证 token |
| `FASTGPT_BASE_URL` | FastGPT 平台地址（如走 WireGuard 隧道：`http://10.99.0.1:3000`） |
| `FASTGPT_API_KEY` | FastGPT API Key（知识库导入/检索） |

### Step 3: 接入知识库（FastGPT，唯一源）

> ⚠️ **2026-06-19 更新**：此前版本描述的本地 `~/.openclaw/data/hr-policies/` 分类目录 + `categories.mjs` 自动分类已随 ADR-010 整体退役。**知识库唯一源是 FastGPT**，不再有本地 markdown 归档。

1. 部署/确认 FastGPT 栈（独立机器，详见 [yomajiahr-kb/00-overview/deployment-topology.md](https://github.com/MuYangJushi/yomajiahr-kb/blob/main/00-overview/deployment-topology.md) 附录「FastGPT 部署详情」）
2. 在 `~/.openclaw/.env` 配好 `FASTGPT_BASE_URL` / `FASTGPT_API_KEY`
3. 登录 Admin Portal → 「知识库」页 → 新建/选择知识库 → 上传 PDF/Word/文本/Markdown，FastGPT 原生解析（`create/localFile`）完成切片+向量化
4. 在「数字员工」页给需要检索的员工绑定该知识库（绑定后才会生成 `knowledge_search` 工具，见 ADR-011；无绑定→无工具）

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
cd /opt/yomajiahr/admin-server
OPENCLAW_STATE_DIR=~/.openclaw node --env-file=~/.openclaw/.env dist/server.js
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

### Admin Portal 扫码创建数字员工

数字员工页面的创建向导支持飞书和钉钉扫码创建应用，操作人必须具备 Admin Portal `ops` 或 `admin` 角色。
修改数字员工时，也可使用已有应用凭据同时接入一个尚未绑定的飞书或钉钉渠道；资料修改与渠道接入会作为同一事务应用和回滚。

- 飞书由 Admin Server 调用官方 Node SDK `registerApp()`。
- 钉钉由 Admin Server 执行 `init → begin → poll` Device Flow。
- 已有应用可通过手工凭证入口接入；凭证只随创建请求提交，不进入状态查询响应或浏览器持久存储。
- 浏览器轮询接口只返回 `id/status/message/qr_url/expires_at`，不会收到 `client_secret`、`device_code` 或内部配置草稿。
- 授权成功后，服务端将凭证直接写入 `~/.openclaw/.env`，动态配置只保存 `${VAR}` 引用。
- Agent workspace、已有技能、渠道账号和 binding 写入后，平台自动应用配置、重启网关并验证目标渠道；任一步失败都会恢复原配置。

相关接口：

```text
POST   /api/config/agent-onboarding
GET    /api/config/agent-onboarding/:id
DELETE /api/config/agent-onboarding/:id
```

---

## 目录结构

### 代码仓库

```
/opt/yomajiahr/
  install.sh
  config/
    openclaw.base.jsonc        # 静态基座
    config-store/              # 动态配置(agents/channels/bindings)
    .env.example                # 环境变量模板
    openclaw-gateway.service    # systemd 服务
    openclaw-admin.service
  workspaces/                   # Agent workspace 模板
  skills/                       # HR Skills
  admin-server/                 # Admin Web 服务
  docs/
```

### 运行时状态目录

```
~/.openclaw/
  openclaw.json                 # 运行时配置（由 install.sh / config 生成器编译）
  .env                          # API 密钥（含 FASTGPT_BASE_URL/FASTGPT_API_KEY）
  config-store/                 # 动态配置真相源
    agents.json                 # 数字员工（空白起步默认为空数组，见 ADR-014）
    channels.json               # 渠道账号资产
    bindings.json                # 员工↔渠道绑定
    knowledge.json               # 员工↔知识库绑定（运行期产物，首次绑库才出现）
  workspaces/
    <agentId>/                  # 每个数字员工一份，名字由招募时填的 ID 决定（不再固定 hr-assistant）
  skills/
    hr-policy-qa/
    hr-admin/
    hr-general/
  data/
    hr-admin/
      audit-log.jsonl           # 操作审计日志
```

> ❌ 已退役、不会再生成：`~/.openclaw/memory/`（语义索引）、`~/.openclaw/data/hr-policies/`、`~/.openclaw/data/hr-chunks/`——随 ADR-010/012 退役自研 RAG 层与本地 `memory_search` 回退链一起删除，知识库内容全部在 FastGPT 侧。

---

## 日常运维

### 更新代码

```bash
cd /opt/yomajiahr
git pull
./install.sh                    # 自动刷新已有 systemd unit，并重启更新前正在运行的服务
```

首次注册 systemd 服务仍使用 `./install.sh --systemd`。后续即使省略 `--systemd`，脚本检测到已有 `openclaw-gateway` 或 `openclaw-admin` unit 后也会刷新 unit，避免代码目录迁移后继续引用旧路径。

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
| 聊天 Bot 未响应 | `OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw channels status --probe` |
| Skills 未识别 | `OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw skills list` |
| 知识库搜不到文档 | 确认该数字员工在「知识库」页已绑定对应 FastGPT 库（无绑定→无 `knowledge_search` 工具）；确认 `FASTGPT_BASE_URL`/`FASTGPT_API_KEY` 配置正确、WireGuard 隧道可达 |
| Admin Portal 无法访问 | 确认端口 18790 开放；`journalctl -u openclaw-admin -n 100` |
| 审计日志为空 | 确认 `~/.openclaw/data/hr-admin/audit-log.jsonl` 存在且有写入权限 |
