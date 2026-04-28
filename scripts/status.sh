#!/usr/bin/env bash
#
# Quick status: agents online by role, ambient state, recent command queue
# depth. Pretty-prints from `demo.*` tables.
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

NETWORK="${IMMUNITY_DEMO_NETWORK:-immunity-app_default}"

docker run --rm --network "$NETWORK" postgres:16-alpine \
    psql "$DATABASE_URL" <<'SQL'
\echo '── Fleet state ─────────────────────────────────────────────────'
SELECT ambient_paused, paused_at FROM demo.fleet_state WHERE id = 1;

\echo
\echo '── Agents online by role (last 120s) ───────────────────────────'
SELECT role,
       count(*)                                                AS online,
       max(now() - last_seen)::text                            AS oldest_seen
  FROM demo.agent_heartbeat
 WHERE last_seen >= now() - interval '120 seconds'
 GROUP BY role
 ORDER BY role;

\echo
\echo '── Pending commands by agent ───────────────────────────────────'
SELECT agent_id, count(*) AS pending
  FROM demo.commands
 WHERE picked_up_at IS NULL
 GROUP BY agent_id
 ORDER BY pending DESC, agent_id
 LIMIT 20;

\echo
\echo '── Last 10 completed commands ──────────────────────────────────'
SELECT id, agent_id, command_type, result_status, executed_at
  FROM demo.commands
 WHERE executed_at IS NOT NULL
 ORDER BY executed_at DESC
 LIMIT 10;
SQL
