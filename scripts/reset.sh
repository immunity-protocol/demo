#!/usr/bin/env bash
#
# Full reset: tears down all agent containers, clears the demo command queue
# and heartbeat table, but keeps the AXL spoke's identity volume so peers
# don't see a fresh wallet on every restart.
#
# Use when you want to rerun the demo from a clean slate without
# re-publishing threats.
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "stopping containers…"
docker compose down --remove-orphans

if [ -n "${DATABASE_URL:-}" ] || [ -f .env ]; then
  set -o allexport
  # shellcheck disable=SC1091
  [ -f .env ] && source .env
  set +o allexport
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "WARN: DATABASE_URL not set — skipping queue + heartbeat clear" >&2
else
  echo "clearing demo.commands and demo.agent_heartbeat…"
  docker run --rm --network "${IMMUNITY_DEMO_NETWORK:-immunity-app_default}" \
      postgres:16-alpine \
      psql "$DATABASE_URL" -c "TRUNCATE demo.commands, demo.agent_heartbeat; UPDATE demo.fleet_state SET ambient_paused=false, paused_at=NULL WHERE id=1;"
fi

echo "done. Run scripts/start-fleet.sh to bring it back up."
