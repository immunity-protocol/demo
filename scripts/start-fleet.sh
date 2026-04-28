#!/usr/bin/env bash
#
# Bring the demo fleet up. Sanity-checks env, then `docker compose up -d`.
#
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env missing. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Source the env so we can pre-flight-check critical vars.
set -o allexport
# shellcheck disable=SC1091
source .env
set +o allexport

REQUIRED=(MASTER_SEED DEPLOYER_PRIVATE_KEY MOCK_USDC_ADDRESS DATABASE_URL AXL_URL)
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set in .env" >&2
    exit 1
  fi
done

NET_NAME="${IMMUNITY_DEMO_NETWORK:-immunity-app_default}"
if ! docker network inspect "$NET_NAME" >/dev/null 2>&1; then
  echo "ERROR: docker network '$NET_NAME' does not exist." >&2
  echo "       Start the immunity-app stack first, or set IMMUNITY_DEMO_NETWORK to its actual network name." >&2
  exit 1
fi

echo "starting axl-spoke + 60 agents on network '$NET_NAME'…"
docker compose up -d --build
echo
docker compose ps
