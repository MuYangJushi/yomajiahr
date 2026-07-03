#!/usr/bin/env bash
#
# Yoma+HR 最小监控告警（Sprint 10 #75）
#
# 只读探测生产健康状态，异常推飞书群 webhook（未配置时降级落盘）。
# 由 yomajiahr-monitor.timer 每分钟触发一次（Type=oneshot），也可手动执行。
#
# 探测项：
#   1. HTTP health：admin 18790/api/health + gateway 18789/health
#   2. systemd 服务状态：is-active openclaw-gateway / openclaw-admin
#   3. systemd 管理面探活：systemctl 调用自身超时/总线报错 = CRITICAL
#      （2026-07-04 生产事件教训：PID1 IPC 失效 6 天，服务 health 200 掩盖管理面死亡）
#   4. NRestarts 增量 + journal SEGV 计数（事件型，发现即报、更新基线）
#   5. 磁盘使用率 / 可用内存水位
#
# 告警语义：
#   状态型（health/服务/管理面/磁盘/内存）：进入告警 → 静默窗口内不重发 → 恢复时发 RESOLVED
#   事件型（重启增量/SEGV）：每次检测到增量即报一条，基线随之前移，天然不刷屏
#
# 约束：纯只读探测，自身任何失败不得影响业务服务；无 jq 依赖（JSON 经 python3 组装）。
#
set -uo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
MONITOR_DIR="$STATE_DIR/data/monitor"
STATE_FILE="$MONITOR_DIR/state.env"
ALERTS_FILE="$MONITOR_DIR/alerts.jsonl"

ADMIN_HEALTH_URL="${MONITOR_ADMIN_URL:-http://127.0.0.1:18790/api/health}"
GATEWAY_HEALTH_URL="${MONITOR_GATEWAY_URL:-http://127.0.0.1:18789/health}"
GATEWAY_SVC="${GATEWAY_SVC:-openclaw-gateway}"
ADMIN_SVC="${ADMIN_SVC:-openclaw-admin}"
SILENCE_SECONDS="${MONITOR_SILENCE_SECONDS:-1800}"
DISK_ALERT_PCT="${MONITOR_DISK_ALERT_PCT:-90}"
MEM_ALERT_AVAIL_MB="${MONITOR_MEM_ALERT_AVAIL_MB:-200}"
SYSTEMCTL_TIMEOUT="${MONITOR_SYSTEMCTL_TIMEOUT:-15}"
# 测试/非 systemd 环境置 1：跳过 systemctl/journalctl 探测
SKIP_SYSTEMD="${MONITOR_SKIP_SYSTEMD:-0}"

HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
NOW_EPOCH="$(date +%s)"
NOW_ISO="$(date +%Y-%m-%dT%H:%M:%S%z)"

# webhook 从 .env 读（unit 不注入 EnvironmentFile，避免密钥进环境快照）
if [ -z "${MONITOR_FEISHU_WEBHOOK:-}" ] && [ -f "$STATE_DIR/.env" ]; then
  MONITOR_FEISHU_WEBHOOK="$(grep -m1 '^MONITOR_FEISHU_WEBHOOK=' "$STATE_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" || true)"
fi

mkdir -p "$MONITOR_DIR"
touch "$STATE_FILE"
NEW_STATE_FILE="$STATE_FILE.new.$$"
: > "$NEW_STATE_FILE"
trap 'rm -f "$NEW_STATE_FILE"' EXIT

state_get() { grep -m1 "^$1=" "$STATE_FILE" 2>/dev/null | cut -d= -f2-; }
state_set() { printf '%s=%s\n' "$1" "$2" >> "$NEW_STATE_FILE"; }

# 本轮问题清单（状态型），每行 "key|severity|message"
PROBLEMS=""
add_problem() { PROBLEMS="${PROBLEMS}$1|$2|$3
"; }

json_escape() {
  python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

send_feishu() {
  # $1=text；无 webhook 或发送失败返回非 0
  [ -n "${MONITOR_FEISHU_WEBHOOK:-}" ] || return 1
  local payload
  payload="$(python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text":sys.argv[1]}}))' "$1" 2>/dev/null)" || return 1
  curl -fsS --max-time 8 -H 'Content-Type: application/json' -d "$payload" "$MONITOR_FEISHU_WEBHOOK" >/dev/null 2>&1
}

