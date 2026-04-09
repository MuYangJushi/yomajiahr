# install.sh 远程部署改造方案

本文档记录 install.sh 支持"一条命令从 GitHub 远程部署"的改造内容。

## 改造目标

在全新 Ubuntu 24 服务器上，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/MorrisYangJushi/yomajiahr/main/install.sh | bash -s -- --systemd
```

即可完成完整部署，无需预先 git clone 或手动安装任何依赖。

---

## 改动文件

| 文件 | 改动内容 |
|------|----------|
| `install.sh` | 新增 Step 0：前置依赖检查 + 远程执行检测 + 自动克隆；systemd 安装改为动态路径替换 |
| `config/openclaw-gateway.service` | 新增 `Environment=PATH=...` |
| `config/openclaw-admin.service` | 新增 `Environment=PATH=...` |
| `docs/deployment.md` | 顶部新增"一条命令部署"章节 |

---

## install.sh 核心改动

### Step 0：前置依赖 + 远程检测（新增）

**前置依赖安装**：在 Linux/apt 环境下，若 curl 或 git 缺失，自动安装：

```bash
if [ "$(uname)" = "Linux" ] && command -v apt-get &>/dev/null; then
  NEED_PKGS=""
  command -v curl &>/dev/null || NEED_PKGS="$NEED_PKGS curl"
  command -v git  &>/dev/null || NEED_PKGS="$NEED_PKGS git"
  if [ -n "$NEED_PKGS" ]; then
    sudo apt-get update -qq && sudo apt-get install -y $NEED_PKGS
  fi
fi
```

**远程检测 + 自动克隆**：当脚本通过 `curl | bash` 执行时，`workspaces/` 和 `skills/` 不存在于当前目录，据此判断为远程模式，自动克隆仓库并 `exec` 重新执行：

```bash
if [ ! -d "$REPO_DIR/workspaces" ] || [ ! -d "$REPO_DIR/skills" ]; then
  sudo git clone "$GITHUB_REPO_URL" "$INSTALL_DIR"
  sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  exec "$INSTALL_DIR/install.sh" "$@"
fi
```

`exec` 替换当前进程，重新执行后 `REPO_DIR` 正确指向克隆目录，后续步骤正常运行。

### systemd 安装：动态路径替换（改造）

原来直接 `sudo cp` 模板文件，路径硬编码为 `/opt/yomajiahr` 和 `/home/ubuntu`。改为用 `sed` 在写入时替换：

```bash
_install_service() {
  local src="$1" dst="$2"
  sed \
    -e "s|/opt/yomajiahr|$REPO_DIR|g" \
    -e "s|/home/ubuntu/.openclaw|$STATE_DIR|g" \
    -e "s|/usr/bin/env openclaw|$OPENCLAW_BIN|g" \
    -e "s|/usr/bin/node|$NODE_BIN|g" \
    -e "s|User=ubuntu|User=$CURRENT_USER|g" \
    -e "s|Group=ubuntu|Group=$CURRENT_USER|g" \
    "$src" | sudo tee "$dst" > /dev/null
}
```

替换内容：
- 仓库路径（`/opt/yomajiahr` → 实际 `$REPO_DIR`）
- 状态目录（`/home/ubuntu/.openclaw` → 实际 `$STATE_DIR`）
- openclaw 二进制路径（`/usr/bin/env openclaw` → `which openclaw` 结果）
- node 二进制路径（`/usr/bin/node` → `which node` 结果）
- 运行用户（`ubuntu` → 当前 `whoami`）

### service 文件：新增 PATH（改造）

systemd 默认 PATH 不包含 npm 全局 bin 目录，导致 openclaw 找不到。两个 service 文件各新增：

```ini
Environment=PATH=/usr/local/bin:/usr/bin:/bin
```

---

## 新增顶部变量

```bash
GITHUB_REPO_URL="https://github.com/MorrisYangJushi/yomajiahr.git"
INSTALL_DIR="${YOMAJIA_INSTALL_DIR:-/opt/yomajiahr}"
```

`INSTALL_DIR` 可通过环境变量 `YOMAJIA_INSTALL_DIR` 覆盖，默认 `/opt/yomajiahr`。

---

## 部署后仍需手动完成

| 步骤 | 操作 |
|------|------|
| 填写 API 密钥 | `nano ~/.openclaw/.env` |
| 飞书开放平台建 2 个 Bot | HR小助手（全员）+ HR管理后台（仅管理员） |
| 启动服务 | `sudo systemctl enable --now openclaw-gateway openclaw-admin` |
| 上传知识库文档 | 通过 Admin Portal (18790) 或直接放入 `~/.openclaw/data/hr-policies/` |

---

## 兼容性

- Ubuntu 24 LTS（Noble）：完全兼容
- Ubuntu 22 LTS（Jammy）：完全兼容
- macOS：本地运行（不支持 `--systemd`）
- 非 apt 系统（Debian、Alpine 等）：Node.js 通过 NVM 安装
