# HR 智能助手 — 部署指南

本文档覆盖从代码仓库到云服务器运行的完整流程。

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

git clone https://github.com/<your-username>/<your-repo>.git /opt/hr-assistant
cd /opt/hr-assistant
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
```

构建产物在 `dist/` 目录。

### Step 3: 创建运行时目录

```bash
# 创建 OpenClaw 状态目录
mkdir -p ~/.openclaw

# 创建知识库目录结构
mkdir -p ~/.openclaw/memory/hr-policies/{leave,onboarding,attendance,compensation,training,general}
```

### Step 4: 配置环境变量

```bash
cp config/.env.hr-assistant.example ~/.openclaw/.env
```

编辑 `~/.openclaw/.env`，填入真实值：

```bash
nano ~/.openclaw/.env
```

需要填写的关键值：

| 变量                                    | 说明                     | 获取方式               |
| --------------------------------------- | ------------------------ | ---------------------- |
| `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` | LLM API 密钥（至少一个） | 从对应平台获取         |
| `OPENCLAW_GATEWAY_TOKEN`                | Gateway 访问令牌         | `openssl rand -hex 32` |
| `FEISHU_HR_BOT_APP_ID`                  | HR小助手 App ID          | 飞书开放平台           |
| `FEISHU_HR_BOT_APP_SECRET`              | HR小助手 App Secret      | 飞书开放平台           |
| `FEISHU_ADMIN_BOT_APP_ID`               | HR管理后台 App ID        | 飞书开放平台           |
| `FEISHU_ADMIN_BOT_APP_SECRET`           | HR管理后台 App Secret    | 飞书开放平台           |
| `OPENCLAW_WEB_AUTH_TOKEN`               | Web Portal 认证令牌      | `openssl rand -hex 32` |

### Step 5: 写入 OpenClaw 配置

将 `config/openclaw.hr-assistant.jsonc` 转为 JSON 写入配置目录：

```bash
# 去掉 JSONC 注释，生成标准 JSON
node -e "
const fs = require('fs');
const text = fs.readFileSync('config/openclaw.hr-assistant.jsonc', 'utf-8');
const cleaned = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const json = JSON.parse(cleaned);
json.gateway = { mode: 'local' };
fs.writeFileSync(process.env.HOME + '/.openclaw/openclaw.json', JSON.stringify(json, null, 2));
console.log('Written to ~/.openclaw/openclaw.json');
"
```

或者手动创建 `~/.openclaw/openclaw.json`（参考 `config/openclaw.hr-assistant.jsonc`，去掉注释，添加 `"gateway": { "mode": "local" }`）。

### Step 6: 安装 Skills

Skills 通过目录发现机制加载。OpenClaw 按以下优先级扫描 `SKILL.md`：

1. `<workspace>/skills/`（最高）
2. `~/.openclaw/skills/`（托管目录）
3. 内置 bundled skills（最低）

由于我们从仓库运行，`skills/` 目录已在工作区中，**理论上不需要额外操作**。但为确保 gateway 以任意工作目录启动时都能找到 skills，建议同时链接到托管目录：

```bash
# 方式 A: 软链接（推荐，保持同步）
ln -s /opt/hr-assistant/skills/hr-assistant   ~/.openclaw/skills/hr-assistant
ln -s /opt/hr-assistant/skills/hr-policy-rag  ~/.openclaw/skills/hr-policy-rag
ln -s /opt/hr-assistant/skills/hr-admin       ~/.openclaw/skills/hr-admin

