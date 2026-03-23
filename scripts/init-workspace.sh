#!/usr/bin/env bash
#
# Initialize Yoma+HR workspace directories and bootstrap files.
#
# Usage:
#   ./scripts/init-workspace.sh              # defaults to ~/.ymjhr
#   YMJHR_STATE_DIR=/data ./scripts/init-workspace.sh
#
set -euo pipefail

STATE_DIR="${YMJHR_STATE_DIR:-${OPENCLAW_STATE_DIR:-$HOME/.ymjhr}}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Initializing Yoma+HR workspace at: $STATE_DIR"
echo "Source repo: $REPO_DIR"
echo

# 1. Create state directory structure
echo "[1/6] Creating directory structure..."
mkdir -p "$STATE_DIR"
mkdir -p "$STATE_DIR/workspace-hr-assistant"
mkdir -p "$STATE_DIR/workspace-hr-admin"
mkdir -p "$STATE_DIR/memory/hr-policies/leave"
mkdir -p "$STATE_DIR/memory/hr-policies/onboarding"
mkdir -p "$STATE_DIR/memory/hr-policies/attendance"
mkdir -p "$STATE_DIR/memory/hr-policies/compensation"
mkdir -p "$STATE_DIR/memory/hr-policies/training"
mkdir -p "$STATE_DIR/memory/hr-policies/general"
mkdir -p "$STATE_DIR/memory/hr-admin"

# 2. Clean up removed workspaces from previous architecture
echo "[2/6] Cleaning up removed workspaces..."
for old_ws in workspace-hr-policy-rag; do
  if [ -d "$STATE_DIR/$old_ws" ]; then
    rm -rf "$STATE_DIR/$old_ws"
    echo "  Removed $STATE_DIR/$old_ws"
  fi
done

# 3. Copy workspace bootstrap files (AGENTS.md, SOUL.md, IDENTITY.md, CLAUDE.md)
echo "[3/6] Copying workspace bootstrap files..."
for agent in hr-assistant hr-admin; do
  src="$REPO_DIR/workspace-$agent"
  dst="$STATE_DIR/workspace-$agent"
  if [ ! -d "$src" ]; then
    echo "  [WARN] Source workspace not found: $src (skipping)"
    continue
  fi
  for f in AGENTS.md SOUL.md IDENTITY.md MEMORY.md TOOLS.md; do
    if [ -f "$src/$f" ]; then
      cp "$src/$f" "$dst/$f"
      echo "  $dst/$f"
    fi
  done
  # CLAUDE.md symlink
  if [ -L "$src/CLAUDE.md" ]; then
    target=$(readlink "$src/CLAUDE.md")
    ln -sf "$target" "$dst/CLAUDE.md"
    echo "  $dst/CLAUDE.md -> $target"
  elif [ -f "$src/CLAUDE.md" ]; then
    cp "$src/CLAUDE.md" "$dst/CLAUDE.md"
    echo "  $dst/CLAUDE.md"
  fi
done

# 4. Sync config: convert JSONC template → runtime JSON
echo "[4/6] Syncing config from template..."
if [ -f "$REPO_DIR/config/ymjhr.jsonc" ]; then
  node -e "
const fs = require('fs');
const vm = require('vm');
const text = fs.readFileSync('$REPO_DIR/config/ymjhr.jsonc', 'utf-8');
const sanitized = text
  .replace(/^\uFEFF/, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const json = vm.runInNewContext('(' + sanitized + ')', {});
json.gateway = { mode: 'local' };
fs.writeFileSync(
  '$STATE_DIR/ymjhr.json',
  JSON.stringify(json, null, 2) + '\n'
);
"
  echo "  Synced $STATE_DIR/ymjhr.json"
else
  echo "  [WARN] Template not found: $REPO_DIR/config/ymjhr.jsonc (skipping)"
fi

# 5. Copy env template if not exists
echo "[5/6] Checking environment file..."
if [ ! -f "$STATE_DIR/.env" ]; then
  if [ -f "$REPO_DIR/config/.env.ymjhr.example" ]; then
    cp "$REPO_DIR/config/.env.ymjhr.example" "$STATE_DIR/.env"
    echo "  Copied .env template to $STATE_DIR/.env"
    echo "  ** Please edit $STATE_DIR/.env and fill in real API keys **"
  fi
else
  echo "  $STATE_DIR/.env already exists (skipped)"
fi

# 6. Summary
echo "[6/6] Done!"
echo
echo "Workspace structure:"
echo "  $STATE_DIR/"
echo "  ├── ymjhr.json                (synced from config/ymjhr.jsonc)"
echo "  ├── .env                      (API keys)"
echo "  ├── workspace-hr-assistant/"
echo "  ├── workspace-hr-admin/"
echo "  ├── memory/hr-policies/{leave,onboarding,...}/"
echo "  └── memory/hr-admin/"
echo
echo "Next steps:"
echo "  1. Edit $STATE_DIR/.env with your API keys"
echo "  2. Generate config: see docs/yomajiahr-deployment.md Step 5"
echo "  3. Start gateway: ymjhr gateway run --bind loopback --port 18789"
