#!/usr/bin/env bash
#
# Yoma+HR one-click deployment script.
#
# Usage:
#   # Remote (from GitHub, fresh server):
#   curl -fsSL https://raw.githubusercontent.com/MorrisYangJushi/yomajiahr/main/install.sh | bash -s -- --systemd
#
#   # Local:
#   ./install.sh                    # install with defaults (~/.openclaw)
#   ./install.sh --systemd          # also install systemd services (Linux)
#   ./install.sh --state-dir=/path  # custom state dir
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GITHUB_REPO_URL="https://github.com/MorrisYangJushi/yomajiahr.git"
INSTALL_DIR="${YOMAJIA_INSTALL_DIR:-/opt/yomajiahr}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_MAJOR=24
# OpenClaw version resolution:
#   - "latest" (default)  → 解析 npm dist-tags.latest 到具体版本号（避免 openclaw@latest 抖动）
#   - "beta"              → 解析 npm dist-tags.beta（灰度验证用）
#   - "2026.6.6"          → 精确版本号（生产锁定用）
#   - "2026.5.26"         → 仍可锁定到旧版（兜底）
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
OPENCLAW_MIN_VERSION="${OPENCLAW_MIN_VERSION:-2026.5.26}"   # 最低兼容版本（仓库基线）
OPENCLAW_REGISTRY="${OPENCLAW_REGISTRY:-$(npm config get registry 2>/dev/null || echo 'https://registry.npmjs.org')}"
OPENCLAW_SKIP_INSTALL="${OPENCLAW_SKIP_INSTALL:-0}"
INSTALL_SYSTEMD=false

for arg in "$@"; do
  case "$arg" in
    --systemd) INSTALL_SYSTEMD=true ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

echo "============================================="
echo "  Yoma+HR Deployment"
echo "============================================="
echo "Source repo:  $REPO_DIR"
echo "State dir:    $STATE_DIR"
echo

HAS_SYSTEMD=false
SYSTEMD_CONFIGURED=false
GATEWAY_WAS_ACTIVE=false
ADMIN_WAS_ACTIVE=false
ENV_WAS_PRESENT=false
ENV_TEMPLATE_CREATED=false
SERVICES_RESTARTED=false

