# Yoma+HR 智能助手 — 部署指南

本文档覆盖从代码仓库到云服务器运行的完整流程。

> 品牌命名策略详见 [yomajiahr-branding.md](./yomajiahr-branding.md)。CLI 命令使用 `ymjhr`，环境变量名称保持上游 `OPENCLAW_*` 不变。

## 前置条件

### 服务器要求

- Linux（Ubuntu 22.04+ / Debian 12+ / CentOS 8+）或 macOS
- Node.js 22+
- pnpm 10+
- 内存 2GB+，磁盘 10GB+
- 网络：可出站访问飞书 API（`open.feishu.cn`）和 LLM API

### 飞书开放平台准备

部署前需在 [飞书开放平台](https://open.feishu.cn) 创建两个自建应用。

**Bot 1: HR小助手（全员可用）**

1. 创建企业自建应用，命名 "HR小助手"
2. 添加「机器人」能力
3. 权限管理 → 申请以下权限：
   - `im:message`（接收消息）
   - `im:message:send`（发送消息）
   - `im:resource`（访问资源）
   - `contact:user.id:readonly`（读取用户 ID）
4. 事件与回调 → 添加事件：`im.message.receive_v1`（接收消息事件）
5. 事件与回调 → 选择 **WebSocket** 连接方式
6. 版本管理与发布 → 可用范围设为 **全部员工**
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

### Step 1: 拉取代码

```bash
ssh user@your-server

git clone https://github.com/<your-username>/<your-repo>.git /opt/ymjhr
cd /opt/ymjhr
```

如果你打算用专用运行用户（推荐生产环境这样做），建议尽早创建 `ymjhr` 用户，
后续所有 `~/.ymjhr/*` 相关操作都在该用户下执行：

```bash
sudo useradd -r -m -s /bin/bash ymjhr
sudo mkdir -p /home/ymjhr/.ymjhr
sudo chown -R ymjhr:ymjhr /home/ymjhr/.ymjhr
sudo -iu ymjhr
```

进入后可用下面三条确认当前上下文已经切到运行用户：

```bash
whoami
echo $HOME
pwd
```

### Step 2: 安装依赖并构建

```bash
# 安装 Node.js 22+（如未安装）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 pnpm
npm install -g pnpm

# 安装项目依赖
pnpm install

# 构建
pnpm build

# 可选但推荐：构建 OpenClaw 内置 Control UI 资产
pnpm ui:build
```

构建产物在 `dist/` 目录。

`pnpm build` 足以让 gateway 和独立 `admin-portal` 运行；如果你还希望内置
Control UI 可用，或者不想在 gateway 启动日志里看到
`Missing Control UI assets at dist/control-ui/index.html`，就额外执行 `pnpm ui:build`。

### Step 2.5: 注册 ymjhr CLI 命令

构建完成后，将 `ymjhr` 注册到系统 PATH。

如果服务器上的 Node.js 是通过系统包安装的（例如 Ubuntu 上的 `/usr/bin/node`），通常需要使用 `sudo npm link`：

```bash
cd /opt/ymjhr
sudo npm link
```

验证命令可用：

```bash
ymjhr --version
```

> 如果服务器使用 `nvm` 管理 Node.js 版本，通常可以直接执行 `npm link`。
> 切换 Node.js 版本后需重新执行 `npm link`。

后续所有 CLI 操作均使用 `ymjhr` 命令（等同于原 `openclaw` 命令，子命令和参数完全一致）。

### Step 3: 创建运行时目录

**推荐方式：使用初始化脚本**

```bash
./scripts/init-workspace.sh
```

脚本会自动创建目录结构、复制 workspace bootstrap 文件（AGENTS.md、SOUL.md、IDENTITY.md）并生成 `.env` 模板。

**手动方式：**

```bash
# 创建 Yoma+HR 状态目录
mkdir -p ~/.ymjhr

# 创建已配置 agent 的 workspace（会放 AGENTS.md / MEMORY.md 等 bootstrap 文件）
mkdir -p ~/.ymjhr/workspace-hr-assistant
mkdir -p ~/.ymjhr/workspace-hr-admin

# 创建 memory search 索引目录
mkdir -p ~/.ymjhr/indexes

# 创建业务数据目录结构
mkdir -p ~/.ymjhr/data/hr-policies/{leave,onboarding,attendance,compensation,training,general}
mkdir -p ~/.ymjhr/data/hr-admin
```

当前模板会将已配置 agent 的 workspace 全部显式写到
`~/.ymjhr/workspace-<agentId>`，这样
workspace、sessions、memory 都集中在 `~/.ymjhr/` 下，便于统一备份和排障。

当前模板还会把 `hr-assistant` 的 memory search SQLite 索引显式放到
`~/.ymjhr/indexes/{agentId}.sqlite`，避免继续落回 OpenClaw 默认的
`~/.openclaw/memory/<agentId>.sqlite`，这样状态目录、知识库和索引都在同一套
`~/.ymjhr/` 目录树中，便于部署、备份和排障。

其中 `hr-assistant` 的 `memory_search` 需要通过
`agents.list[].memorySearch.extraPaths` 显式指向知识库目录。当前模板使用相对
workspace 的 `../data/hr-policies`，这样会稳定解析到
`~/.ymjhr/data/hr-policies`；不要在这里写 `~/.ymjhr/...`，因为该字段不会展开 `~`，
会被误当成相对路径，最终表现为知识库”空命中”。

当前模板还将 `hr-assistant.memorySearch.provider` 显式固定为
`openai`，但实际指向阿里百炼的 OpenAI-compatible embedding 接口：

- `model`: `text-embedding-v4`
- `remote.baseUrl`: `https://dashscope.aliyuncs.com/compatible-mode/v1`

这样知识库检索不会再依赖 auto-detect，也能避免在只配置 MiniMax 主模型时退回到效果很差的中文 FTS-only 路径。

另外，当前模板已显式设置：

- `memorySearch.enabled: true`
- `memorySearch.sources: ["memory"]`
- `memorySearch.experimental.sessionMemory: false`
- `memorySearch.sync.watch: true`
- `memorySearch.sync.onSessionStart: true`
- `memorySearch.query.hybrid.enabled: true`

这套配置的意图是：

- 只检索共享 memory 和正式知识库，不把员工会话历史混进政策检索
- 知识库文件变更后自动触发索引更新
- Agent 启动时先做一次索引同步，降低首次命中旧索引的概率
- 显式开启 hybrid 检索，兼顾关键词命中和语义相似度

如果你是通过 `sudo -iu ymjhr` 切进专用运行用户后执行这些命令，
这里的 `~/.ymjhr` 实际就是 `/home/ymjhr/.ymjhr`。

当前 Phase 1 运行配置启用了 `hr-assistant`（员工入口）和 `hr-admin`（管理入口）两个独立 Agent，不使用 Sub-agent。入离职和排班考勤等后续功能将以新增 Skill 的方式扩展到 `hr-assistant`。

### Step 4: 配置环境变量

```bash
cp config/.env.ymjhr.example ~/.ymjhr/.env
```

编辑 `~/.ymjhr/.env`，填入真实值：

```bash
nano ~/.ymjhr/.env
```

需要填写的关键值：

| 变量                          | 说明                                                 | 获取方式               |
| ----------------------------- | ---------------------------------------------------- | ---------------------- |
| `MINIMAX_API_KEY`             | MiniMax 国内站模型调用密钥（当前推荐）               | MiniMax 平台           |
| `MINIMAX_CODE_PLAN_KEY`       | MiniMax Coding Plan 用量查询密钥（可选，但建议填写） | MiniMax 平台           |
| `DASHSCOPE_API_KEY`           | `hr-assistant` 知识库 embedding 密钥（当前模板必填） | 阿里百炼 / DashScope   |
| `ANTHROPIC_API_KEY`           | 其他 LLM provider 的 API 密钥（按需填写）            | 从对应平台获取         |
| `OPENCLAW_GATEWAY_TOKEN`      | Gateway 访问令牌                                     | `openssl rand -hex 32` |
| `FEISHU_HR_BOT_APP_ID`        | HR小助手 App ID                                      | 飞书开放平台           |
| `FEISHU_HR_BOT_APP_SECRET`    | HR小助手 App Secret                                  | 飞书开放平台           |
| `FEISHU_ADMIN_BOT_APP_ID`     | HR管理后台 App ID                                    | 飞书开放平台           |
| `FEISHU_ADMIN_BOT_APP_SECRET` | HR管理后台 App Secret                                | 飞书开放平台           |
| `OPENCLAW_WEB_AUTH_TOKEN`     | Web Portal 认证令牌                                  | `openssl rand -hex 32` |

当前 `config/ymjhr.jsonc` 已默认指向 MiniMax 国内 Anthropic 兼容入口
`https://api.minimaxi.com/anthropic`，同时将 `hr-assistant` 的
`memorySearch.provider` 显式固定为阿里百炼的 OpenAI-compatible embedding 配置。
因此当前模板至少需要补：

- `MINIMAX_API_KEY`：主对话模型
- `DASHSCOPE_API_KEY`：政策知识库 embedding / 混合检索

如果你的 MiniMax 账号把“模型调用密钥”和 “Coding Plan 用量查询密钥”分开，保持：

- `MINIMAX_API_KEY` 用于实际模型调用
- `MINIMAX_CODE_PLAN_KEY` 用于 `/usage` 等额度查询

如果它们实际上是同一个 key，只填 `MINIMAX_API_KEY` 也可以工作。

如果你后续希望把知识库 embedding 换成 `OpenAI`、`gemini`、`voyage`、`mistral` 或 `ollama`，
请同步修改：

- `agents.list[].memorySearch.provider`
- `agents.list[].memorySearch.model`
- `agents.list[].memorySearch.remote`
- `~/.ymjhr/.env` 中对应 provider 的密钥

不要把 `hr-assistant.memorySearch.provider` 留给 `auto`，否则当主模型是 MiniMax、
但 embedding provider 未配置时，运行时会退回到 FTS-only；对于中文 HR 文档，
这通常会导致检索命中率明显下降。

如果后续接入其他模型，建议继续沿用：

- `models.mode: "merge"`，保留内置和已接入 provider
- `agents.defaults.model.primary` 指向当前主模型
- `agents.defaults.model.fallbacks` 追加备用模型
- 尽量不要过早设置 `agents.defaults.models` allowlist，否则每次新增模型都要同步维护

### Step 5: 写入配置

`init-workspace.sh` 会自动将 `config/ymjhr.jsonc` 转为 JSON 写入运行时目录。每次 `git pull` 后重新运行脚本即可同步配置变更：

```bash
./scripts/init-workspace.sh
```

脚本内部使用 Node 解析 JSONC（支持注释和尾随逗号），并注入 `gateway.mode`：

```bash
# 等效手动命令（脚本已自动执行，一般无需手动运行）
node -e "
const fs = require('fs');
const vm = require('vm');
const text = fs.readFileSync('config/ymjhr.jsonc', 'utf-8');
const sanitized = text
  .replace(/^\uFEFF/, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const json = vm.runInNewContext('(' + sanitized + ')', {});
json.gateway = { mode: 'local' };
fs.writeFileSync(
  process.env.HOME + '/.ymjhr/ymjhr.json',
  JSON.stringify(json, null, 2) + '\n'
);
console.log('Written to ~/.ymjhr/ymjhr.json');
"
```

或者手动创建 `~/.ymjhr/ymjhr.json`。当前模板已经兼容现有 schema，只需保留顶层 `"web"`、`"channels"`、`"agents"` 等节点，并添加 `"gateway": { "mode": "local" }`。当前模板已将各 agent 的 workspace 显式配置为 `~/.ymjhr/workspace-<agentId>`。

如果你需要改默认模型或增加 fallback，直接编辑 `agents.defaults.model`；如果要接新主模型 provider，则在 `models.providers` 下继续追加对应配置块即可。知识库 embedding 则单独维护在 `hr-assistant.memorySearch` 下，不和主对话模型绑定。

当前模板还包含两条显式 Feishu account 路由：

- `feishu / hr-assistant` -> `hr-assistant`
- `feishu / hr-admin` -> `hr-admin`

这样管理员 Bot 不会误落到默认的 `hr-assistant`。

### Step 6: 安装 Skills

Skills 通过目录发现机制加载。引擎按以下优先级扫描 `SKILL.md`：

1. `<workspace>/skills/`（最高）
2. `~/.ymjhr/skills/`（托管目录）
3. 内置 bundled skills（最低）

由于我们从仓库运行，`skills/` 目录已在工作区中，**默认不需要额外操作**。
在 systemd 中将 `WorkingDirectory` 设为 `/opt/ymjhr` 后，gateway 会直接从仓库根目录发现这些 skills。

如果你确实需要把 skills 复制到托管目录，请直接复制目录；不建议在 `~/.ymjhr/skills` 下放指向仓库外部的软链接，当前技能加载器会跳过这类路径。

```bash
# 可选：复制一份到托管目录
mkdir -p ~/.ymjhr/skills
cp -r /opt/ymjhr/skills/hr-policy-qa   ~/.ymjhr/skills/
cp -r /opt/ymjhr/skills/hr-general     ~/.ymjhr/skills/
cp -r /opt/ymjhr/skills/hr-admin       ~/.ymjhr/skills/
```

验证 skills 已被识别：

```bash
ymjhr skills list
```

应看到 `hr-policy-qa`、`hr-general`、`hr-admin` 三个 skill。

### Step 7: 准备空知识库并导入真实政策文档

运行时知识库初始保持为空，由管理员后续导入真实文档：

```bash
mkdir -p ~/.ymjhr/data/hr-policies/{leave,onboarding,attendance,compensation,training,general}
mkdir -p ~/.ymjhr/data/hr-admin
```

实际政策文档可通过以下方式导入：

```bash
# 单个文档（支持 pdf / docx / txt / md）
node skills/hr-admin/scripts/doc-to-markdown.mjs policy.pdf \
  --out-dir ~/.ymjhr/data/hr-policies/

# 批量文档（整个目录）
node skills/hr-admin/scripts/doc-to-markdown.mjs ./docs/ \
  --out-dir ~/.ymjhr/data/hr-policies/
```

命令行脚本也会自动把文档转成 Markdown，并尝试用当前默认模型分析 `doc_id`、`version`、`effective_date` 和分类；如果模型暂时不可用，会回退到规则兜底。

### Step 8: 安装并启动 Admin Portal

Admin Portal 是独立的 Web 管理后台，提供文档上传（PDF/Word/文本）、文档管理和审计日志功能。上传时会自动分析分类、文档编号、版本号和生效日期，无需管理员手填。

```bash
cd /opt/ymjhr/admin-portal

# 安装依赖
npm install

# 前台运行（首次调试）
OPENCLAW_WEB_AUTH_TOKEN=$(grep OPENCLAW_WEB_AUTH_TOKEN ~/.ymjhr/.env | cut -d= -f2) \
  node server.mjs

# 后台运行（生产用）
OPENCLAW_WEB_AUTH_TOKEN=$(grep OPENCLAW_WEB_AUTH_TOKEN ~/.ymjhr/.env | cut -d= -f2) \
  nohup node server.mjs > /tmp/ymjhr-admin.log 2>&1 &

# 查看日志
tail -f /tmp/ymjhr-admin.log
```

默认端口 **18790**（可通过 `ADMIN_PORTAL_PORT` 环境变量修改）。

Admin Portal 页面：

| 页面     | URL                                | 功能                                        |
| -------- | ---------------------------------- | ------------------------------------------- |
| 文档上传 | `http://<server>:18790/#upload`    | 拖拽上传 PDF/Word/文本，自动转换为 Markdown |
| 文档管理 | `http://<server>:18790/#documents` | 查看、搜索、删除知识库文档                  |
| 审计日志 | `http://<server>:18790/#audit-log` | 操作记录查看、筛选、CSV 导出                |

### Step 9: 启动 Gateway

```bash
cd /opt/ymjhr

# 设置状态目录和配置路径（指向 ymjhr 目录）
export OPENCLAW_STATE_DIR=~/.ymjhr
export OPENCLAW_CONFIG_PATH=~/.ymjhr/ymjhr.json

# 前台运行（首次调试用，看实时日志）
ymjhr gateway run --bind loopback --port 18789

# 后台运行（生产用）
nohup ymjhr gateway run --bind loopback --port 18789 --force \
  > /tmp/ymjhr-gateway.log 2>&1 &

# 查看日志
tail -f /tmp/ymjhr-gateway.log
```

### Step 10: 验证部署

```bash
# 1. Gateway 健康检查
curl http://127.0.0.1:18789/healthz

# 2. Admin Portal 健康检查
curl http://127.0.0.1:18790/api/health

# 3. 端口监听
ss -ltnp | grep -E '18789|18790'

# 4. Channel 连接状态
ymjhr channels status --probe

# 5. Skills 列表
ymjhr skills list

# 6. 验证知识库 embedding 路径解析正确
#    hr-assistant 的 workspace 在 ~/.ymjhr/workspace-hr-assistant，
#    extraPaths 配置为 ../data/hr-policies，因此实际指向 ~/.ymjhr/data/hr-policies
ls ~/.ymjhr/data/hr-policies/
```

如果你刚刚重启过 `ymjhr-gateway`，建议先等 5 到 10 秒再做健康检查；启动早期日志里短暂出现
`force: no listeners on port 18789` 属于热启动窗口，单独出现不代表失败。

然后在飞书中测试：

| 测试         | 操作                                   | 预期结果                     |
| ------------ | -------------------------------------- | ---------------------------- |
| 政策问答     | 给 HR小助手 发 "年假怎么算"            | 返回年假政策 + 文档引用      |
| 未命中       | 给 HR小助手 发 "量子力学是什么"        | 返回非 HR 相关提示           |
| 管理员       | 给 HR管理后台 发 "列出所有文档"        | 返回知识库文档列表           |
| Web Portal   | 浏览器访问 `http://<server>:18789/web` | 聊天式管理后台可用           |
| Admin Portal | 浏览器访问 `http://<server>:18790`     | 文档上传/管理/审计日志页面   |
| 文档上传     | Admin Portal 拖拽上传 PDF              | 转换成功，文档出现在文档列表 |

---

## 生产环境加固

### 使用 systemd 管理服务

模板文件在 `config/ymjhr-gateway.service` 和 `config/ymjhr-admin.service`，可直接复制或按需修改后安装：

```bash
sudo cp config/ymjhr-gateway.service /etc/systemd/system/
sudo cp config/ymjhr-admin.service /etc/systemd/system/
```

或者内联创建：

```bash
sudo cat > /etc/systemd/system/ymjhr-gateway.service << 'EOF'
[Unit]
Description=Yoma+HR Gateway
After=network.target

[Service]
Type=simple
User=ymjhr
Group=ymjhr
WorkingDirectory=/opt/ymjhr
ExecStart=/usr/bin/ymjhr gateway run --bind loopback --port 18789 --force
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=OPENCLAW_STATE_DIR=/home/ymjhr/.ymjhr
Environment=OPENCLAW_CONFIG_PATH=/home/ymjhr/.ymjhr/ymjhr.json
EnvironmentFile=/home/ymjhr/.ymjhr/.env

[Install]
WantedBy=multi-user.target
EOF

sudo cat > /etc/systemd/system/ymjhr-admin.service << 'EOF'
[Unit]
Description=Yoma+HR Admin Portal
After=network.target

[Service]
Type=simple
User=ymjhr
Group=ymjhr
WorkingDirectory=/opt/ymjhr/admin-portal
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=ADMIN_PORTAL_PORT=18790
Environment=OPENCLAW_STATE_DIR=/home/ymjhr/.ymjhr
EnvironmentFile=/home/ymjhr/.ymjhr/.env

[Install]
WantedBy=multi-user.target
EOF

# 创建专用用户
sudo useradd -r -m -s /bin/bash ymjhr
sudo cp -r ~/.ymjhr /home/ymjhr/.ymjhr
sudo chown -R ymjhr:ymjhr /home/ymjhr/.ymjhr

# 注册 CLI 命令
# 如果 Node.js 来自系统包（/usr/bin/node），这里通常需要 sudo npm link
cd /opt/ymjhr
sudo npm link

# 启动并设置开机自启
sudo systemctl daemon-reload
sudo systemctl enable --now ymjhr-gateway ymjhr-admin
sudo systemctl status ymjhr-gateway ymjhr-admin

# 查看日志
sudo journalctl -u ymjhr-gateway -f
sudo journalctl -u ymjhr-admin -f
```

### Nginx 反向代理

```nginx
# Yoma+HR Web Portal（聊天式管理）
server {
    listen 443 ssl;
    server_name hr-chat.yourcompany.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# Yoma+HR Admin Portal（文档管理 + 审计日志）
server {
    listen 443 ssl;
    server_name hr-admin.yourcompany.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    client_max_body_size 10m;   # 文件上传大小限制

    location / {
        proxy_pass http://127.0.0.1:18790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 更新部署

代码更新后在服务器上执行：

```bash
cd /opt/ymjhr
git pull origin main
pnpm install
pnpm build
pnpm ui:build  # 推荐：同步更新内置 Control UI 资产
sudo npm link  # 确保 ymjhr CLI 指向最新构建（系统包 Node.js 场景）

# 重启服务
sudo systemctl restart ymjhr-gateway
sudo systemctl restart ymjhr-admin
```

如果仅更新了 skills（SKILL.md / references / assets），不需要重新 build，重启 gateway 即可。
如果仅更新了 admin-portal，不需要 build，重启 admin-portal 服务即可。
如果只改了 OpenClaw 内置 Control UI 前端，再额外执行 `pnpm ui:build` 并重启 gateway。

如果服务器已经通过 `systemd` 托管 `ymjhr-gateway` / `ymjhr-admin`，后续请统一使用
`systemctl` 管理服务，不要再混用手工 `nohup ymjhr gateway run ...` 或
`nohup node server.mjs ...`。混用后最常见的问题是端口冲突、日志分散到多处，以及很难判断当前到底是哪一套进程在提供服务。

---

## 目录结构总览

```
服务器文件布局:

/opt/ymjhr/                             # 代码仓库（git clone）
├── skills/
│   ├── hr-policy-qa/                    # 政策问答 skill（hr-assistant 使用）
│   ├── hr-general/                      # 通用 HR 对话 skill（hr-assistant 使用）
│   └── hr-admin/                        # 管理员 skill（hr-admin 使用）
├── workspace-hr-assistant/              # hr-assistant workspace 源文件
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   └── CLAUDE.md -> AGENTS.md
├── workspace-hr-admin/                  # hr-admin workspace 源文件
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   └── CLAUDE.md -> AGENTS.md
├── scripts/
│   └── init-workspace.sh               # 初始化/同步运行时目录
├── admin-portal/                        # Admin Portal 独立 Web 服务
│   ├── server.mjs                       # Express 服务端
│   ├── lib/doc-converter.mjs            # 多格式文档转换器
│   ├── public/                          # 前端页面 (HTML/CSS/JS)
│   ├── package.json                     # 独立依赖 (mammoth, multer 等)
│   └── node_modules/                    # npm install 后生成
├── config/
│   ├── .env.ymjhr.example              # 环境变量模板
│   └── ymjhr.jsonc                     # 配置模板（由 init-workspace.sh 同步到运行时）
├── docs/                                # 部署与架构文档
└── dist/                                # 构建产物（pnpm build 后生成）

~/.ymjhr/                               # Yoma+HR 运行时状态目录
├── .env                                 # 环境变量（密钥，不入库）
├── ymjhr.json                          # 运行时配置（由 init-workspace.sh 从 config/ymjhr.jsonc 同步）
├── workspace-hr-assistant/              # hr-assistant workspace（由 init-workspace.sh 从源文件同步）
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   └── CLAUDE.md -> AGENTS.md
├── workspace-hr-admin/                  # hr-admin workspace（由 init-workspace.sh 从源文件同步）
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   └── CLAUDE.md -> AGENTS.md
└── memory/
    ├── hr-admin/
    │   └── audit-log.jsonl              # 操作审计日志（JSONL 格式）
    └── hr-policies/                     # 知识库文档（运行时数据）
        ├── leave/
        ├── onboarding/
        ├── attendance/
        ├── compensation/
        ├── training/
        └── general/
```

这些分类目录在初始部署时可以为空，等管理员通过 `admin-portal` 或 `hr-admin` 导入真实文档后再出现具体文件。

如果后续新增命名 agent，建议继续显式配置为：

```text
~/.ymjhr/workspace-<agentId>
```

---

## systemd 运维速查

以下内容默认服务器已经按本文前面的方式安装了 `ymjhr-gateway.service` 和
`ymjhr-admin.service`。

### 账号与权限边界

- 推荐使用 `ubuntu` 等管理员账号登录服务器，再通过 `sudo` 管理服务。
- 建议继续让 `ymjhr` 只作为运行账号，不直接授予 `sudo`。
- `sudo systemctl start|stop|restart ymjhr-gateway` 是由 `ubuntu` 发起控制动作，但服务进程本身仍以 `ymjhr` 身份运行，因为 unit 文件中显式配置了 `User=ymjhr` 和 `Group=ymjhr`。
- `ymjhr` 适合用于运行应用级检查命令，例如 `sudo -iu ymjhr ymjhr channels status --probe`。

### 标准服务管理命令

```bash
sudo systemctl status ymjhr-gateway --no-pager
sudo systemctl status ymjhr-admin --no-pager

sudo systemctl start ymjhr-gateway
sudo systemctl start ymjhr-admin

sudo systemctl stop ymjhr-gateway
sudo systemctl stop ymjhr-admin

sudo systemctl restart ymjhr-gateway
sudo systemctl restart ymjhr-admin

sudo systemctl is-enabled ymjhr-gateway
sudo systemctl is-enabled ymjhr-admin
```

### 标准日志查看方式

如果服务由 `systemd` 托管，优先看 `journalctl`：

```bash
sudo journalctl -u ymjhr-gateway -n 100 --no-pager
sudo journalctl -u ymjhr-admin -n 100 --no-pager

sudo journalctl -u ymjhr-gateway -f
sudo journalctl -u ymjhr-admin -f
```

补充说明：

- `journalctl` 日志不是单独的应用文件，通常由 `systemd-journald` 存放在 `/var/log/journal/` 或 `/run/log/journal/`。
- `ubuntu` 这类有 `sudo` 的管理员账号可以直接查看 `journalctl`。
- `ymjhr` 通常可以查看自己生成的普通文件日志，但默认不一定有权限直接查看完整 systemd journal。

### 其他常见日志位置

- Gateway 手工 `nohup` 日志：`/tmp/ymjhr-gateway.log`
- Admin Portal 手工 `nohup` 日志：`/tmp/ymjhr-admin.log`
- 结构化文件日志默认路径：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Admin Portal 操作审计日志：`~/.ymjhr/data/hr-admin/audit-log.jsonl`

其中：

- `/tmp/ymjhr-gateway.log` 和 `/tmp/ymjhr-admin.log` 只在手工 `nohup` 启动时出现或持续更新。
- `/tmp/openclaw/openclaw-YYYY-MM-DD.log` 是 Gateway 自身的结构化文件日志，和 `journalctl` 不是一回事。
- Admin Portal 页面 `/#audit-log` 查询的是 `audit-log.jsonl` 里的业务操作审计，不是 systemd 运行日志，也不是 Gateway 的完整报错日志。

### 应用级健康检查

```bash
sudo -iu ymjhr ymjhr channels status --probe
sudo -iu ymjhr ymjhr skills list
curl http://127.0.0.1:18789/healthz
ss -ltnp | grep -E '18789|18790'
```

### 验证当前到底是不是 systemd 在托管

```bash
sudo systemctl is-active ymjhr-gateway ymjhr-admin
sudo systemctl status ymjhr-gateway ymjhr-admin --no-pager
ps -eo user,pid,cmd | grep 'ymjhr gateway run' | grep -v grep
ps -eo user,pid,cmd | grep 'server.mjs' | grep -v grep
```

判断规则：

- `systemctl status` 显示 `active (running)`，说明当前由 `systemd` 托管。
- `ps` 中对应进程的用户应为 `ymjhr`。
- 如果 `systemd` 已在托管，就不要再单独执行 `ymjhr gateway run` 或 `nohup node server.mjs`。

### 关于 `ymjhr` CLI 与 systemd 的关系

- `ymjhr gateway run` 会直接启动前台进程，不应与已托管的 systemd 服务混用。
- 如需启停 systemd 服务，请使用 `sudo systemctl ...`，不要用手工 `run` 代替。
- 混用最常见的后果是端口被抢占、`--force` 杀掉现有监听、日志同时写入 `journalctl` 和 `/tmp/*.log`，后续排障会非常混乱。

---

## 故障排查

| 问题                             | 排查方法                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Gateway 启动失败                 | `tail -n 100 /tmp/ymjhr-gateway.log` 或 `journalctl -u ymjhr-gateway -n 100` |
| 飞书连接不上                     | 检查 App ID/Secret 是否正确；确认应用已发布；检查 WebSocket 模式已启用       |
| Skills 未识别                    | `ymjhr skills list` 确认三个 skill 出现；检查软链接是否正确                  |
| 知识库搜不到文档                 | 确认 `~/.ymjhr/data/hr-policies/` 下有 .md 文件且含正确 frontmatter          |
| LLM 无响应                       | 检查 `.env` 中 API key 是否正确；`curl` 测试 API 可达性                      |
| Web Portal 无法访问              | 确认防火墙开放 18789 端口；检查 `ymjhr.json` 中 `web.enabled: true`          |
| Admin Portal 无法访问            | 确认端口 18790 开放；`tail -n 100 /tmp/ymjhr-admin.log` 查看日志             |
| Gateway 提示缺少 Control UI 资产 | 在 `/opt/ymjhr` 执行 `pnpm ui:build`，然后重启 `ymjhr-gateway`               |
| 文档上传失败                     | 检查文件格式是否支持（PDF/docx/txt/md）；检查文件大小不超过 10MB             |
| 审计日志为空                     | 确认 `~/.ymjhr/data/hr-admin/audit-log.jsonl` 文件存在且有写入权限           |

## 异常排查顺序

下面这套顺序适合绝大多数线上问题。建议先确认“服务是否在跑”，再确认“端口和日志”，最后再检查应用配置、渠道连接和业务数据。

### 1. 服务起不来或刚重启后状态异常

```bash
sudo systemctl status ymjhr-gateway --no-pager
sudo systemctl status ymjhr-admin --no-pager
sudo journalctl -u ymjhr-gateway -n 100 --no-pager
sudo journalctl -u ymjhr-admin -n 100 --no-pager
```

先看是否存在以下问题：

- unit 配置错误
- `ExecStart` 路径失效
- Node.js / `ymjhr` 命令不可用
- `.env`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 路径错误
- 配置 schema 校验失败

如果这里已经报错，不要先去看前端页面或飞书消息，先把服务拉起来。

### 2. 服务显示在跑，但端口没监听或页面打不开

```bash
ss -ltnp | grep -E '18789|18790'
curl http://127.0.0.1:18789/healthz
sudo journalctl -u ymjhr-gateway -n 100 --no-pager
sudo journalctl -u ymjhr-admin -n 100 --no-pager
```

重点判断：

- 18789 是否由 gateway 监听
- 18790 是否由 admin-portal 监听
- 服务是否反复重启
- Nginx 或安全组是否挡住了外部访问

### 3. gateway 在跑，但飞书机器人不回复

```bash
sudo -iu ymjhr ymjhr channels status --probe
sudo journalctl -u ymjhr-gateway -n 200 --no-pager
```

重点检查：

- 飞书 `App ID` / `App Secret` 是否正确
- 对应应用是否已发布
- WebSocket 模式是否启用
- `bindings` 是否把账号正确绑定到 agent
- LLM provider 的 API key 是否可用

### 4. Admin Portal 能打开，但上传、删除、审计页面异常

```bash
sudo journalctl -u ymjhr-admin -n 200 --no-pager
ls -l /home/ymjhr/.ymjhr/data/hr-admin/audit-log.jsonl
find /home/ymjhr/.ymjhr/data/hr-policies -maxdepth 2 -type f | head
```

重点检查：

- `~/.ymjhr/data/hr-admin/` 是否可写
- `~/.ymjhr/data/hr-policies/` 是否存在且权限正确
- 上传文件格式和大小是否符合约束
- `OPENCLAW_WEB_AUTH_TOKEN` 是否与当前访问方式一致

### 5. skills 或知识库表现异常

```bash
sudo -iu ymjhr ymjhr skills list
find /home/ymjhr/.ymjhr/data/hr-policies -type f | head -n 20
```

重点检查：

- skills 是否被正确发现
- 知识库 Markdown 是否真的落盘
- frontmatter 是否完整
- agent workspace 和 `memorySearch.extraPaths` 是否指向正确目录

### 6. 想确认日志到底该看哪一套

```bash
sudo systemctl status ymjhr-gateway --no-pager
sudo journalctl -u ymjhr-gateway -n 50 --no-pager
ls -l /tmp/ymjhr-gateway.log /tmp/ymjhr-admin.log
ls -lt /tmp/openclaw/ | head
```

判断规则：

- `systemd` 在托管：优先看 `journalctl`
- `/tmp/ymjhr-*.log` 有持续更新：说明还存在手工 `nohup` 启动痕迹
- `/tmp/openclaw/openclaw-YYYY-MM-DD.log`：看结构化业务日志和更细粒度事件

### 7. 排查时的通用原则

- 先确认服务状态，再看端口，再看日志，再看业务配置。
- 不要一边 `systemctl restart`，一边又手工 `ymjhr gateway run`。
- 发现日志来源不一致时，先确认当前是否只有一套进程在跑。
- 需要做应用级检查时，用 `sudo -iu ymjhr ...`；需要管服务时，用 `sudo systemctl ...`。
