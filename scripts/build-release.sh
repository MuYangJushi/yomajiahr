#!/usr/bin/env bash
#
# Build an immutable Yoma+HR release artifact locally.
#
# Build outputs and production dependencies are generated on this machine, then
# packaged so the remote host can unpack and start services without npm/build.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_DIR/dist/releases"
STAGING_ROOT="$REPO_DIR/dist/release-staging"
TARGET_PLATFORM="linux-x64"
SKIP_BUILD=false

usage() {
  cat <<'EOF'
Usage: scripts/build-release.sh [options]

Options:
  --skip-build               Reuse existing dist/public outputs.
  -h, --help                 Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing command: $1" >&2; exit 1; }
}

run_step() {
  echo
  echo "==> $*"
  "$@"
}

copy_dir() {
  local src="$1" dst="$2"
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
}

install_prod_deps() {
  local dir="$1"
  ( cd "$dir" && npm ci --omit=dev --no-audit --no-fund )
}

need_cmd git
need_cmd node
need_cmd npm
need_cmd tar
if command -v shasum >/dev/null 2>&1; then
  SHA256_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD=(sha256sum)
else
  echo "ERROR: missing shasum or sha256sum" >&2
  exit 1
fi

HOST_OS="$(uname -s)"
GIT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
GIT_SHORT_SHA="$(git -C "$REPO_DIR" rev-parse --short=8 HEAD)"
DIRTY=false
if ! git -C "$REPO_DIR" diff --quiet || ! git -C "$REPO_DIR" diff --cached --quiet; then
  DIRTY=true
fi

BUILD_TS="$(date -u +%Y%m%d-%H%M%S)"
VERSION="${VERSION:-$BUILD_TS-$GIT_SHORT_SHA}"
PACKAGE_NAME="yomajiahr-$VERSION-$TARGET_PLATFORM"
STAGING_DIR="$STAGING_ROOT/$PACKAGE_NAME"
ARTIFACT="$OUT_DIR/$PACKAGE_NAME.tar.gz"
CHECKSUM="$ARTIFACT.sha256"

echo "Building release: $PACKAGE_NAME"
echo "Repo:             $REPO_DIR"
echo "Git:              $GIT_SHORT_SHA dirty=$DIRTY"
echo "Prod deps:        local npm ci --omit=dev ($HOST_OS)"

if [ "$SKIP_BUILD" != "true" ]; then
  run_step bash -lc "cd '$REPO_DIR/config' && npm ci --no-audit --no-fund && npm run build"
  run_step bash -lc "cd '$REPO_DIR/admin-server' && npm ci --no-audit --no-fund && npm run build"
  run_step bash -lc "cd '$REPO_DIR/admin-web' && npm ci --no-audit --no-fund && npm run build"
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/admin-server" "$STAGING_DIR/config" "$STAGING_DIR/systemd" "$STAGING_DIR/bin"

printf '%s\n' "$VERSION" > "$STAGING_DIR/VERSION"

cp "$REPO_DIR/admin-server/package.json" "$STAGING_DIR/admin-server/package.json"
cp "$REPO_DIR/admin-server/package-lock.json" "$STAGING_DIR/admin-server/package-lock.json"
copy_dir "$REPO_DIR/admin-server/dist" "$STAGING_DIR/admin-server/dist"
copy_dir "$REPO_DIR/admin-server/public" "$STAGING_DIR/admin-server/public"

cp "$REPO_DIR/config/package.json" "$STAGING_DIR/config/package.json"
cp "$REPO_DIR/config/package-lock.json" "$STAGING_DIR/config/package-lock.json"
copy_dir "$REPO_DIR/config/dist" "$STAGING_DIR/config/dist"
copy_dir "$REPO_DIR/config/scripts" "$STAGING_DIR/config/scripts"
copy_dir "$REPO_DIR/config/config-store.seed" "$STAGING_DIR/config/config-store.seed"
cp "$REPO_DIR/config/openclaw.base.jsonc" "$STAGING_DIR/config/openclaw.base.jsonc"
cp "$REPO_DIR/config/.env.example" "$STAGING_DIR/config/.env.example"

copy_dir "$REPO_DIR/skills" "$STAGING_DIR/skills"
copy_dir "$REPO_DIR/plugins" "$STAGING_DIR/plugins"
mkdir -p "$STAGING_DIR/workspaces"
copy_dir "$REPO_DIR/workspaces/_templates" "$STAGING_DIR/workspaces/_templates"

cp "$REPO_DIR/config/openclaw-gateway.service" "$STAGING_DIR/systemd/openclaw-gateway.service"
cp "$REPO_DIR/config/openclaw-admin.service" "$STAGING_DIR/systemd/openclaw-admin.service"
cp "$REPO_DIR/config/openclaw-apply.service" "$STAGING_DIR/systemd/openclaw-apply.service"
cp "$REPO_DIR/config/openclaw-apply.path" "$STAGING_DIR/systemd/openclaw-apply.path"
cp "$REPO_DIR/config/yomajiahr-monitor.service" "$STAGING_DIR/systemd/yomajiahr-monitor.service"
cp "$REPO_DIR/config/yomajiahr-monitor.timer" "$STAGING_DIR/systemd/yomajiahr-monitor.timer"

cp "$REPO_DIR/scripts/release/apply-release.sh" "$STAGING_DIR/bin/apply-release.sh"
cp "$REPO_DIR/scripts/release/rollback-release.sh" "$STAGING_DIR/bin/rollback-release.sh"
cp "$REPO_DIR/scripts/release/verify-release.sh" "$STAGING_DIR/bin/verify-release.sh"
cp "$REPO_DIR/scripts/monitor/yomajiahr-monitor.sh" "$STAGING_DIR/bin/yomajiahr-monitor.sh"
chmod +x "$STAGING_DIR/bin/"*.sh "$STAGING_DIR/config/scripts/"*.sh

run_step install_prod_deps "$STAGING_DIR/admin-server"
run_step install_prod_deps "$STAGING_DIR/config"

node > "$STAGING_DIR/manifest.json" <<EOF
const fs = require("fs");
const manifest = {
  name: "yomajiahr",
  version: "$VERSION",
  targetPlatform: "$TARGET_PLATFORM",
  git: {
    sha: "$GIT_SHA",
    shortSha: "$GIT_SHORT_SHA",
    dirty: $DIRTY
  },
  build: {
    createdAt: new Date().toISOString(),
    hostOs: "$HOST_OS",
    node: process.version,
    productionDependencies: "local npm ci --omit=dev"
  }
};
fs.writeFileSync(1, JSON.stringify(manifest, null, 2) + "\\n");
EOF

if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$STAGING_DIR" 2>/dev/null || true
fi

( cd "$STAGING_DIR" && find . -type f -not -path './SHA256SUMS' -print0 | sort -z | xargs -0 "${SHA256_CMD[@]}" ) > "$STAGING_DIR/SHA256SUMS"

run_step "$STAGING_DIR/bin/verify-release.sh" "$STAGING_DIR"

mkdir -p "$OUT_DIR"
rm -f "$ARTIFACT" "$CHECKSUM"
if tar --help 2>/dev/null | grep -q -- '--no-xattrs'; then
  ( cd "$STAGING_DIR" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARTIFACT" . )
else
  ( cd "$STAGING_DIR" && COPYFILE_DISABLE=1 tar -czf "$ARTIFACT" . )
fi
( cd "$OUT_DIR" && "${SHA256_CMD[@]}" "$(basename "$ARTIFACT")" > "$(basename "$CHECKSUM")" )

echo
echo "Release artifact:"
echo "  $ARTIFACT"
echo "  $CHECKSUM"
