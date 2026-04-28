#!/usr/bin/env bash
#
# Fully shut down the Immunity demo fleet on Fly.io. Scales the
# immunity-fleet app to 0 machines so billing stops. The Fly volume
# (immunity_fleet_data) is preserved, so the spoke's ed25519 identity
# survives the shutdown -- next boot reuses it.
#
# Usage:
#   ./scripts/fly-shutdown.sh

set -euo pipefail

APP="${IMMUNITY_FLEET_APP:-immunity-fleet}"

echo "shutdown: scaling $APP to 0 machines…"
fly scale count 0 --app "$APP" --yes

echo "shutdown: status:"
fly status --app "$APP"