emit_alert() {
  # $1=key $2=severity $3=event(alert|repeat|resolve|event) $4=text
  local delivered=false
  if send_feishu "$4"; then delivered=true; fi
  {
    printf '{"ts":%s,"host":%s,"key":%s,"severity":%s,"event":%s,"message":%s,"delivered":%s}\n' \
      "$(json_escape "$NOW_ISO")" "$(json_escape "$HOSTNAME_SHORT")" "$(json_escape "$1")" \
      "$(json_escape "$2")" "$(json_escape "$3")" "$(json_escape "$4")" "$delivered"
  } >> "$ALERTS_FILE" 2>/dev/null || true
}

fmt_duration() {
  local s="$1"
  if [ "$s" -ge 3600 ]; then printf '%dh%dm' "$((s / 3600))" "$(((s % 3600) / 60))"
  elif [ "$s" -ge 60 ]; then printf '%dm' "$((s / 60))"
  else printf '%ds' "$s"; fi
}

# --------------------------------------------------------------------------
# 探测 1：HTTP health
# --------------------------------------------------------------------------
if ! curl -fsS --max-time 5 "$ADMIN_HEALTH_URL" >/dev/null 2>&1; then
  add_problem "admin_health" "CRITICAL" "Admin Portal health 探测失败（${ADMIN_HEALTH_URL}）"
fi
if ! curl -fsS --max-time 5 "$GATEWAY_HEALTH_URL" >/dev/null 2>&1; then
  add_problem "gateway_health" "CRITICAL" "Gateway health 探测失败（${GATEWAY_HEALTH_URL}）"
fi

# --------------------------------------------------------------------------
# 探测 2+3：systemd 服务状态 + 管理面探活
# --------------------------------------------------------------------------
MANAGER_DEAD=0
if [ "$SKIP_SYSTEMD" != "1" ]; then
  for svc in "$GATEWAY_SVC" "$ADMIN_SVC"; do
    out="$(timeout "$SYSTEMCTL_TIMEOUT" systemctl is-active "$svc" 2>&1)"
    rc=$?
    if [ "$rc" -eq 124 ] || printf '%s' "$out" | grep -qE 'Failed to activate service|Failed to retrieve|Connection timed out'; then
      MANAGER_DEAD=1
    elif [ "$out" != "active" ]; then
      add_problem "svc_${svc}" "CRITICAL" "systemd 服务 ${svc} 状态异常：${out:-unknown}（rc=${rc}）"
    fi
  done
  if [ "$MANAGER_DEAD" -eq 1 ]; then
    add_problem "systemd_manager" "CRITICAL" "systemctl 调用超时/总线报错——systemd 管理面疑似失效（服务可能仍在跑但机器不可运维，发版会失败；参照 2026-07-04 事件，需计划内 reboot -f）"
  fi
fi

# --------------------------------------------------------------------------
# 探测 4：NRestarts 增量 + SEGV 计数（事件型；管理面死亡时跳过以免误报）
# --------------------------------------------------------------------------
LAST_CHECK_EPOCH="$(state_get last_check_epoch)"
case "$LAST_CHECK_EPOCH" in ''|*[!0-9]*) LAST_CHECK_EPOCH=$((NOW_EPOCH - 300)) ;; esac

if [ "$SKIP_SYSTEMD" != "1" ] && [ "$MANAGER_DEAD" -eq 0 ]; then
  for svc in "$GATEWAY_SVC" "$ADMIN_SVC"; do
    cur="$(timeout "$SYSTEMCTL_TIMEOUT" systemctl show "$svc" -p NRestarts --value 2>/dev/null || true)"
    case "$cur" in
      ''|*[!0-9]*) state_set "nrestarts_$svc" "$(state_get "nrestarts_$svc")" ;;
      *)
        prev="$(state_get "nrestarts_$svc")"
        case "$prev" in ''|*[!0-9]*) prev="" ;; esac
        if [ -n "$prev" ] && [ "$cur" -gt "$prev" ]; then
          emit_alert "restarts_$svc" "WARNING" "event" \
            "[yomajiahr-monitor] WARNING $HOSTNAME_SHORT: ${svc} 自动重启次数 ${prev} → ${cur}（区间 $(fmt_duration $((NOW_EPOCH - LAST_CHECK_EPOCH)))）"
        fi
        state_set "nrestarts_$svc" "$cur"
        ;;
    esac
  done

  SINCE_ARG="@$LAST_CHECK_EPOCH"
  segv_count="$(journalctl -u "$GATEWAY_SVC" --since "$SINCE_ARG" --no-pager -q 2>/dev/null | grep -cE 'SEGV|code=dumped' || true)"
  case "$segv_count" in ''|*[!0-9]*) segv_count=0 ;; esac
  if [ "$segv_count" -gt 0 ]; then
    emit_alert "segv_$GATEWAY_SVC" "WARNING" "event" \
      "[yomajiahr-monitor] WARNING $HOSTNAME_SHORT: $GATEWAY_SVC 自上次检查以来出现 $segv_count 次 SEGV/coredump（openclaw 2026.6.10 偶发基线约 1 次/7 天，频率回升需评估 Node 22 降级；并请确认 systemctl 仍可用）"
  fi
