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
# Remove existing installation first to avoid ENOTEMPTY rename errors on upgrade
NPM_PREFIX="$(npm config get prefix)"
if [ -d "$NPM_PREFIX/lib/node_modules/openclaw" ]; then
  echo "  Removing existing openclaw installation..."
  sudo rm -rf "$NPM_PREFIX/lib/node_modules/openclaw"
fi
# Use sudo if the npm global prefix is not user-writable (e.g. system Node via apt)
if [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  npm install -g openclaw@latest
else
  sudo npm install -g openclaw@latest
fi
echo "  openclaw $(openclaw --version 2>/dev/null || echo '') installed"

# ---------------------------------------------------------------------------
# Step 3: Create directory structure
# ---------------------------------------------------------------------------

echo "[3/9] Creating directory structure..."
mkdir -p "$STATE_DIR"
mkdir -p "$STATE_DIR/workspaces/hr-assistant"
mkdir -p "$STATE_DIR/workspaces/hr-admin"
mkdir -p "$STATE_DIR/memory"
mkdir -p "$STATE_DIR/skills"
mkdir -p "$STATE_DIR/data/hr-admin"
POLICIES_DIR="$STATE_DIR/data/hr-policies"
CURRENT_POLICY_DIRS=()
while IFS= read -r category; do
  CURRENT_POLICY_DIRS+=("$category")
done < <(
  node --input-type=module <<EOF
import { CATEGORIES } from "${REPO_DIR}/admin-portal/lib/categories.mjs";

if (!Array.isArray(CATEGORIES) || CATEGORIES.length === 0) {
  console.error("ERROR: admin-portal/lib/categories.mjs does not export a non-empty CATEGORIES array.");
  process.exit(1);
}

for (const category of CATEGORIES) {
  if (typeof category !== "string" || category.trim() === "") {
    console.error("ERROR: CATEGORIES contains an invalid category value.");
    process.exit(1);
  }
  console.log(category);
}
EOF
)
if [ "${#CURRENT_POLICY_DIRS[@]}" -eq 0 ]; then
  echo "ERROR: Failed to load policy categories from admin-portal/lib/categories.mjs"
  exit 1
fi
mkdir -p "$POLICIES_DIR"
for category in "${CURRENT_POLICY_DIRS[@]}"; do
  mkdir -p "$POLICIES_DIR/$category"
done
for existing_dir in "$POLICIES_DIR"/*; do
  if [ ! -d "$existing_dir" ]; then
    continue
  fi
  dir_name=$(basename "$existing_dir")
  keep_dir=false
  for category in "${CURRENT_POLICY_DIRS[@]}"; do
    if [ "$dir_name" = "$category" ]; then
      keep_dir=true
      break
    fi
  done
  if [ "$keep_dir" = true ]; then
    continue
  fi
  if find "$existing_dir" -mindepth 1 -print -quit | grep -q .; then
    echo "  [WARN] Legacy policy directory not empty: $existing_dir"
    echo "         Please migrate its files to the new categories before deleting it."
    continue
  fi
  rmdir "$existing_dir"
  echo "  Removed obsolete policy directory: $existing_dir"
done
# Pre-chunked knowledge base directory (for OpenClaw search indexing)
CHUNKS_DIR="$STATE_DIR/data/hr-chunks"
mkdir -p "$CHUNKS_DIR"
for category in "${CURRENT_POLICY_DIRS[@]}"; do
  mkdir -p "$CHUNKS_DIR/$category"
done
echo "  Done"

# ---------------------------------------------------------------------------
# Step 4: Copy workspace files
# ---------------------------------------------------------------------------

echo "[4/9] Copying workspace files..."
for agent in hr-assistant hr-admin; do
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
  # CLAUDE.md symlink
  ln -sf AGENTS.md "$dst/CLAUDE.md"
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
  # 生成 + 校验（base + 运行时 store → 运行时 JSON）。开 --check-fs 校验 workspace/skill 存在性。
  # 占位符存在性对照 .env.example（契约模板；step 7 才拷贝/填充真实 .env）。
  node "$REPO_DIR/config/dist/generate-config.js" \
    --out "$STATE_DIR/openclaw.json" \
    --base "$REPO_DIR/config/openclaw.base.jsonc" \
    --store "$STATE_DIR/config-store" \
    --env "$REPO_DIR/config/.env.example" \
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
# Step 9: Install admin-portal dependencies
# ---------------------------------------------------------------------------

echo "[9/9] Installing admin-portal dependencies..."
if [ -f "$REPO_DIR/admin-portal/package.json" ]; then
  cd "$REPO_DIR/admin-portal"
  sudo npm install --omit=dev
  echo "  admin-portal dependencies installed"
else
  echo "  [WARN] admin-portal/package.json not found (skipping)"
fi

# ---------------------------------------------------------------------------
# Optional: systemd services (Linux only)
# ---------------------------------------------------------------------------

if [ "$INSTALL_SYSTEMD" = true ]; then
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

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "============================================="
echo "  Deployment complete!"
echo "============================================="
echo
echo "State directory: $STATE_DIR/"
echo "  workspaces/hr-assistant/    (employee agent workspace)"
echo "  workspaces/hr-admin/        (admin agent workspace)"
echo "  skills/                     (HR skills)"
echo "  data/hr-policies/           (knowledge base)"
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
  if [ "$INSTALL_SYSTEMD" = true ]; then
    echo "  2. Enable and start services:"
    echo "     sudo systemctl enable --now openclaw-gateway"
    echo "     sudo systemctl enable --now openclaw-admin"
  else
    echo "  2. Start gateway:"
    echo "     OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
    echo "  3. Start admin portal:"
    echo "     cd $REPO_DIR/admin-portal && OPENCLAW_STATE_DIR=$STATE_DIR node server.mjs"
  fi
elif [ "$INSTALL_SYSTEMD" = true ]; then
  echo "Next steps:"
  echo "  sudo systemctl enable --now openclaw-gateway"
  echo "  sudo systemctl enable --now openclaw-admin"
else
  echo "Next steps:"
  echo "  OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
  echo "  cd $REPO_DIR/admin-portal && OPENCLAW_STATE_DIR=$STATE_DIR node server.mjs"
fi
echo