normalize_runtime_config() {
  if [ ! -f "$STATE_DIR/openclaw.json" ]; then
    return
  fi

  node <<EOF
const fs = require('fs');
const configPath = '$STATE_DIR/openclaw.json';
const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let changed = false;

for (const agent of json.agents?.list ?? []) {
  const tools = agent?.tools;
  if (
    tools &&
    Array.isArray(tools.allow) &&
    tools.allow.length > 0 &&
    Array.isArray(tools.alsoAllow) &&
    tools.alsoAllow.length > 0
  ) {
    delete tools.alsoAllow;
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\\n');
  console.log('  normalized agent tools policy: removed plugin-added alsoAllow where allow is explicit');
}
EOF
}

migrate_default_agents() {
  if [ ! -d "$STATE_DIR/config-store" ]; then
    return
  fi
  STATE_DIR="$STATE_DIR" node <<'EOF'
const fs = require("fs");
const path = require("path");
const root = path.join(process.env.STATE_DIR, "config-store");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
let changed = false;

const agents = read("agents.json");
if (!agents.some((agent) => agent.id === "hr-employee")) {
  const employee = agents.find((agent) => agent.id === "hr-assistant");
  if (employee) {
    employee.id = "hr-employee";
    employee.name = "HR小助手";
    employee.workspace = "~/.openclaw/workspaces/hr-employee";
    changed = true;
  }
}
const admin = agents.find((agent) => agent.id === "hr-admin");
if (admin && admin.name !== "HR管理员") {
  admin.name = "HR管理员";
  changed = true;
}
write("agents.json", agents);

const bindings = read("bindings.json");
for (const binding of bindings) {
  if (binding.agentId === "hr-assistant") {
    binding.agentId = "hr-employee";
    changed = true;
  }
  if (binding.match?.accountId === "hr-assistant") {
    binding.match.accountId = "hr-employee";
    changed = true;
  }
}
write("bindings.json", bindings);

const channels = read("channels.json");
for (const domain of Object.keys(channels)) {
  if (channels[domain]?.["hr-assistant"] && !channels[domain]?.["hr-employee"]) {
    channels[domain]["hr-employee"] = channels[domain]["hr-assistant"];
    delete channels[domain]["hr-assistant"];
    changed = true;
  }
  if (channels[domain]?.["hr-admin"]?.name === "HR管理后台") {
    channels[domain]["hr-admin"].name = "HR管理员";
    changed = true;
  }
}
write("channels.json", channels);

const knowledgePath = path.join(root, "knowledge.json");
if (fs.existsSync(knowledgePath)) {
  const knowledge = read("knowledge.json");
  for (const kb of knowledge.knowledgeBases || []) {
    kb.boundAgents = (kb.boundAgents || []).map((id) => id === "hr-assistant" ? "hr-employee" : id);
  }
  write("knowledge.json", knowledge);
}
if (changed) console.log("  migrated default agent hr-assistant -> hr-employee and renamed HR管理员");
EOF
}

# ---------------------------------------------------------------------------
# Step 0: Prerequisites (curl, git) + remote execution detection
# ---------------------------------------------------------------------------

# Ensure curl and git are available on Linux/apt systems
if [ "$(uname)" = "Linux" ] && command -v apt-get &>/dev/null; then
  NEED_PKGS=""
  command -v curl &>/dev/null || NEED_PKGS="$NEED_PKGS curl"
  command -v git  &>/dev/null || NEED_PKGS="$NEED_PKGS git"
  command -v rg   &>/dev/null || NEED_PKGS="$NEED_PKGS ripgrep"
  if [ -n "$NEED_PKGS" ]; then
    echo "[0/9] Installing prerequisites:$NEED_PKGS..."
    sudo apt-get update -qq
    sudo apt-get install -y $NEED_PKGS
  fi
fi

# Detect remote execution (curl | bash): repo files won't be present at REPO_DIR.
# Clone the repo and re-exec from the cloned location.
if [ ! -d "$REPO_DIR/workspaces" ] || [ ! -d "$REPO_DIR/skills" ]; then
  echo "[0/9] Remote execution detected — cloning repo to $INSTALL_DIR..."
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    sudo git clone --depth=1 "$GITHUB_REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  else
    echo "  $INSTALL_DIR already exists, skipping clone"
  fi
  exec "$INSTALL_DIR/install.sh" "$@"
fi

if [ "$(uname)" = "Linux" ] && command -v systemctl &>/dev/null; then
  HAS_SYSTEMD=true
  if systemctl cat openclaw-gateway >/dev/null 2>&1 || systemctl cat openclaw-admin >/dev/null 2>&1; then
    SYSTEMD_CONFIGURED=true
  fi
  if systemctl cat openclaw-gateway >/dev/null 2>&1 && systemctl is-active --quiet openclaw-gateway; then
    GATEWAY_WAS_ACTIVE=true
  fi
  if systemctl cat openclaw-admin >/dev/null 2>&1 && systemctl is-active --quiet openclaw-admin; then
    ADMIN_WAS_ACTIVE=true
  fi
fi

if [ "$GATEWAY_WAS_ACTIVE" = true ] || [ "$ADMIN_WAS_ACTIVE" = true ]; then
  echo "[0/9] Stopping running services before update..."
  if [ "$GATEWAY_WAS_ACTIVE" = true ]; then
    sudo systemctl stop openclaw-gateway
    echo "  openclaw-gateway stopped"
  fi
  if [ "$ADMIN_WAS_ACTIVE" = true ]; then
    sudo systemctl stop openclaw-admin
    echo "  openclaw-admin stopped"
  fi
fi

# ---------------------------------------------------------------------------
# Step 1: Install Node.js (if needed)
# ---------------------------------------------------------------------------

install_node_via_nvm() {
  echo "  Installing Node.js $MIN_NODE_MAJOR via nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -f "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm install "$MIN_NODE_MAJOR"
  nvm use "$MIN_NODE_MAJOR"
  nvm alias default "$MIN_NODE_MAJOR"
}

install_node_via_apt() {
  echo "  Installing Node.js $MIN_NODE_MAJOR via NodeSource + apt..."
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
}

echo "[1/9] Checking Node.js..."
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ]; then
    NODE_OK=true
    echo "  Node.js $(node -v) OK"
  else
    echo "  Node.js $(node -v) too old (need v$MIN_NODE_MAJOR+), will upgrade"
  fi
