#!/usr/bin/env bash
#
# P0 基石 B/C：配置应用流水线（生成→校验→快照→应用→重启→探活→失败回滚）。
# 由特权 helper(openclaw-apply.service, root) 触发执行；也可手工运行做验证。
#
# 入参（环境变量）：
#   REPO_DIR     仓库根（含 config/）            必填
#   STATE_DIR    运行时目录（~/.openclaw）        必填
#   GATEWAY_SVC  systemd 服务名（默认 openclaw-gateway）
#   GATEWAY_PORT gateway HTTP 端口（默认 18789）；用于 /health 功能性就绪检查
#   PROBE_WINDOW   探活最长等待秒数（默认 30）；达成连续就绪即提前返回
#   READY_SUSTAIN  连续就绪所需秒数（默认 11，需 > systemd RestartSec=10）
#   HEALTH_URL     就绪探测地址（默认 http://127.0.0.1:$GATEWAY_PORT/health）
#   PROBE_FORCE_FAIL=1  仅测试用：强制探活失败以验证回滚
#   PROCESS_APPLY_REQUEST=1  处理管理平台 apply-request 中的会话清理/撤权验证
#
set -uo pipefail

REPO_DIR="${REPO_DIR:?REPO_DIR required}"
STATE_DIR="${STATE_DIR:?STATE_DIR required}"
GATEWAY_SVC="${GATEWAY_SVC:-openclaw-gateway}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
PROBE_WINDOW="${PROBE_WINDOW:-30}"
READY_SUSTAIN="${READY_SUSTAIN:-11}"   # 连续就绪秒数，需 > systemd RestartSec(10)
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${GATEWAY_PORT}/health}"

CONFIG_DIR="$REPO_DIR/config"
STORE_DIR="$STATE_DIR/config-store"   # 运行时 store（平台拥有；仓库内为 config-store.seed 模板）
SKILLS_DIR="$STATE_DIR/skills"
RUNTIME="$STATE_DIR/openclaw.json"
STAGING="$STATE_DIR/openclaw.json.staging"
LASTGOOD="$STATE_DIR/openclaw.json.last-good"
CONTROL="$STATE_DIR/control"
RESULT="$CONTROL/apply-result.json"
REQUEST="$CONTROL/apply-request.json"
VERSIONS="$STATE_DIR/config-versions"
RESET_SESSIONS_JSON='[]'
ACTIVE_REQUEST=""
REQUEST_ID=""

mkdir -p "$CONTROL" "$VERSIONS"

json_str() { node -e 'process.stdout.write(JSON.stringify(String(process.argv[1])))' "$1" 2>/dev/null || printf '"%s"' "$1"; }

write_result() { # status message [version]
  local status="$1" msg="$2" ver="${3:-}"
  printf '{"status":"%s","message":%s,"version":%s,"requestId":%s,"resetSessions":%s,"ts":"%s"}\n' \
    "$status" "$(json_str "$msg")" "$(json_str "$ver")" "$(json_str "$REQUEST_ID")" "$RESET_SESSIONS_JSON" "$(date -u +%FT%TZ)" \
    > "$RESULT.tmp" && mv "$RESULT.tmp" "$RESULT"
  chmod 644 "$RESULT" 2>/dev/null || true
}

has_systemctl() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

log() { echo "[apply-config] $*" >&2; }

fail() { write_result failed "$1" "${2:-}"; log "FAIL: $1"; exit 1; }

if [ "${PROCESS_APPLY_REQUEST:-0}" = "1" ] && [ -f "$REQUEST" ]; then
  ACTIVE_REQUEST="$CONTROL/apply-request.processing.$$"
  cp "$REQUEST" "$ACTIVE_REQUEST" || fail "无法快照 apply 请求"
  REQUEST_ID=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.id ?? ""))' "$ACTIVE_REQUEST") \
    || { rm -f "$ACTIVE_REQUEST"; ACTIVE_REQUEST=""; fail "apply 请求格式非法"; }
  [ -n "$REQUEST_ID" ] || { rm -f "$ACTIVE_REQUEST"; ACTIVE_REQUEST=""; fail "apply 请求缺少 id"; }
  trap 'rm -f "$ACTIVE_REQUEST"' EXIT
