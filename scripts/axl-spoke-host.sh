#!/usr/bin/env bash
#
# Spin up a single AXL spoke container for host-run scripts (chiefly
# `npm run threats:publish`). The spoke is bound to 127.0.0.1:9002 so
# scripts on the workstation can reach it as http://localhost:9002 — set
# AXL_URL to that when running orchestration scripts:
#
#     ./scripts/axl-spoke-host.sh up
#     AXL_URL=http://localhost:9002 npm run threats:publish
#     ./scripts/axl-spoke-host.sh down
#
# Standalone (no compose network deps) so the script works even when the
# full `immunity-app_default` network does not exist locally.
#
# This is a developer convenience. The actual fleet uses docker-compose
# (the spoke service in docker-compose.yml) which attaches to the shared
# immunity-app network and is reachable from agent containers as
# http://axl-spoke:9002.
set -euo pipefail

NAME="immunity-axl-spoke-host"
IMAGE="ghcr.io/immunity-protocol/axl-hub:latest"
VOLUME="immunity-axl-data-host"

cmd="${1:-up}"

case "$cmd" in
  up)
    if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
      echo "${NAME} already running"
      exit 0
    fi
    docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
    echo "starting ${NAME} on 127.0.0.1:9002…"
    docker run -d --rm \
      --name "$NAME" \
      -p 127.0.0.1:9002:9002 \
      -e AXL_CONFIG=/etc/axl/spoke.json \
      -e KEY_PATH=/data/private.pem \
      -v "${VOLUME}:/data" \
      "$IMAGE" >/dev/null
    echo "waiting for /topology…"
    for _ in $(seq 1 30); do
      if curl -fsS http://127.0.0.1:9002/topology >/dev/null 2>&1; then
        echo "ready: AXL_URL=http://localhost:9002"
        exit 0
      fi
      sleep 1
    done
    echo "spoke did not become ready in 30s; check logs with: docker logs ${NAME}" >&2
    exit 1
    ;;
  down)
    if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
      docker stop "$NAME" >/dev/null
      echo "${NAME} stopped"
    else
      echo "${NAME} not running"
    fi
    ;;
  status)
    if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
      echo "running"
      curl -s http://127.0.0.1:9002/topology | head -1
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 2
    ;;
esac
