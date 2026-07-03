#!/usr/bin/env bash
#
# yomajiahr-monitor.sh 本地自测（macOS/Linux 均可跑，无需 systemd）。
#
# 场景覆盖：
#   1. 全部健康 → 无告警
#   2. admin health 挂 → alert 一条（落盘 + mock webhook 收到）
#   3. 静默窗口内重复探测 → 不重发
#   4. 恢复 → RESOLVED 一条
#   5. 未配置 webhook → 告警仍落盘 delivered=false
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/yomajiahr-monitor.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; kill $HEALTH_PID $HOOK_PID 2>/dev/null || true' EXIT

PASS=0
FAIL=0
check() { # $1=描述 $2=条件表达式结果(0/1 传入 $?)
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); echo "  ok: $1"
  else FAIL=$((FAIL + 1)); echo "  FAIL: $1"; fi
}

# mock health 端点（一个 server 服务两个 URL）
HEALTH_PORT=28791
python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(('127.0.0.1', $HEALTH_PORT), H).serve_forever()
" &
HEALTH_PID=$!

# mock 飞书 webhook：把每次 POST body 追加到文件
HOOK_PORT=28792
HOOK_LOG="$WORK/webhook.log"
python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode('utf-8', 'replace')
        with open('$HOOK_LOG', 'a') as f: f.write(body + '\n')
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(('127.0.0.1', $HOOK_PORT), H).serve_forever()
" &
HOOK_PID=$!
sleep 1

STATE="$WORK/state-dir"
mkdir -p "$STATE"
ALERTS="$STATE/data/monitor/alerts.jsonl"

run_monitor() { # $1=admin url $2=gateway url [$3=webhook]
  OPENCLAW_STATE_DIR="$STATE" \
  MONITOR_ADMIN_URL="$1" \
  MONITOR_GATEWAY_URL="$2" \
  MONITOR_FEISHU_WEBHOOK="${3:-}" \
  MONITOR_SKIP_SYSTEMD=1 \
  bash "$MONITOR"
}

GOOD="http://127.0.0.1:$HEALTH_PORT/health"
BAD="http://127.0.0.1:1/nope"
HOOK="http://127.0.0.1:$HOOK_PORT/hook"

echo "场景 1：全部健康 → 无告警"
run_monitor "$GOOD" "$GOOD" "$HOOK"
[ ! -s "$ALERTS" ]; check "alerts.jsonl 为空" $?

echo "场景 2：admin 挂 → alert 落盘 + webhook 送达"
run_monitor "$BAD" "$GOOD" "$HOOK"
grep -q '"key": *"admin_health"' "$ALERTS" 2>/dev/null || grep -q '"key":"admin_health"' "$ALERTS"; check "落盘 admin_health alert" $?
grep -q '"event":"alert"' "$ALERTS"; check "event=alert" $?
grep -q '"delivered":true' "$ALERTS"; check "delivered=true" $?
grep -q 'Admin Portal health' "$HOOK_LOG"; check "webhook 收到告警文本" $?

echo "场景 3：静默窗口内重复 → 不重发"
lines_before="$(wc -l < "$ALERTS")"
run_monitor "$BAD" "$GOOD" "$HOOK"
lines_after="$(wc -l < "$ALERTS")"
[ "$lines_before" -eq "$lines_after" ]; check "静默期无新告警行" $?

echo "场景 4：恢复 → RESOLVED"
run_monitor "$GOOD" "$GOOD" "$HOOK"
grep -q '"event":"resolve"' "$ALERTS"; check "落盘 resolve" $?
grep -q 'RESOLVED' "$HOOK_LOG"; check "webhook 收到 RESOLVED" $?
run_monitor "$GOOD" "$GOOD" "$HOOK"
resolve_count="$(grep -c '"event":"resolve"' "$ALERTS")"
[ "$resolve_count" -eq 1 ]; check "RESOLVED 只发一次" $?

echo "场景 5：无 webhook → 落盘 delivered=false"
STATE2="$WORK/state-dir-2"; mkdir -p "$STATE2"
ALERTS2="$STATE2/data/monitor/alerts.jsonl"
OPENCLAW_STATE_DIR="$STATE2" MONITOR_ADMIN_URL="$BAD" MONITOR_GATEWAY_URL="$GOOD" \
  MONITOR_SKIP_SYSTEMD=1 bash "$MONITOR"
grep -q '"delivered":false' "$ALERTS2"; check "无 webhook 时 delivered=false 仍落盘" $?

echo
echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