else
  echo "  Node.js not found, will install"
fi

if [ "$NODE_OK" = false ]; then
  if [ "$(uname)" = "Linux" ] && command -v apt-get &>/dev/null && command -v curl &>/dev/null; then
    install_node_via_apt
  elif command -v curl &>/dev/null; then
    install_node_via_nvm
    # Reload PATH so subsequent commands find node
    export PATH="$NVM_DIR/versions/node/$(nvm version)/bin:$PATH"
  else
    echo "ERROR: Cannot install Node.js automatically (no curl/apt-get found)."
    echo "  Please install Node.js v$MIN_NODE_MAJOR+ manually: https://nodejs.org/"
    exit 1
  fi
  echo "  Node.js $(node -v) installed"
fi

# ---------------------------------------------------------------------------
# Configure npm registry (China mirror)
# ---------------------------------------------------------------------------
npm config set registry https://registry.npmmirror.com

# ---------------------------------------------------------------------------
# Step 2: Install openclaw
# ---------------------------------------------------------------------------

echo "[2/9] Installing openclaw..."
if [ "$OPENCLAW_SKIP_INSTALL" = "1" ]; then
  command -v openclaw >/dev/null 2>&1 || { echo "ERROR: OPENCLAW_SKIP_INSTALL=1 but openclaw is not on PATH"; exit 1; }
  INSTALLED_VERSION="$(openclaw --version 2>/dev/null | awk '{print $2}')"
  echo "  skipped; using $INSTALLED_VERSION"
else
  # Resolve OPENCLAW_VERSION to a concrete semver.
  # "latest" / "beta" → resolve via npm dist-tags.
  # "2026.6.6" / "2026.5.26" → keep as-is.
  case "$OPENCLAW_VERSION" in
    latest|beta|alpha)
      RESOLVED_VERSION="$(npm view "openclaw@$OPENCLAW_VERSION" version --registry="$OPENCLAW_REGISTRY" 2>/dev/null | tail -1)"
      if [ -z "$RESOLVED_VERSION" ]; then
        echo "ERROR: failed to resolve dist-tag '$OPENCLAW_VERSION' from $OPENCLAW_REGISTRY" >&2
        exit 1
      fi
      echo "  Resolved $OPENCLAW_VERSION → $RESOLVED_VERSION (from $OPENCLAW_REGISTRY)"
      OPENCLAW_VERSION="$RESOLVED_VERSION"
      ;;
    *)
      # Concrete semver — keep as-is
      ;;
  esac

  # Compare against minimum required version (sortable: 2026.5.26 < 2026.6.6)
  if [ "$OPENCLAW_VERSION" != "$(printf '%s\n%s\n' "$OPENCLAW_VERSION" "$OPENCLAW_MIN_VERSION" | sort -V | tail -1)" ]; then
    echo "ERROR: openclaw@$OPENCLAW_VERSION is older than minimum required ($OPENCLAW_MIN_VERSION)" >&2
    echo "       Pass OPENCLAW_VERSION=<newer> or OPENCLAW_MIN_VERSION=<lower> to override." >&2
    exit 1
  fi

  # Remove existing installation first to avoid ENOTEMPTY rename errors on upgrade
  NPM_PREFIX="$(npm config get prefix)"
  if [ -d "$NPM_PREFIX/lib/node_modules/openclaw" ]; then
    echo "  Removing existing openclaw installation..."
    sudo rm -rf "$NPM_PREFIX/lib/node_modules/openclaw"
  fi
  # Use sudo if the npm global prefix is not user-writable (e.g. system Node via apt).
  # NVM_DIR is only set when nvm is installed for the current $HOME; fall through
  # to NPM_PREFIX otherwise. ${VAR:-} defends against `set -u` on unset vars.
  NPM_LIB_WRITABLE=false
  if [ -d "${NVM_DIR:-}/versions/node/$(node -v | tr -d 'v')/lib" ] \
     && [ -w "${NVM_DIR:-}/versions/node/$(node -v | tr -d 'v')/lib" ]; then
    NPM_LIB_WRITABLE=true
  elif [ -w "$NPM_PREFIX/lib" ]; then
    NPM_LIB_WRITABLE=true
  fi
  if [ "$NPM_LIB_WRITABLE" = true ]; then
    npm install -g "openclaw@$OPENCLAW_VERSION" --registry="$OPENCLAW_REGISTRY"
  else
    sudo npm install -g "openclaw@$OPENCLAW_VERSION" --registry="$OPENCLAW_REGISTRY"
  fi
  INSTALLED_VERSION="$(openclaw --version 2>/dev/null | awk '{print $2}')"
  if [ -z "$INSTALLED_VERSION" ] || ! command -v openclaw >/dev/null 2>&1; then
    echo "ERROR: openclaw@$OPENCLAW_VERSION install completed but binary is not on PATH" >&2
    exit 1
  fi
  if [ "$INSTALLED_VERSION" != "$OPENCLAW_VERSION" ]; then
    echo "WARN: installed version ($INSTALLED_VERSION) differs from requested ($OPENCLAW_VERSION)" >&2
  fi
  echo "  openclaw $INSTALLED_VERSION installed"
