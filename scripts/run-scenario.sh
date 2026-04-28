#!/usr/bin/env bash
#
# Apply a scenario file from /scenarios. .sql files run via psql, .sh files
# are exec'd directly.
#
# Usage:
#   ./scripts/run-scenario.sh 01            # runs scenarios/01-*
#   ./scripts/run-scenario.sh fresh         # case-insensitive substring
#
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "usage: $0 <scenario-prefix-or-substring>" >&2
  echo "available:"
  ls scenarios/ | grep -E '\.(sql|sh)$' | sed 's/^/  /' >&2
  exit 1
fi

QUERY="$1"
MATCH=$(ls scenarios/ | grep -i -E "(^${QUERY}|${QUERY})" | grep -E '\.(sql|sh)$' | head -1 || true)
if [ -z "$MATCH" ]; then
  echo "no scenario matched '$QUERY'" >&2
  exit 1
fi

PATH_TO="scenarios/$MATCH"
echo "→ $PATH_TO"

case "$PATH_TO" in
  *.sql)
    set -o allexport
    # shellcheck disable=SC1091
    [ -f .env ] && source .env
    set +o allexport
    if [ -z "${DATABASE_URL:-}" ]; then
      echo "ERROR: DATABASE_URL not set." >&2
      exit 1
    fi
    docker run --rm --network "${IMMUNITY_DEMO_NETWORK:-immunity-app_default}" \
        -v "$(pwd)/$PATH_TO:/scenario.sql:ro" \
        postgres:16-alpine \
        psql "$DATABASE_URL" -f /scenario.sql
    ;;
  *.sh)
    bash "$PATH_TO"
    ;;
esac
