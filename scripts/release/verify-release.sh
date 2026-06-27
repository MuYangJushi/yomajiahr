#!/usr/bin/env bash
#
# Verify that a staged release directory contains the files needed at runtime.
#
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

require_file() {
  [ -f "$ROOT/$1" ] || { echo "ERROR: missing file: $1" >&2; exit 1; }
}

require_dir() {
  [ -d "$ROOT/$1" ] || { echo "ERROR: missing directory: $1" >&2; exit 1; }
}

reject_path() {
  if [ -e "$ROOT/$1" ]; then
    echo "ERROR: release must not contain: $1" >&2
    exit 1
  fi
}

require_file VERSION
require_file manifest.json
require_file admin-server/package.json
require_file admin-server/package-lock.json
require_file admin-server/dist/server.js
require_file admin-server/public/index.html
require_dir admin-server/node_modules
require_file config/package.json
require_file config/package-lock.json
require_file config/dist/generate-config.js
require_file config/openclaw.base.jsonc
require_file config/.env.example
require_dir config/config-store.seed
require_dir config/node_modules
require_file config/scripts/apply-config.sh
require_dir skills
require_dir workspaces/_templates
require_dir workspaces/_templates/agents
require_file systemd/openclaw-gateway.service
require_file systemd/openclaw-admin.service
require_file systemd/openclaw-apply.service
require_file systemd/openclaw-apply.path
require_file bin/apply-release.sh
require_file bin/rollback-release.sh
require_file bin/verify-release.sh

reject_path .git
reject_path admin-web
reject_path admin-server/src
reject_path config/src
reject_path .env
reject_path config/.env

if find "$ROOT" -name '.env' -o -path '*/.git/*' | grep -q .; then
  echo "ERROR: release contains forbidden .env or .git content" >&2
  exit 1
fi

echo "Release verification OK: $ROOT"