fi

# ---------------------------------------------------------------------------
# Step 3: Create directory structure
# ---------------------------------------------------------------------------

echo "[3/9] Creating directory structure..."
mkdir -p "$STATE_DIR"
if [ -d "$STATE_DIR/workspaces/hr-assistant" ] && [ ! -e "$STATE_DIR/workspaces/hr-employee" ]; then
  mv "$STATE_DIR/workspaces/hr-assistant" "$STATE_DIR/workspaces/hr-employee"
fi
if [ -d "$STATE_DIR/agents/hr-assistant" ] && [ ! -e "$STATE_DIR/agents/hr-employee" ]; then
  mv "$STATE_DIR/agents/hr-assistant" "$STATE_DIR/agents/hr-employee"
fi
mkdir -p "$STATE_DIR/workspaces/hr-employee"
mkdir -p "$STATE_DIR/workspaces/hr-admin"
mkdir -p "$STATE_DIR/memory"
mkdir -p "$STATE_DIR/skills"
mkdir -p "$STATE_DIR/data/hr-admin"
# ADR-010：文档交 FastGPT 原生解析/存储，平台不再本地归档/切片，
# 故不再创建 data/hr-policies、data/hr-chunks 及其分类子目录（仅保留上面的审计日志目录）。
echo "  Done"

# ---------------------------------------------------------------------------
# Step 4: Copy workspace files
# ---------------------------------------------------------------------------

echo "[4/9] Copying workspace files..."
for agent in hr-employee hr-admin; do
  src="$REPO_DIR/workspaces/$agent"
  dst="$STATE_DIR/workspaces/$agent"
  if [ ! -d "$src" ]; then
    echo "  [WARN] Source workspace not found: $src (skipping)"
    continue
  fi
  for f in AGENTS.md SOUL.md IDENTITY.md MEMORY.md TOOLS.md; do
    if [ -f "$src/$f" ]; then
      cp "$src/$f" "$dst/$f"
    fi
  done
  rm -f "$dst/CLAUDE.md"
  echo "  $dst/ OK"
done

# ---------------------------------------------------------------------------
# Step 5: Copy skills
# ---------------------------------------------------------------------------

echo "[5/9] Copying skills..."
for skill_dir in "$REPO_DIR/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  dst="$STATE_DIR/skills/$skill_name"
  rm -rf "$dst"
  cp -r "$skill_dir" "$dst"
  echo "  $skill_name"
