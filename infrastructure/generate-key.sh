#!/bin/sh
# Idempotent ed25519 keygen for ALL AXL spokes in the packed fleet.
#
# Reads the agent roster from /etc/axl/spoke-roster.txt (one agent_id
# per line, generated alongside supervisord.conf by
# scripts/generate-supervisor-conf.ts) and ensures that
# /data/spoke-<agent_id>.pem exists for each. Pre-existing keys are
# reused so peer ids stay stable across container restarts on the
# mounted Fly volume.
#
# Losing /data/spoke-*.pem means every spoke gets a fresh peer id on
# next boot, which breaks any hub that has the old ids cached. Treat
# /data as load-bearing.

set -eu

ROSTER_PATH="${ROSTER_PATH:-/etc/axl/spoke-roster.txt}"
KEY_DIR="${KEY_DIR:-/data}"

if [ ! -f "$ROSTER_PATH" ]; then
  echo "key: roster file missing at $ROSTER_PATH; nothing to generate" >&2
  exit 1
fi

mkdir -p "$KEY_DIR"

generated=0
reused=0
while IFS= read -r agent_id || [ -n "$agent_id" ]; do
  # Skip blank lines and comments.
  case "$agent_id" in ""|"#"*) continue ;; esac

  key_path="$KEY_DIR/spoke-$agent_id.pem"
  if [ -f "$key_path" ]; then
    reused=$((reused + 1))
    continue
  fi

  openssl genpkey -algorithm ed25519 -out "$key_path"
  chmod 600 "$key_path"
  generated=$((generated + 1))
done < "$ROSTER_PATH"

echo "key: $generated generated, $reused reused (path=$KEY_DIR)"
