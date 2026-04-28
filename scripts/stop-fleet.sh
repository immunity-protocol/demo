#!/usr/bin/env bash
#
# Graceful shutdown — sends SIGTERM via `docker compose stop`, agents drain
# their current tick, close pg pool + immunity gossip, then exit.
#
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose stop
docker compose ps