done

# ---------------------------------------------------------------------------
# Step 6: Compile config (JSONC -> JSON)
# ---------------------------------------------------------------------------

echo "[6/9] Building config toolkit & generating config..."
if [ -f "$REPO_DIR/config/openclaw.base.jsonc" ]; then
  # \u6784\u5EFA config \u5DE5\u5177\u5305\uFF08TS\u2192JS\uFF09\u3002\u9700\u8981 devDeps(typescript)\uFF0C\u6545\u7528\u666E\u901A npm install\u3002
  ( cd "$REPO_DIR/config" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) \
    || { echo "  [FAIL] config toolkit build failed"; exit 1; }
  # \u751F\u6210 + \u6821\u9A8C\uFF08base + config-store \u2192 \u8FD0\u884C\u65F6 JSON\uFF09\u3002\u6821\u9A8C\u5931\u8D25\u5219\u975E\u96F6\u9000\u51FA\uFF0C\u4E0D\u5199\u574F\u914D\u7F6E\u3002
  # \u5360\u4F4D\u7B26\u5B58\u5728\u6027\u5BF9\u7167 .env.example\uFF08\u5951\u7EA6\u6A21\u677F\uFF1Bstep 7 \u624D\u62F7\u8D1D/\u586B\u5145\u771F\u5B9E .env\uFF09\u3002
  # 运行时 config-store 由平台拥有，存于 $STATE_DIR；首装从仓库 seed 播种，已存在则保留(不覆盖线上配置)。
  if [ ! -d "$STATE_DIR/config-store" ]; then
    cp -r "$REPO_DIR/config/config-store.seed" "$STATE_DIR/config-store"
    echo "  seeded $STATE_DIR/config-store from repo template"
  else
    echo "  $STATE_DIR/config-store exists (kept; not overwritten)"
  fi
  migrate_default_agents
  # 生成 + 校验（base + 运行时 store → 运行时 JSON）。开 --check-fs 校验 workspace/skill 存在性。
  # 已有部署优先对照运行时 .env，以支持平台动态创建的 channel 凭据；
  # 首次安装尚无运行时 .env 时，仍对照 .env.example 契约模板。
  CONFIG_ENV_FILE="$REPO_DIR/config/.env.example"
  if [ -f "$STATE_DIR/.env" ]; then
    CONFIG_ENV_FILE="$STATE_DIR/.env"
  fi
  node "$REPO_DIR/config/dist/generate-config.js" \
    --out "$STATE_DIR/openclaw.json" \
    --base "$REPO_DIR/config/openclaw.base.jsonc" \
    --store "$STATE_DIR/config-store" \
    --env "$CONFIG_ENV_FILE" \
    --state-dir "$STATE_DIR" \
    --check-fs --skills-dir "$STATE_DIR/skills" \
    || { echo "  [FAIL] config generation/validation failed"; exit 1; }
  chmod 600 "$STATE_DIR/openclaw.json"
  echo "  $STATE_DIR/openclaw.json OK"
else
  echo "  [WARN] config/openclaw.base.jsonc not found (skipping)"
fi

# ---------------------------------------------------------------------------
# Step 7: Copy .env template
# ---------------------------------------------------------------------------

echo "[7/9] Checking environment file..."
if [ -f "$STATE_DIR/.env" ]; then
  ENV_WAS_PRESENT=true
  echo "  $STATE_DIR/.env already exists (skipped)"
else
  if [ -f "$REPO_DIR/config/.env.example" ]; then
    cp "$REPO_DIR/config/.env.example" "$STATE_DIR/.env"
    ENV_TEMPLATE_CREATED=true
    echo "  Copied .env template to $STATE_DIR/.env"
    echo "  ** Please edit $STATE_DIR/.env and fill in real API keys **"
  fi
fi

chmod 700 "$STATE_DIR"
if [ -f "$STATE_DIR/.env" ]; then
  chmod 600 "$STATE_DIR/.env"
fi

