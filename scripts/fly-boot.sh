#!/usr/bin/env bash
#
# Boot the Immunity demo fleet on Fly.io. Scales the immunity-fleet app to
# 1 machine, waits for it to come up, and prints the agent count from
# `fly logs` so you can confirm all 60 agents are alive.
#
# Pause/resume of ambient activity (without stopping the machine) is
# handled from /playground -> admin tier, not here.
#
# Usage:
#   ./scripts/fly-boot.sh
#
# Cost while booted: ~$2/day on shared-cpu-4x/8GB.

set -euo pipefail

APP="${IMMUNITY_FLEET_APP:-immunity-fleet}"

echo "boot: scaling $APP to 1 machine…"
fly scale count 1 --app "$APP" --yes

echo "boot: waiting up to 90s for the machine to reach 'started'…"
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(fly status --app "$APP" --json 2>/dev/null | grep -o '"state":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$state" = "started" ]; then
    echo "boot: machine started"
    break
  fi
  sleep 5
done

echo
echo "boot: agents (look for ~60 lines over the next ~2 min)…"
fly logs --app "$APP" --no-tail 2>/dev/null | grep -c '"msg":"agent ready"' || true
echo
echo "boot: tail logs with:    fly logs --app $APP"
echo "boot: shut it down with: ./scripts/fly-shutdown.sh"
