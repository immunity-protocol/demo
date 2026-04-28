#!/bin/sh
# Idempotent ed25519 keygen for the AXL spoke identity.
#
# AXL refuses to start with a missing PrivateKeyPath, but happily reuses the
# file if it already exists. Generating once on first boot and persisting on
# the mounted Fly volume keeps the peer id stable across container restarts.
#
# Losing this file means the spoke gets a new peer id, which breaks every
# hub that has the old id cached. Treat /data/private.pem as load-bearing.

set -eu

KEY_PATH="${KEY_PATH:-/data/private.pem}"
KEY_DIR="$(dirname "$KEY_PATH")"

mkdir -p "$KEY_DIR"

if [ -f "$KEY_PATH" ]; then
  echo "key: reusing existing $KEY_PATH"
  exit 0
fi

echo "key: generating new ed25519 identity at $KEY_PATH"
openssl genpkey -algorithm ed25519 -out "$KEY_PATH"
chmod 600 "$KEY_PATH"