fi

set_runtime_permissions() {
  chmod 600 "$RUNTIME"
  # apply.service 以 root 运行，但 gateway 以 STATE_DIR 所有者运行。
  # 每次原子替换/回滚后必须恢复归属，否则 gateway 无法读取 0600 配置。
  chown --reference="$STATE_DIR" "$RUNTIME" 2>/dev/null || true
}

stop_gateway() {
  has_systemctl || { log "no systemd; skip stop (dev)"; return 0; }
  systemctl stop "$GATEWAY_SVC"
}

start_gateway() {
  has_systemctl || { log "no systemd; skip start (dev)"; return 0; }
  systemctl start "$GATEWAY_SVC"
}

# 探活判别器：观测窗内须持续 active、NRestarts 不增长，且 GET /health 连续 200 ≥ READY_SUSTAIN 秒。
# openclaw gateway 在 --port 端口原生暴露 GET /health（liveness，进程存活即 200，不受渠道连通性影响）。
# “连续就绪 > RestartSec” 而非“单次 200”：坏配置 crash-loop 时 /health 会随重启间歇中断，
# 就绪计数被重置 → 无法累积到阈值 → 探活失败 → 回滚。一旦达成连续就绪即提前返回成功。
probe() {
  [ "${PROBE_FORCE_FAIL:-0}" = "1" ] && { log "PROBE_FORCE_FAIL=1 → 故意失败"; return 1; }
  has_systemctl || { log "no systemd; skip probe (dev)"; return 0; }
  local have_curl=0; command -v curl >/dev/null 2>&1 && have_curl=1
  [ "$have_curl" = 0 ] && log "无 curl，降级：以 is-active+NRestarts 连续观测代替 /health 校验"
  local baseline now streak=0 i code
  baseline=$(systemctl show -p NRestarts --value "$GATEWAY_SVC" 2>/dev/null || echo 0)
  for ((i = 0; i < PROBE_WINDOW; i++)); do
    sleep 1
    systemctl is-active --quiet "$GATEWAY_SVC" || { log "not active @${i}s"; return 1; }
    now=$(systemctl show -p NRestarts --value "$GATEWAY_SVC" 2>/dev/null || echo 0)
    [ "${now:-0}" -gt "${baseline:-0}" ] && { log "NRestarts 增长 ${baseline}→${now}（crash-loop）"; return 1; }
    if [ "$have_curl" = 1 ]; then
      code=$(curl --silent --max-time 1 --output /dev/null --write-out '%{http_code}' \
        "$HEALTH_URL" 2>/dev/null || echo "000")
      if [ "$code" = "200" ]; then
        streak=$((streak + 1))
      else
        [ "$streak" -gt 0 ] && log "GET /health 中断（code=${code} @${i}s），就绪计数重置"
        streak=0
      fi
    else
      streak=$((streak + 1)) # 无 curl：以连续 is-active 秒数代替
    fi
    if [ "$streak" -ge "$READY_SUSTAIN" ]; then
      log "就绪确认（连续 ${streak}s 满足，> RestartSec）"
      return 0
    fi
  done
  log "PROBE_WINDOW=${PROBE_WINDOW}s 内未达连续就绪 ${READY_SUSTAIN}s（最后 streak=${streak}，端口 ${GATEWAY_PORT}）"
  return 1
}

