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
MIN_NODE_MAJOR=22
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
    echo "[0/8] Installing prerequisites:$NEED_PKGS..."
    sudo apt-get update -qq
    sudo apt-get install -y $NEED_PKGS
  fi
fi

# Detect remote execution (curl | bash): repo files won't be present at REPO_DIR.
# Clone the repo and re-exec from the cloned location.
if [ ! -d "$REPO_DIR/workspaces" ] || [ ! -d "$REPO_DIR/skills" ]; then
  echo "[0/8] Remote execution detected — cloning repo to $INSTALL_DIR..."
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    sudo git clone --depth=1 "$GITHUB_REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  else
    echo "  $INSTALL_DIR already exists, skipping clone"
  fi
  exec "$INSTALL_DIR/install.sh" "$@"
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

echo "[1/8] Checking Node.js..."
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

echo "[2/8] Installing openclaw..."
# Remove existing installation first to avoid ENOTEMPTY rename errors on upgrade
NPM_PREFIX="$(npm config get prefix)"
if [ -d "$NPM_PREFIX/lib/node_modules/openclaw" ]; then
  echo "  Removing existing openclaw installation..."
  sudo rm -rf "$NPM_PREFIX/lib/node_modules/openclaw"
fi
# Use sudo if the npm global prefix is not user-writable (e.g. system Node via apt)
if [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  npm install -g openclaw@latest --ignore-scripts
else
  sudo npm install -g openclaw@latest --ignore-scripts
fi
echo "  openclaw $(openclaw --version 2>/dev/null || echo '') installed"

# ---------------------------------------------------------------------------
# Step 3: Create directory structure
# ---------------------------------------------------------------------------

echo "[3/8] Creating directory structure..."
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
echo "  Done"

# ---------------------------------------------------------------------------
# Step 4: Copy workspace files
# ---------------------------------------------------------------------------

echo "[4/8] Copying workspace files..."
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

echo "[5/8] Copying skills..."
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

echo "[6/8] Compiling config..."
if [ -f "$REPO_DIR/config/openclaw.jsonc" ]; then
  node -e "
const fs = require('fs');
const vm = require('vm');
const text = fs.readFileSync('$REPO_DIR/config/openclaw.jsonc', 'utf-8');
const sanitized = text
  .replace(/^\uFEFF/, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const json = vm.runInNewContext('(' + sanitized + ')', {});
json.gateway = { mode: 'local' };
fs.writeFileSync(
  '$STATE_DIR/openclaw.json',
  JSON.stringify(json, null, 2) + '\n'
);
"
  echo "  $STATE_DIR/openclaw.json OK"
else
  echo "  [WARN] config/openclaw.jsonc not found (skipping)"
fi

# ---------------------------------------------------------------------------
# Step 7: Copy .env template
# ---------------------------------------------------------------------------

echo "[7/8] Checking environment file..."
if [ ! -f "$STATE_DIR/.env" ]; then
  if [ -f "$REPO_DIR/config/.env.example" ]; then
    cp "$REPO_DIR/config/.env.example" "$STATE_DIR/.env"
    echo "  Copied .env template to $STATE_DIR/.env"
    echo "  ** Please edit $STATE_DIR/.env and fill in real API keys **"
  fi
else
  echo "  $STATE_DIR/.env already exists (skipped)"
fi

# ---------------------------------------------------------------------------
# Step 8: Install admin-portal dependencies
# ---------------------------------------------------------------------------

echo "[8/8] Installing admin-portal dependencies..."
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

    sudo systemctl daemon-reload
    echo "  Service files installed."
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
echo "  workspaces/hr-assistant/    (employee agent workspace)"
echo "  workspaces/hr-admin/        (admin agent workspace)"
echo "  skills/                     (HR skills)"
echo "  data/hr-policies/           (knowledge base)"
echo "  data/hr-admin/              (audit logs)"
echo "  openclaw.json               (gateway config)"
echo "  .env                        (API keys)"
echo
echo "Next steps:"
echo "  1. Edit $STATE_DIR/.env with your API keys"
if [ "$INSTALL_SYSTEMD" = true ]; then
  echo "  2. Enable and start services (after filling in .env):"
  echo "     sudo systemctl enable --now openclaw-gateway"
  echo "     sudo systemctl enable --now openclaw-admin"
else
  echo "  2. Start gateway:"
  echo "     OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
  echo "  3. Start admin portal:"
  echo "     cd $REPO_DIR/admin-portal && OPENCLAW_STATE_DIR=$STATE_DIR node server.mjs"
fi
echo
