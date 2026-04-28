#!/usr/bin/env bash
#
# Pause ambient activity. Agents continue picking up scenario commands but
# stop generating their own background traffic. Used during the live pitch
# when you want a quiet stage between scripted moments.
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
    psql "$DATABASE_URL" -c "UPDATE demo.fleet_state SET ambient_paused = true, paused_at = now() WHERE id = 1;"
echo "fleet paused."