rollback() { # reason
  log "回滚中：$1"
  if [ -f "$LASTGOOD" ]; then
    stop_gateway || true
    cp "$LASTGOOD" "$RUNTIME"; set_runtime_permissions
    start_gateway || true
    fail "$1（已回滚至 last-good）"
  fi
  # 首次 apply 无 last-good：坏配置已在 $RUNTIME 且网关在其上 crash-loop。
  # 隔离坏配置 + 停服，避免持续服务已知坏配置（而非放任 crash-loop）。
  if [ -f "$RUNTIME" ]; then
    mv "$RUNTIME" "$RUNTIME.rejected.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
    log "无 last-good：已隔离坏配置 → $RUNTIME.rejected.*"
  fi
  if has_systemctl; then
    systemctl stop "$GATEWAY_SVC" 2>/dev/null || true
    log "已停 $GATEWAY_SVC（无可回滚配置，避免 crash-loop）"
  fi
  fail "$1（无 last-good 可回滚；已隔离坏配置并停服）"
}

# —— 1. 生成 + 校验 → staging（含 --check-fs：workspace/skill 存在性）——
log "生成 + 校验 → staging"
# 运行时占位符校验对照真实 $STATE_DIR/.env（含编排刚写入的新 bot 秘钥）；不存在则回退 .env.example。
ENV_FILE="$STATE_DIR/.env"; [ -f "$ENV_FILE" ] || ENV_FILE="$CONFIG_DIR/.env.example"
node "$CONFIG_DIR/dist/generate-config.js" \
  --out "$STAGING" \
  --base "$CONFIG_DIR/openclaw.base.jsonc" \
  --store "$STORE_DIR" \
  --env "$ENV_FILE" \
  --state-dir "$STATE_DIR" \
  --check-fs --skills-dir "$SKILLS_DIR" \
  || fail "生成/校验失败（未改动运行时配置）"

# 平台校验只覆盖本仓库约束；停止现有 Gateway 前再用 OpenClaw 原生 schema 校验 staging，
# 避免平台新增字段意外进入运行时配置后导致 Gateway 启动失败。
OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$STAGING" \
  openclaw config validate --json >/dev/null \
  || fail "OpenClaw 原生配置校验失败（未改动运行时配置）"

# —— 2. 快照 last-good + store 版本 ——
TS=$(date -u +%Y%m%dT%H%M%SZ)
[ -f "$RUNTIME" ] && cp "$RUNTIME" "$LASTGOOD"
mkdir -p "$VERSIONS/$TS"
cp "$STORE_DIR"/*.json "$VERSIONS/$TS/" 2>/dev/null || true
log "已快照 last-good + store 版本 $TS"

# —— 3. 停旧进程 + 原子应用 ——
# OpenClaw 退出时会校验并可能自动恢复它观察到的配置替换。必须先停旧进程，
# 否则 systemctl restart 的 stop 阶段可能把刚生成的新配置覆盖回 backup。
stop_gateway || fail "停止旧 Gateway 失败（未改动运行时配置）"

# 知识解绑/文档删除需要清除当前上下文。必须在 Gateway 完全停止后执行，
# 否则进程内旧会话可能在 sessions.json 清空后再次写回。
if [ -n "$ACTIVE_REQUEST" ]; then
  RESET_SESSIONS_JSON=$(node "$CONFIG_DIR/scripts/reset-agent-sessions.mjs" "$STATE_DIR" "$ACTIVE_REQUEST") \
    || { start_gateway || true; fail "重置受影响 Agent 当前会话失败（已尝试恢复启动旧 Gateway）"; }
  log "已重置受影响 Agent 当前会话：$RESET_SESSIONS_JSON"
fi

mv "$STAGING" "$RUNTIME" || { start_gateway || true; fail "应用运行时配置失败（已尝试恢复启动旧 Gateway）"; }
set_runtime_permissions
log "已应用 → $RUNTIME"

# 对知识解绑执行负向验证：store、运行时工具和 MCP 注册必须全部撤权。
if [ -n "$ACTIVE_REQUEST" ]; then
  node "$CONFIG_DIR/scripts/verify-knowledge-revocation.mjs" "$STATE_DIR" "$ACTIVE_REQUEST" \
    || rollback "知识库解绑负向验证失败"
fi

# —— 4. 启动 ——
start_gateway || rollback "启动失败"

# —— 5. 探活（失败则回滚）——
probe || rollback "健康探活失败"

write_result success "applied" "$TS"
log "OK（version=$TS）"
