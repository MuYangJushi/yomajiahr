#!/usr/bin/env bash
#
# Roll back /opt/yomajiahr/current to /opt/yomajiahr/previous.
#
set -euo pipefail

INSTALL_DIR="${YOMAJIA_INSTALL_DIR:-/opt/yomajiahr}"
ADMIN_SVC="${ADMIN_SVC:-openclaw-admin}"
GATEWAY_SVC="${GATEWAY_SVC:-openclaw-gateway}"
SYSTEMD_BUS_TIMEOUT="${SYSTEMD_BUS_TIMEOUT:-120s}"

usage() {
  cat <<'EOF'
Usage: bin/rollback-release.sh [options]

Options:
  --install-dir DIR       Default: /opt/yomajiahr
  -h, --help              Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

CURRENT_USER="$(whoami)"
if [ "$CURRENT_USER" = "root" ]; then
  echo "ERROR: do not run rollback as root; run as the deploy user with sudo rights." >&2
  exit 1
fi

CURRENT_LINK="$INSTALL_DIR/current"
PREVIOUS_LINK="$INSTALL_DIR/previous"

[ -L "$PREVIOUS_LINK" ] || { echo "ERROR: previous release link not found: $PREVIOUS_LINK" >&2; exit 1; }
PREVIOUS_TARGET="$(readlink "$PREVIOUS_LINK")"
[ -n "$PREVIOUS_TARGET" ] || { echo "ERROR: previous link is empty" >&2; exit 1; }

if [ -L "$CURRENT_LINK" ]; then
  sudo ln -sfn "$(readlink "$CURRENT_LINK")" "$INSTALL_DIR/rollback-from"
fi

sudo ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"
sudo env SYSTEMD_BUS_TIMEOUT="$SYSTEMD_BUS_TIMEOUT" systemctl daemon-reload
sudo env SYSTEMD_BUS_TIMEOUT="$SYSTEMD_BUS_TIMEOUT" systemctl restart "$GATEWAY_SVC" "$ADMIN_SVC"
sudo env SYSTEMD_BUS_TIMEOUT="$SYSTEMD_BUS_TIMEOUT" systemctl is-active --quiet "$GATEWAY_SVC"
sudo env SYSTEMD_BUS_TIMEOUT="$SYSTEMD_BUS_TIMEOUT" systemctl is-active --quiet "$ADMIN_SVC"

echo "Rolled back to $PREVIOUS_TARGET"