echo "  Installing official Feishu plugin..."
# The official installer command enters interactive bot onboarding and writes to the
# caller's OpenClaw state directory. For unattended deploys with repo-managed
# config/env files, use the official non-interactive update path against STATE_DIR.
# The bundled doctor currently only understands single-account top-level feishu
# credentials and will false-positive on this repo's accounts-based config.
PLUGIN_UPDATE_LOG="$(mktemp)"
set +e
OPENCLAW_STATE_DIR="$STATE_DIR" npx -y @larksuite/openclaw-lark update >"$PLUGIN_UPDATE_LOG" 2>&1
PLUGIN_UPDATE_STATUS=$?
set -e
if [ "$PLUGIN_UPDATE_STATUS" -eq 0 ]; then
  cat "$PLUGIN_UPDATE_LOG"
else
  if [ ! -d "$STATE_DIR/extensions/openclaw-lark/node_modules/openclaw" ]; then
    cat "$PLUGIN_UPDATE_LOG"
    rm -f "$PLUGIN_UPDATE_LOG"
    echo "ERROR: Official Feishu plugin update failed before the plugin was installed."
    exit 1
  fi

  sed \
    -e '/^\[FAIL\] \.env file permissions are too open /d' \
    -e '/^Suggestion: Run chmod 600 ".*\/\.env" or "feishu-plugin-onboard doctor --fix"\./d' \
    -e '/^\[FAIL\] Feishu channel configuration missing or incomplete$/d' \
    -e '/^Suggestion: App ID or Secret missing\. Run "feishu-plugin-onboard doctor --fix" to configure them\.$/d' \
    -e '/^Some checks failed\. Use "feishu-plugin-onboard doctor --fix" to attempt automatic repair\.$/d' \
    "$PLUGIN_UPDATE_LOG" > "$PLUGIN_UPDATE_LOG.filtered"

  if grep -q '^\[FAIL\]' "$PLUGIN_UPDATE_LOG.filtered"; then
    cat "$PLUGIN_UPDATE_LOG"
    rm -f "$PLUGIN_UPDATE_LOG" "$PLUGIN_UPDATE_LOG.filtered"
    echo "ERROR: Official Feishu plugin update reported unexpected failures."
    exit 1
  fi

  cat "$PLUGIN_UPDATE_LOG.filtered"
  if grep -q '^\[FAIL\] Feishu channel configuration missing or incomplete$' "$PLUGIN_UPDATE_LOG"; then
    echo "  [WARN] Official Feishu plugin doctor does not yet understand this repo's multi-account channels.feishu.accounts layout."
  fi
  if grep -q '^\[FAIL\] \.env file permissions are too open ' "$PLUGIN_UPDATE_LOG"; then
    echo "  [WARN] Official Feishu plugin doctor reported .env permissions before install.sh tightened them to 600."
  fi
  echo "  [WARN] Official Feishu plugin update returned non-zero due to known doctor limitations."
  rm -f "$PLUGIN_UPDATE_LOG.filtered"
fi
rm -f "$PLUGIN_UPDATE_LOG"
normalize_runtime_config
echo "  official Feishu plugin installed"

# ---------------------------------------------------------------------------
# Step 8: Install DingTalk connector
# ---------------------------------------------------------------------------

echo "[8/9] Installing official DingTalk connector..."
# The official DingTalk connector also provides a QR-code onboarding command via
# npx, but production deploys keep credentials in repo-managed config/env files.
# Install the plugin package only; do not enter interactive onboarding here.
DINGTALK_PLUGIN_LOG="$(mktemp)"
set +e
OPENCLAW_STATE_DIR="$STATE_DIR" openclaw plugins install @dingtalk-real-ai/dingtalk-connector >"$DINGTALK_PLUGIN_LOG" 2>&1
DINGTALK_PLUGIN_STATUS=$?
if [ "$DINGTALK_PLUGIN_STATUS" -ne 0 ]; then
  cat "$DINGTALK_PLUGIN_LOG"
  echo "  DingTalk connector install returned non-zero; trying plugin update for rerunnable deploys..."
  : >"$DINGTALK_PLUGIN_LOG"
  OPENCLAW_STATE_DIR="$STATE_DIR" openclaw plugins update dingtalk-connector >"$DINGTALK_PLUGIN_LOG" 2>&1
  DINGTALK_PLUGIN_STATUS=$?
