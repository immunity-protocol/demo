#!/usr/bin/env bash
#
# Resume ambient activity after pause-fleet.sh. The flag flip is observed by
# every agent on its next tick (≤ AGENT_TICK_MAX_MS).
#
set -euo pipefail
cd "$(dirname "$0")/.."

set -o allexport
# shellcheck disable=SC1091
[ -f .env ] && source .env
set +o allexport

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set." >&2
  exit 1
fi

docker run --rm --network "${IMMUNITY_DEMO_NETWORK:-immunity-app_default}" \
    postgres:16-alpine \
    psql "$DATABASE_URL" -c "UPDATE demo.fleet_state SET ambient_paused = false, paused_at = NULL WHERE id = 1;"
echo "fleet resumed."
