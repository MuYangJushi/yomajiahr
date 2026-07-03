#!/usr/bin/env bash
#
# Apply a staged release on the production host.
#
set -euo pipefail

STAGED_DIR=""
INSTALL_DIR="${YOMAJIA_INSTALL_DIR:-/opt/yomajiahr}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXPECTED_USER="${YOMAJIA_DEPLOY_USER:-ubuntu}"
ADMIN_SVC="${ADMIN_SVC:-openclaw-admin}"
GATEWAY_SVC="${GATEWAY_SVC:-openclaw-gateway}"
APPLY_PATH_SVC="${APPLY_PATH_SVC:-openclaw-apply.path}"
SYSTEMD_BUS_TIMEOUT="${SYSTEMD_BUS_TIMEOUT:-120s}"
SKIP_TARGET_CHECK=false

usage() {
  cat <<'EOF'
Usage: bin/apply-release.sh --staged-dir DIR [options]

Options:
  --install-dir DIR       Default: /opt/yomajiahr
  --state-dir DIR         Default: $HOME/.openclaw
  --skip-target-check     Skip ubuntu user check for local testing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staged-dir) STAGED_DIR="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --skip-target-check) SKIP_TARGET_CHECK=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$STAGED_DIR" ]; then
  STAGED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
STAGED_DIR="$(cd "$STAGED_DIR" && pwd)"

log() { echo "[apply-release] $*"; }
fail() { echo "[apply-release] ERROR: $*" >&2; exit 1; }
systemctl_cmd() { sudo env SYSTEMD_BUS_TIMEOUT="$SYSTEMD_BUS_TIMEOUT" systemctl "$@"; }