# 方式 B: 直接复制（不需要保持同步时）
cp -r /opt/hr-assistant/skills/hr-assistant   ~/.openclaw/skills/
cp -r /opt/hr-assistant/skills/hr-policy-rag  ~/.openclaw/skills/
cp -r /opt/hr-assistant/skills/hr-admin       ~/.openclaw/skills/
```

验证 skills 已被识别：

```bash
cd /opt/hr-assistant
node dist/index.js skills list
```

应看到 `hr-assistant`、`hr-policy-rag`、`hr-admin` 三个 skill。

### Step 7: 导入政策文档到知识库

将示例政策文档复制到运行时知识库目录：

```bash
cp skills/hr-policy-rag/assets/sample-policies/leave/*.md     ~/.openclaw/memory/hr-policies/leave/
cp skills/hr-policy-rag/assets/sample-policies/onboarding/*.md ~/.openclaw/memory/hr-policies/onboarding/
```

后续实际 PDF 政策文档可通过以下方式导入：

```bash
# 单个 PDF
node skills/hr-policy-rag/scripts/pdf-to-markdown.mjs policy.pdf \
  --out-dir ~/.openclaw/memory/hr-policies/ \
  --category leave

# 批量 PDF（整个目录）
node skills/hr-policy-rag/scripts/pdf-to-markdown.mjs ./pdfs/ \
  --out-dir ~/.openclaw/memory/hr-policies/ \
  --category onboarding
```

转换后需编辑 Markdown frontmatter，补充 `doc_id`、`version`、`effective_date`。

### Step 8: 启动 Gateway

```bash
cd /opt/hr-assistant

# 前台运行（首次调试用，看实时日志）
node dist/index.js gateway run --bind loopback --port 18789

# 后台运行（生产用）
nohup node dist/index.js gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &

# 查看日志
tail -f /tmp/openclaw-gateway.log
```

### Step 9: 验证部署

```bash
# 1. 健康检查
curl http://127.0.0.1:18789/healthz

# 2. Channel 连接状态
node dist/index.js channels status --probe

# 3. Skills 列表
node dist/index.js skills list
```

然后在飞书中测试：

| 测试       | 操作                                   | 预期结果                |
| ---------- | -------------------------------------- | ----------------------- |
| 政策问答   | 给 HR小助手 发 "年假怎么算"            | 返回年假政策 + 文档引用 |
| 未命中     | 给 HR小助手 发 "量子力学是什么"        | 返回非 HR 相关提示      |
| 管理员     | 给 HR管理后台 发 "列出所有文档"        | 返回知识库文档列表      |
| Web Portal | 浏览器访问 `http://<server>:18789/web` | 管理后台可用            |

---

## 生产环境加固

### 使用 systemd 管理服务

```bash
sudo cat > /etc/systemd/system/openclaw-hr.service << 'EOF'
[Unit]
Description=OpenClaw HR Assistant Gateway
After=network.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/hr-assistant
ExecStart=/usr/bin/node dist/index.js gateway run --bind loopback --port 18789 --force
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=OPENCLAW_STATE_DIR=/home/openclaw/.openclaw
EnvironmentFile=/home/openclaw/.openclaw/.env

[Install]
WantedBy=multi-user.target
EOF

# 创建专用用户
sudo useradd -r -m -s /bin/bash openclaw
sudo cp -r ~/.openclaw /home/openclaw/.openclaw
sudo chown -R openclaw:openclaw /home/openclaw/.openclaw

# 启动并设置开机自启
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-hr
sudo systemctl status openclaw-hr

# 查看日志
sudo journalctl -u openclaw-hr -f
```

### Nginx 反向代理（Web Portal 对外暴露时）

```nginx
server {
    listen 443 ssl;
    server_name hr-admin.yourcompany.com;

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
```

---

## 更新部署

代码更新后在服务器上执行：

```bash
cd /opt/hr-assistant
git pull origin main
pnpm install
pnpm build

# 重启服务
sudo systemctl restart openclaw-hr
# 或手动重启
pkill -f "node dist/index.js gateway" || true
nohup node dist/index.js gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &
```

如果仅更新了 skills（SKILL.md / references / assets），不需要重新 build，重启 gateway 即可。

---

## 目录结构总览

```
服务器文件布局:

/opt/hr-assistant/                    # 代码仓库（git clone）
├── skills/
│   ├── hr-assistant/                 # 全员 Agent skill
│   ├── hr-policy-rag/                # 政策问答 skill + PDF 转换脚本
│   └── hr-admin/                     # 管理员 skill
├── config/
│   ├── .env.hr-assistant.example     # 环境变量模板
│   └── openclaw.hr-assistant.jsonc   # 配置模板
└── dist/                             # 构建产物（pnpm build 后生成）

~/.openclaw/                          # OpenClaw 运行时状态目录
├── .env                              # 环境变量（密钥，不入库）
├── openclaw.json                     # 运行时配置
├── skills/                           # skills 软链接
│   ├── hr-assistant -> /opt/hr-assistant/skills/hr-assistant
│   ├── hr-policy-rag -> /opt/hr-assistant/skills/hr-policy-rag
│   └── hr-admin -> /opt/hr-assistant/skills/hr-admin
└── memory/
    └── hr-policies/                  # 知识库文档（运行时数据）
        ├── leave/
        │   ├── annual-leave-policy.md
        │   └── sick-leave-policy.md
        ├── onboarding/
        │   └── probation-policy.md
        ├── attendance/
        ├── compensation/
        ├── training/
        └── general/
```

---

## 故障排查

| 问题                | 排查方法                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| Gateway 启动失败    | `tail -n 100 /tmp/openclaw-gateway.log` 或 `journalctl -u openclaw-hr -n 100` |
| 飞书连接不上        | 检查 App ID/Secret 是否正确；确认应用已发布；检查 WebSocket 模式已启用        |
| Skills 未识别       | `node dist/index.js skills list` 确认三个 skill 出现；检查软链接是否正确      |
| 知识库搜不到文档    | 确认 `~/.openclaw/memory/hr-policies/` 下有 .md 文件且含正确 frontmatter      |
| LLM 无响应          | 检查 `.env` 中 API key 是否正确；`curl` 测试 API 可达性                       |
| Web Portal 无法访问 | 确认防火墙开放 18789 端口；检查 `openclaw.json` 中 `web.enabled: true`        |
