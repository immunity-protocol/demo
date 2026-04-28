# AXL spoke

The fleet runs a single `axl-spoke` container (`ghcr.io/immunity-protocol/axl-hub:latest`) that all 60 agents talk to at `http://axl-spoke:9002`. The image bakes in `/etc/axl/spoke.json` which dials the two team-operated Immunity hubs:

```json
{
  "PrivateKeyPath": "/data/private.pem",
  "Peers": [
    "tls://hub-can.immunity-protocol.com:9001",
    "tls://hub-usa.immunity-protocol.com:9001"
  ],
  "Listen": [],
  "bridge_addr": "0.0.0.0",
  "api_port": 9002
}
```

## Identity

The spoke's ed25519 identity is generated on first boot and persisted to the named docker volume `axl-data`. Do not delete this volume between demo runs — your peer ID is the network's stable handle for this fleet's hub view.

## Custom config (rare)

If you ever need to override the baked config (extra peers, different listen ports), drop a `spoke.json` in this directory and mount it in the compose file:

```yaml
  axl-spoke:
    volumes:
      - axl-data:/data
      - ./infrastructure/spoke.json:/etc/axl/spoke.json:ro
```

Default works for the demo.

## References

- AXL hub repo: https://github.com/ophelios-studio/axl-hub
- Hub deploy targets: `hub-can.immunity-protocol.com` (yyz), `hub-usa.immunity-protocol.com` (ewr)
