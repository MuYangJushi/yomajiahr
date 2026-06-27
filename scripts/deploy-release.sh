#!/usr/bin/env bash
#
# Upload and apply a local release artifact to the production host.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="yomakit"
EXPECTED_IP="220.154.138.130"
ARTIFACT=""

usage() {
  cat <<'EOF'
Usage: scripts/deploy-release.sh [--target yomakit] [--artifact path]

If --artifact is omitted, the newest dist/releases/yomajiahr-*-linux-x64.tar.gz is used.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$TARGET" != "yomakit" ]; then
  echo "ERROR: production target is yomakit; refused target '$TARGET'." >&2
  exit 1
fi

if [ -z "$ARTIFACT" ]; then
  ARTIFACT="$(find "$REPO_DIR/dist/releases" -maxdepth 1 -name 'yomajiahr-*-linux-x64.tar.gz' -type f 2>/dev/null | sort | tail -1)"
fi
[ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ] || { echo "ERROR: release artifact not found." >&2; exit 1; }
CHECKSUM="$ARTIFACT.sha256"
[ -f "$CHECKSUM" ] || { echo "ERROR: checksum not found: $CHECKSUM" >&2; exit 1; }

SSH_HOST="$(ssh -G "$TARGET" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')"
if [ "$SSH_HOST" != "$EXPECTED_IP" ]; then
  echo "ERROR: ssh '$TARGET' resolves to '$SSH_HOST', expected $EXPECTED_IP." >&2
  exit 1
fi

REMOTE_USER="$(ssh "$TARGET" 'whoami')"
if [ "$REMOTE_USER" != "ubuntu" ]; then
  echo "ERROR: remote user is '$REMOTE_USER', expected ubuntu." >&2
  exit 1
fi

echo "Verified SSH target: $TARGET -> $EXPECTED_IP as $REMOTE_USER"
ssh "$TARGET" 'printf "Remote host: "; hostname; printf "Remote addresses: "; hostname -I 2>/dev/null || true'

REMOTE_DIR="/tmp/yomajiahr-releases"
REMOTE_APPLY="/tmp/yomajiahr-apply-$(date -u +%Y%m%dT%H%M%SZ)-$$"
BASE="$(basename "$ARTIFACT")"

echo "Uploading $BASE to $TARGET..."
ssh "$TARGET" "mkdir -p '$REMOTE_DIR' '$REMOTE_APPLY'"
scp "$ARTIFACT" "$CHECKSUM" "$TARGET:$REMOTE_DIR/"

echo "Applying release on $TARGET..."
ssh "$TARGET" "bash -s" <<EOF
set -euo pipefail
cd '$REMOTE_DIR'
sha256sum -c '$(basename "$CHECKSUM")'
tar -xzf '$BASE' -C '$REMOTE_APPLY'
bash '$REMOTE_APPLY/bin/apply-release.sh' --staged-dir '$REMOTE_APPLY'
rm -rf '$REMOTE_APPLY'
EOF

echo "Deployment complete."