health_check() {
  command -v curl >/dev/null 2>&1 || return 0
  # systemctl restart 返回 ≠ 服务已监听端口；admin-server 冷启动需 ~1-2s。
  # 轮询重试给服务 ready 窗口（默认 ~30s），消除「restart 后立即 curl 秒失败 → 误判回滚」竞态。
  local attempts="${HEALTH_CHECK_ATTEMPTS:-15}" i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS --max-time 5 http://127.0.0.1:18790/api/health >/dev/null 2>&1 \
       && curl -fsS --max-time 5 http://127.0.0.1:18789/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

restart_without_systemd() {
  log "WARN: systemd is unavailable; restarting gateway/admin directly from $CURRENT_LINK"
  mkdir -p "$STATE_DIR/logs"

  local pids
  pids="$(ss -ltnp 2>/dev/null | grep -E ':(18789|18790) ' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u | tr '\n' ' ')"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 5
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi

  set -a
  [ -f "$STATE_DIR/.env" ] && . "$STATE_DIR/.env"
  set +a

  (
    cd "$CURRENT_LINK/admin-server"
    nohup env \
      NODE_ENV=production \
      TMPDIR="${TMPDIR:-/run/user/$(id -u)}" \
      ADMIN_PORTAL_PORT="${ADMIN_PORTAL_PORT:-18790}" \
      OPENCLAW_STATE_DIR="$STATE_DIR" \
      node dist/server.js >> "$STATE_DIR/logs/openclaw-admin.manual.log" 2>&1 &
  )

  (
    cd "$CURRENT_LINK"
    nohup env \
      NODE_ENV=production \
      TMPDIR="${TMPDIR:-/run/user/$(id -u)}" \
      OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
      openclaw gateway run --bind loopback --port 18789 --force >> "$STATE_DIR/logs/openclaw-gateway.manual.log" 2>&1 &
  )

  sleep 8
  health_check || fail "direct process restart failed health check"
}

CURRENT_USER="$(whoami)"
if [ "$SKIP_TARGET_CHECK" != "true" ] && [ "$CURRENT_USER" != "$EXPECTED_USER" ]; then
  fail "run as $EXPECTED_USER, not $CURRENT_USER"
fi
if [ "$CURRENT_USER" = "root" ]; then
  fail "do not run release deployment as root"
fi

"$STAGED_DIR/bin/verify-release.sh" "$STAGED_DIR"

VERSION="$(tr -d '\n' < "$STAGED_DIR/VERSION")"
[ -n "$VERSION" ] || fail "empty VERSION"

RELEASE_DIR="$INSTALL_DIR/releases/$VERSION"
RELEASE_TMP="$INSTALL_DIR/releases/.$VERSION.tmp"
CURRENT_LINK="$INSTALL_DIR/current"
PREVIOUS_LINK="$INSTALL_DIR/previous"

mkdir -p "$STATE_DIR" "$STATE_DIR/skills" "$STATE_DIR/workspaces" "$STATE_DIR/data/hr-admin"
chmod 700 "$STATE_DIR"

log "Installing release $VERSION into $RELEASE_DIR"
sudo mkdir -p "$INSTALL_DIR/releases"
sudo rm -rf "$RELEASE_TMP"
sudo mkdir -p "$RELEASE_TMP"
sudo cp -a "$STAGED_DIR/." "$RELEASE_TMP/"
sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$RELEASE_TMP"
sudo rm -rf "$RELEASE_DIR"
sudo mv "$RELEASE_TMP" "$RELEASE_DIR"

log "Syncing runtime assets to $STATE_DIR"
rm -rf "$STATE_DIR/skills"
mkdir -p "$STATE_DIR/skills"
cp -a "$RELEASE_DIR/skills/." "$STATE_DIR/skills/"

rm -rf "$STATE_DIR/workspaces/_templates"
mkdir -p "$STATE_DIR/workspaces/_templates"
cp -a "$RELEASE_DIR/workspaces/_templates/." "$STATE_DIR/workspaces/_templates/"

if [ ! -d "$STATE_DIR/config-store" ]; then
  cp -a "$RELEASE_DIR/config/config-store.seed" "$STATE_DIR/config-store"
  log "Seeded $STATE_DIR/config-store"
else
  log "Keeping existing $STATE_DIR/config-store"
fi

if [ ! -f "$STATE_DIR/.env" ] && [ -f "$RELEASE_DIR/config/.env.example" ]; then
  cp "$RELEASE_DIR/config/.env.example" "$STATE_DIR/.env"
fi
[ -f "$STATE_DIR/.env" ] && chmod 600 "$STATE_DIR/.env"

ENV_FILE="$STATE_DIR/.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$RELEASE_DIR/config/.env.example"

log "Generating runtime OpenClaw config"
node "$RELEASE_DIR/config/dist/generate-config.js" \
  --out "$STATE_DIR/openclaw.json" \
  --base "$RELEASE_DIR/config/openclaw.base.jsonc" \
  --store "$STATE_DIR/config-store" \
  --env "$ENV_FILE" \
  --state-dir "$STATE_DIR" \
  --check-fs --skills-dir "$STATE_DIR/skills"
chmod 600 "$STATE_DIR/openclaw.json"

if command -v openclaw >/dev/null 2>&1; then
  log "Validating OpenClaw config"
  TMPDIR="${TMPDIR:-/run/user/$(id -u)}" \
    OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
    openclaw config validate
else
  log "WARN: openclaw not on PATH; skipping native config validate"
fi

install_service() {
  local src="$1" dst="$2"
  local openclaw_bin node_bin
  openclaw_bin="$(command -v openclaw || echo /usr/local/bin/openclaw)"
  node_bin="$(command -v node || echo /usr/bin/node)"
  sed \
    -e "s|/opt/yomajiahr|$INSTALL_DIR|g" \
    -e "s|/home/ubuntu/.openclaw|$STATE_DIR|g" \
    -e "s|/usr/bin/env openclaw|$openclaw_bin|g" \
    -e "s|/usr/bin/node|$node_bin|g" \
    -e "s|User=ubuntu|User=$CURRENT_USER|g" \
    -e "s|Group=ubuntu|Group=$CURRENT_USER|g" \
    "$src" | sudo tee "$dst" >/dev/null
}

log "Installing systemd units"
install_service "$RELEASE_DIR/systemd/openclaw-gateway.service" /etc/systemd/system/openclaw-gateway.service
install_service "$RELEASE_DIR/systemd/openclaw-admin.service" /etc/systemd/system/openclaw-admin.service
install_service "$RELEASE_DIR/systemd/openclaw-apply.service" /etc/systemd/system/openclaw-apply.service
install_service "$RELEASE_DIR/systemd/openclaw-apply.path" /etc/systemd/system/openclaw-apply.path
install_service "$RELEASE_DIR/systemd/yomajiahr-monitor.service" /etc/systemd/system/yomajiahr-monitor.service
install_service "$RELEASE_DIR/systemd/yomajiahr-monitor.timer" /etc/systemd/system/yomajiahr-monitor.timer

OLD_CURRENT=""
if [ -L "$CURRENT_LINK" ]; then
  OLD_CURRENT="$(readlink "$CURRENT_LINK")"
fi
if [ -n "$OLD_CURRENT" ]; then
  sudo ln -sfn "$OLD_CURRENT" "$PREVIOUS_LINK"
fi

log "Activating $RELEASE_DIR"
sudo ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

if ! systemctl_cmd daemon-reload || ! systemctl_cmd enable --now "$APPLY_PATH_SVC"; then
  restart_without_systemd
  log "Release $VERSION is live (direct process fallback)"
  exit 0
fi

rollback() {
  local reason="$1"
  echo "[apply-release] WARN: $reason; rolling back" >&2
  if [ -L "$PREVIOUS_LINK" ]; then
    local prev
    prev="$(readlink "$PREVIOUS_LINK")"
    sudo ln -sfn "$prev" "$CURRENT_LINK"
    systemctl_cmd daemon-reload
    systemctl_cmd restart "$GATEWAY_SVC" "$ADMIN_SVC" || true
    # 回滚也要确认恢复——切回 previous 不等于服务起得来（如环境性 Node SEGV，
    # 重启同环境同样崩）。失败时明确告警人工介入，不静默 exit 假装回滚成功。
    if health_check; then
      echo "[apply-release] rolled back to $prev and healthy" >&2
    else
      echo "[apply-release] ERROR: rolled back to $prev but services still unhealthy — MANUAL INTERVENTION REQUIRED (若为已知 Node SEGV 崩溃循环，需重启整机恢复)" >&2
    fi
  else
    echo "[apply-release] ERROR: no previous release to roll back to — MANUAL INTERVENTION REQUIRED" >&2
  fi
  exit 1
}

log "Restarting services"
systemctl_cmd restart "$GATEWAY_SVC" "$ADMIN_SVC" || restart_without_systemd

log "Checking services"
systemctl_cmd is-active --quiet "$GATEWAY_SVC" || rollback "$GATEWAY_SVC is not active"
systemctl_cmd is-active --quiet "$ADMIN_SVC" || rollback "$ADMIN_SVC is not active"
health_check || rollback "health check failed"

# 监控 timer 非关键路径：启用失败只警告，不触发回滚
if systemctl_cmd enable --now yomajiahr-monitor.timer; then
  log "Monitor timer enabled (yomajiahr-monitor.timer)"
else
  log "WARN: failed to enable yomajiahr-monitor.timer; enable manually after deploy"
fi

log "Release $VERSION is live"
