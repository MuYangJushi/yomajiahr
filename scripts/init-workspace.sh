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
echo "[1/4] Creating directory structure..."
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

# 2. Copy workspace bootstrap files (AGENTS.md, SOUL.md, IDENTITY.md, CLAUDE.md)
echo "[2/4] Copying workspace bootstrap files..."
for agent in hr-assistant hr-admin; do
  src="$REPO_DIR/workspace-$agent"
  dst="$STATE_DIR/workspace-$agent"
  if [ ! -d "$src" ]; then
    echo "  [WARN] Source workspace not found: $src (skipping)"
    continue
  fi
  for f in AGENTS.md SOUL.md IDENTITY.md MEMORY.md; do
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

# 3. Copy env template if not exists
echo "[3/4] Checking environment file..."
if [ ! -f "$STATE_DIR/.env" ]; then
  if [ -f "$REPO_DIR/config/.env.ymjhr.example" ]; then
    cp "$REPO_DIR/config/.env.ymjhr.example" "$STATE_DIR/.env"
    echo "  Copied .env template to $STATE_DIR/.env"
    echo "  ** Please edit $STATE_DIR/.env and fill in real API keys **"
  fi
else
  echo "  $STATE_DIR/.env already exists (skipped)"
fi

# 4. Summary
echo "[4/4] Done!"
echo
echo "Workspace structure:"
echo "  $STATE_DIR/"
echo "  ├── workspace-hr-assistant/"
echo "  ├── workspace-hr-admin/"
echo "  ├── memory/hr-policies/{leave,onboarding,...}/"
echo "  ├── memory/hr-admin/"
echo "  └── .env"
echo
echo "Next steps:"
echo "  1. Edit $STATE_DIR/.env with your API keys"
echo "  2. Generate config: see docs/yomajiahr-deployment.md Step 5"
echo "  3. Start gateway: ymjhr gateway run --bind loopback --port 18789"