fi
set -e
if [ "$DINGTALK_PLUGIN_STATUS" -ne 0 ]; then
  cat "$DINGTALK_PLUGIN_LOG"
  rm -f "$DINGTALK_PLUGIN_LOG"
  echo "ERROR: Official DingTalk connector install failed."
  echo "       Check OpenClaw version (requires >= 2026.4.9), network access, and plugin registry availability."
  exit 1
fi
cat "$DINGTALK_PLUGIN_LOG"
rm -f "$DINGTALK_PLUGIN_LOG"
normalize_runtime_config
echo "  official DingTalk connector installed"

# ---------------------------------------------------------------------------
# Step 9: Install admin-server dependencies
# ---------------------------------------------------------------------------

echo "[9/9] Installing & building admin-server (backend + web)..."
if [ -f "$REPO_DIR/admin-server/package.json" ]; then
  # 后端：需 devDeps(tsup/typescript) 构建 TS → dist/server.js
  ( cd "$REPO_DIR/admin-server" && npm install --no-audit --no-fund && npm run build ) \
    || { echo "  [FAIL] admin-server backend install/build failed"; exit 1; }
  echo "  admin-server backend built (dist/server.js)"
  # 前端：React+antd Vite 工程（admin-web/ 与 admin-server/ 同级）→ 产物输出到 admin-server/public/console/
  if [ -f "$REPO_DIR/admin-web/package.json" ]; then
    ( cd "$REPO_DIR/admin-web" && npm install --no-audit --no-fund && npm run build ) \
      || { echo "  [FAIL] admin-web install/build failed"; exit 1; }
    echo "  admin-web built (admin-server/public/console/)"
  fi
else
  echo "  [WARN] admin-server/package.json not found (skipping)"
fi

# ---------------------------------------------------------------------------
# Install or refresh systemd services (Linux only)
# ---------------------------------------------------------------------------

if [ "$INSTALL_SYSTEMD" = true ] || [ "$SYSTEMD_CONFIGURED" = true ]; then
  if [ "$(uname)" != "Linux" ]; then
    echo "[WARN] --systemd is only supported on Linux (skipping)"
  else
    echo "[systemd] Installing service files..."

    OPENCLAW_BIN="$(command -v openclaw || echo '/usr/local/bin/openclaw')"
    NODE_BIN="$(command -v node || echo '/usr/bin/node')"
    CURRENT_USER="$(whoami)"

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

    _install_service \
      "$REPO_DIR/config/openclaw-gateway.service" \
      /etc/systemd/system/openclaw-gateway.service

    _install_service \
      "$REPO_DIR/config/openclaw-admin.service" \
      /etc/systemd/system/openclaw-admin.service

    # P0 基石 B：特权配置应用通道（oneshot helper + 文件监听）。
    # apply.service 以 root 运行(需 systemctl restart gateway)；_install_service 的 User=ubuntu→CURRENT_USER
    # 替换不影响它(它写的是 User=root)。
    _install_service \
      "$REPO_DIR/config/openclaw-apply.service" \
      /etc/systemd/system/openclaw-apply.service
    _install_service \
      "$REPO_DIR/config/openclaw-apply.path" \
      /etc/systemd/system/openclaw-apply.path
    sudo chmod +x "$REPO_DIR/config/scripts/apply-config.sh"

    sudo systemctl daemon-reload
    sudo systemctl enable --now openclaw-apply.path
    echo "  Service files installed (incl. config apply channel)."
  fi
fi