fi
state_set "last_check_epoch" "$NOW_EPOCH"

# --------------------------------------------------------------------------
# 探测 5：磁盘 / 内存水位
# --------------------------------------------------------------------------
disk_pct="$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
case "$disk_pct" in ''|*[!0-9]*) : ;; *)
  if [ "$disk_pct" -ge "$DISK_ALERT_PCT" ]; then
    add_problem "disk_root" "WARNING" "根分区使用率 ${disk_pct}%（阈值 ${DISK_ALERT_PCT}%）"
  fi ;;
esac
if command -v free >/dev/null 2>&1; then
  mem_avail="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')"
  case "$mem_avail" in ''|*[!0-9]*) : ;; *)
    if [ "$mem_avail" -lt "$MEM_ALERT_AVAIL_MB" ]; then
      add_problem "mem_avail" "WARNING" "可用内存仅 ${mem_avail}MB（阈值 ${MEM_ALERT_AVAIL_MB}MB）"
    fi ;;
  esac
fi

# --------------------------------------------------------------------------
# 状态型告警的进入 / 静默重发 / 恢复处理
# --------------------------------------------------------------------------
printf '%s' "$PROBLEMS" | while IFS='|' read -r key severity message; do
  [ -n "$key" ] || continue
  since="$(state_get "alert_${key}_since")"
  last_sent="$(state_get "alert_${key}_last")"
  if [ -z "$since" ]; then
    emit_alert "$key" "$severity" "alert" \
      "[yomajiahr-monitor] $severity $HOSTNAME_SHORT: $message"
    state_set "alert_${key}_since" "$NOW_EPOCH"
    state_set "alert_${key}_last" "$NOW_EPOCH"
  else
    case "$last_sent" in ''|*[!0-9]*) last_sent="$since" ;; esac
    if [ $((NOW_EPOCH - last_sent)) -ge "$SILENCE_SECONDS" ]; then
      emit_alert "$key" "$severity" "repeat" \
        "[yomajiahr-monitor] $severity $HOSTNAME_SHORT: ${message}（已持续 $(fmt_duration $((NOW_EPOCH - since)))）"
      state_set "alert_${key}_since" "$since"
      state_set "alert_${key}_last" "$NOW_EPOCH"
    else
      state_set "alert_${key}_since" "$since"
      state_set "alert_${key}_last" "$last_sent"
    fi
  fi
done
# while 在子 shell 中执行，state_set 追加文件不受影响（>> 直接写文件）

# 恢复检测：上一轮 active、本轮不在问题清单里的 key
grep -o '^alert_.*_since=' "$STATE_FILE" 2>/dev/null | sed -e 's/^alert_//' -e 's/_since=$//' | while read -r key; do
  [ -n "$key" ] || continue
  if ! printf '%s' "$PROBLEMS" | grep -q "^$key|"; then
    since="$(state_get "alert_${key}_since")"
    dur=""
    case "$since" in ''|*[!0-9]*) : ;; *) dur="（故障持续 $(fmt_duration $((NOW_EPOCH - since)))）" ;; esac
    emit_alert "$key" "INFO" "resolve" \
      "[yomajiahr-monitor] RESOLVED $HOSTNAME_SHORT: $key 已恢复$dur"
  fi
done

mv "$NEW_STATE_FILE" "$STATE_FILE"
trap - EXIT
exit 0
