#!/usr/bin/env bash
#
# Yoma+HR one-click deployment script.
#
# Usage:
#   ./install.sh                    # install with defaults (~/.openclaw)
#   ./install.sh --systemd          # also install systemd services (Linux)
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

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
# Step 2: Install openclaw
# ---------------------------------------------------------------------------

echo "[2/8] Installing openclaw..."
if command -v openclaw &>/dev/null; then
  echo "  openclaw already installed: $(openclaw --version 2>/dev/null || echo 'unknown version')"
  echo "  Upgrading to latest..."
fi
npm install -g openclaw@latest
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
mkdir -p "$STATE_DIR/data/hr-policies/leave"
mkdir -p "$STATE_DIR/data/hr-policies/onboarding"
mkdir -p "$STATE_DIR/data/hr-policies/attendance"
mkdir -p "$STATE_DIR/data/hr-policies/compensation"
mkdir -p "$STATE_DIR/data/hr-policies/training"
mkdir -p "$STATE_DIR/data/hr-policies/general"
mkdir -p "$STATE_DIR/data/hr-admin"
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
  npm install --omit=dev
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
    sudo cp "$REPO_DIR/config/openclaw-gateway.service" /etc/systemd/system/
    sudo cp "$REPO_DIR/config/openclaw-admin.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    echo "  Service files installed. Enable with:"
    echo "    sudo systemctl enable --now openclaw-gateway"
    echo "    sudo systemctl enable --now openclaw-admin"
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
echo "  2. Start gateway:"
echo "     OPENCLAW_CONFIG_PATH=$STATE_DIR/openclaw.json openclaw gateway run --bind loopback --port 18789"
echo "  3. Start admin portal:"
echo "     cd $REPO_DIR/admin-portal && OPENCLAW_STATE_DIR=$STATE_DIR node server.mjs"
echo