if [ "$HAS_SYSTEMD" = true ] && { [ "$GATEWAY_WAS_ACTIVE" = true ] || [ "$ADMIN_WAS_ACTIVE" = true ]; }; then
  # Pre-restart health gate: validate the new config against the freshly installed
  # openclaw binary. If the upgrade changed schema/CLI surface, openclaw may
  # reject the existing openclaw.json — in that case we DO NOT restart the
  # services (would bring down production on a bad upgrade).
  echo "[health] Validating $STATE_DIR/openclaw.json against openclaw $INSTALLED_VERSION..."
  if command -v openclaw >/dev/null 2>&1; then
    # `openclaw config validate` does not take a --config arg; it reads
    # $OPENCLAW_CONFIG_PATH. Point it at the runtime config explicitly.
    if OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" openclaw config validate >/tmp/openclaw-validate.log 2>&1; then
      echo "  config validate: OK"
    else
      echo "  [WARN] config validate failed (see /tmp/openclaw-validate.log);" >&2
      echo "         skipping service restart to keep the previous version live." >&2
      echo "         Investigate log, fix the config, then run:" >&2
      echo "           sudo systemctl restart openclaw-gateway openclaw-admin" >&2
      GATEWAY_WAS_ACTIVE=false
      ADMIN_WAS_ACTIVE=false
    fi
  else
    echo "  [WARN] openclaw not on PATH; skipping pre-restart validation"
  fi

  if [ "$GATEWAY_WAS_ACTIVE" = true ] || [ "$ADMIN_WAS_ACTIVE" = true ]; then
    echo "[systemd] Restarting previously running services..."
    if [ "$GATEWAY_WAS_ACTIVE" = true ]; then
      sudo systemctl restart openclaw-gateway
      echo "  openclaw-gateway restarted"
    fi
    if [ "$ADMIN_WAS_ACTIVE" = true ]; then
      sudo systemctl restart openclaw-admin
      echo "  openclaw-admin restarted"
    fi
    SERVICES_RESTARTED=true
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "============================================="
echo "  Deployment complete!"
echo "============================================="
echo
echo "State directory: $STATE_DIR/"
echo "  workspaces/hr-employee/     (employee agent workspace)"
echo "  workspaces/hr-admin/        (admin agent workspace)"
echo "  skills/                     (HR skills)"
echo "  data/hr-admin/              (audit logs)"
echo "  openclaw.json               (gateway config)"
echo "  .env                        (API keys)"
echo
if [ "$SERVICES_RESTARTED" = true ] && [ "$ENV_WAS_PRESENT" = true ]; then
  echo "Services were restarted automatically and the updated deployment is live."
  if [ "$GATEWAY_WAS_ACTIVE" = true ]; then
    echo "  - openclaw-gateway restarted"
  fi
  if [ "$ADMIN_WAS_ACTIVE" = true ]; then
    echo "  - openclaw-admin restarted"
  fi
  echo
  echo "Useful checks:"
  echo "  systemctl status openclaw-gateway --no-pager"
  echo "  systemctl status openclaw-admin --no-pager"
elif [ "$ENV_TEMPLATE_CREATED" = true ]; then
  echo "Next steps:"
  echo "  1. Edit $STATE_DIR/.env with your API keys"
  if [ "$INSTALL_SYSTEMD" = true ] || [ "$SYSTEMD_CONFIGURED" = true ]; then
    echo "  2. Enable and start services:"
    echo "     sudo systemctl enable --now openclaw-gateway"
    echo "     sudo systemctl enable --now openclaw-admin"
  else
    echo "  2. Start gateway:"
    echo "     OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
    echo "  3. Start admin portal:"
    echo "     cd $REPO_DIR/admin-server && OPENCLAW_STATE_DIR=$STATE_DIR node --env-file=$STATE_DIR/.env dist/server.js"
  fi
elif [ "$INSTALL_SYSTEMD" = true ] || [ "$SYSTEMD_CONFIGURED" = true ]; then
  echo "Next steps:"
  echo "  sudo systemctl enable --now openclaw-gateway"
  echo "  sudo systemctl enable --now openclaw-admin"
else
  echo "Next steps:"
  echo "  OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
  echo "  cd $REPO_DIR/admin-server && OPENCLAW_STATE_DIR=$STATE_DIR node --env-file=$STATE_DIR/.env dist/server.js"
fi
echo
