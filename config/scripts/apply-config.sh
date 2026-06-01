#!/usr/bin/env bash
#
# P0 基石 B/C：配置应用流水线（生成→校验→快照→应用→重启→探活→失败回滚）。
# 由特权 helper(openclaw-apply.service, root) 触发执行；也可手工运行做验证。
#
# 入参（环境变量）：
#   REPO_DIR   仓库根（含 config/）            必填
#   STATE_DIR  运行时目录（~/.openclaw）        必填
#   GATEWAY_SVC  systemd 服务名（默认 openclaw-gateway）
#   PROBE_WINDOW 探活观测秒数（默认 15，需 > RestartSec=10）
#   PROBE_FORCE_FAIL=1  仅测试用：强制探活失败以验证回滚
#
set -uo pipefail

REPO_DIR="${REPO_DIR:?REPO_DIR required}"
STATE_DIR="${STATE_DIR:?STATE_DIR required}"
GATEWAY_SVC="${GATEWAY_SVC:-openclaw-gateway}"
PROBE_WINDOW="${PROBE_WINDOW:-15}"

CONFIG_DIR="$REPO_DIR/config"
STORE_DIR="$STATE_DIR/config-store"   # 运行时 store（平台拥有；仓库内为 config-store.seed 模板）
SKILLS_DIR="$STATE_DIR/skills"
RUNTIME="$STATE_DIR/openclaw.json"
STAGING="$STATE_DIR/openclaw.json.staging"
LASTGOOD="$STATE_DIR/openclaw.json.last-good"
CONTROL="$STATE_DIR/control"
RESULT="$CONTROL/apply-result.json"
VERSIONS="$STATE_DIR/config-versions"

mkdir -p "$CONTROL" "$VERSIONS"

json_str() { node -e 'process.stdout.write(JSON.stringify(String(process.argv[1])))' "$1" 2>/dev/null || printf '"%s"' "$1"; }

write_result() { # status message [version]
  local status="$1" msg="$2" ver="${3:-}"
  printf '{"status":"%s","message":%s,"version":%s,"ts":"%s"}\n' \
    "$status" "$(json_str "$msg")" "$(json_str "$ver")" "$(date -u +%FT%TZ)" \
    > "$RESULT.tmp" && mv "$RESULT.tmp" "$RESULT"
  chmod 644 "$RESULT" 2>/dev/null || true
}

has_systemctl() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

log() { echo "[apply-config] $*" >&2; }

fail() { write_result failed "$1" "${2:-}"; log "FAIL: $1"; exit 1; }

restart_gateway() {
  has_systemctl || { log "no systemd; skip restart (dev)"; return 0; }
  systemctl restart "$GATEWAY_SVC"
}

# 探活判别器（应对 Restart=always 抖动）：观测窗内须持续 active 且 NRestarts 不增长。
probe() {
  [ "${PROBE_FORCE_FAIL:-0}" = "1" ] && { log "PROBE_FORCE_FAIL=1 → 故意失败"; return 1; }
  has_systemctl || { log "no systemd; skip probe (dev)"; return 0; }
  local baseline now i
  baseline=$(systemctl show -p NRestarts --value "$GATEWAY_SVC" 2>/dev/null || echo 0)
  for ((i = 0; i < PROBE_WINDOW; i++)); do
    sleep 1
    systemctl is-active --quiet "$GATEWAY_SVC" || { log "not active @${i}s"; return 1; }
    now=$(systemctl show -p NRestarts --value "$GATEWAY_SVC" 2>/dev/null || echo 0)
    [ "${now:-0}" -gt "${baseline:-0}" ] && { log "NRestarts 增长 ${baseline}→${now}（crash-loop）"; return 1; }
  done
  return 0
}

rollback() { # reason
  log "回滚中：$1"
  if [ -f "$LASTGOOD" ]; then
    cp "$LASTGOOD" "$RUNTIME"; chmod 600 "$RUNTIME"
    restart_gateway || true
    fail "$1（已回滚至 last-good）"
  fi
  fail "$1（无 last-good 可回滚）"
}

# —— 1. 生成 + 校验 → staging（含 --check-fs：workspace/skill 存在性）——
log "生成 + 校验 → staging"
node "$CONFIG_DIR/dist/generate-config.js" \
  --out "$STAGING" \
  --base "$CONFIG_DIR/openclaw.base.jsonc" \
  --store "$STORE_DIR" \
  --env "$CONFIG_DIR/.env.example" \
  --state-dir "$STATE_DIR" \
  --check-fs --skills-dir "$SKILLS_DIR" \
  || fail "生成/校验失败（未改动运行时配置）"

# —— 2. 快照 last-good + store 版本 ——
TS=$(date -u +%Y%m%dT%H%M%SZ)
[ -f "$RUNTIME" ] && cp "$RUNTIME" "$LASTGOOD"
mkdir -p "$VERSIONS/$TS"
cp "$STORE_DIR"/*.json "$VERSIONS/$TS/" 2>/dev/null || true
log "已快照 last-good + store 版本 $TS"

# —— 3. 原子应用 ——
mv "$STAGING" "$RUNTIME"; chmod 600 "$RUNTIME"
log "已应用 → $RUNTIME"

# —— 4. 重启 ——
restart_gateway || rollback "重启失败"

# —— 5. 探活（失败则回滚）——
probe || rollback "健康探活失败"

write_result success "applied" "$TS"
log "OK（version=$TS）"
