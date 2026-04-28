# immunity-demo

Demo orchestration for the [Immunity protocol](https://immunity-protocol.com): 60 containerized AI agents producing continuous, realistic on-chain activity against the live 0G Galileo testnet, plus an interactive `/playground` UI for triggering specific scenarios on demand.

The fleet is the heart of the demo. When it's running, the network looks alive.

> Hackathon-only. Test mnemonics, public testnet, MockUSDC. Do not point at mainnet.

## Topology

```
+----------------------------------------------------------------+
|  immunity-demo docker-compose                                  |
|                                                                |
|   +-----------+    +-----------+    +-----------+              |
|   | trader-1  |    | trader-2  |... | trader-50 |   60 agents  |
|   +-----------+    +-----------+    +-----------+              |
|   +-----------+    +-----------+    +-----------+              |
|   |  wolf-N   |    |publisher-N|    | watcher-1 |              |
|   +-----------+    +-----------+    +-----------+              |
|                                                                |
|   +--------------+                                             |
|   |  axl-spoke   |  <- ghcr.io/immunity-protocol/axl-hub       |
|   +--------------+                                             |
+--------------------|-------------------------------------------+
                     | docker network: immunity-app_default
                     v
+----------------------------------------------------------------+
|  immunity-app stack                                            |
|   immunity_database (postgres)  <- demo.commands queue          |
|   indexer / relayer / api / web                                 |
+----------------------------------------------------------------+
```

Agents read commands from `demo.commands`, write heartbeats to `demo.agent_heartbeat`, and call the live Immunity SDK (`immunity.check()`, `immunity.publish()`) which settles on the 0G Galileo Registry contract. The app's indexer picks up the on-chain events and populates the dashboard.

## Host requirements

- Docker + Docker Compose v2
- 4 GB+ RAM (60 agent containers + axl-spoke ~ 3.5 GB)
- 2+ CPU cores
- Same host as the running `immunity-app` stack so the agents can reach `immunity_database` over the app's docker network

A Hetzner CPX21 / DigitalOcean $24-tier droplet is enough.

## Bootstrap (one-time per host)

1. **Clone and install**:
   ```sh
   git clone https://github.com/ophelios-studio/immunity-demo
   cd immunity-demo
   npm install
   ```

2. **Copy and edit env**:
   ```sh
   cp .env.example .env
   # Fill in DEPLOYER_PRIVATE_KEY (must hold ~18 OG and ~80 USDC).
   # Adjust DATABASE_URL if your immunity-app uses a different host name.
   ```

3. **Apply the demo schema** (in immunity-app):
   ```sh
   cd ../immunity-app
   php bin/init-database.php
   cd ../immunity-demo
   ```
   Confirms `demo.commands`, `demo.fleet_state`, `demo.agent_heartbeat` exist.

4. **Fund agents with OG gas** (~18 OG total):
   ```sh
   npm run fund:og
   ```

5. **Publish the curated threat data** (~70 antibodies, ~80 USDC stake):
   ```sh
   npm run threats:publish
   ```
   Idempotent. Re-running skips already-published entries via `.publish-state.json`.

6. **Bring the fleet up**:
   ```sh
   ./scripts/start-fleet.sh
   ```
   Builds the agent image once, then launches 60 agent containers + axl-spoke. `docker compose ps` should show all `running`.

7. **Verify**:
   ```sh
   ./scripts/status.sh
   ```
   Should report 60 agents online within 60 seconds.

## Day-to-day

- **Pause / resume ambient**: `./scripts/pause-fleet.sh`, `./scripts/resume-fleet.sh`. Same effect as the `/playground` admin buttons. Scenario commands still execute when paused.
- **Trigger a scripted scenario**: `./scripts/run-scenario.sh 01` (or `fresh-detection`, etc.).
- **Reset everything except the AXL identity**: `./scripts/reset.sh`. Truncates the queue and heartbeat table; keeps `axl-data` so peers don't see a fresh identity.
- **Regenerate compose** after editing `agents/src/wallets.ts` or `display_names.ts`: `npm run compose:generate`.

## /playground

The interactive surface for the live demo lives in the app, not here. Once the fleet is up, hit `https://<your-app>/playground`, log in with `PLAYGROUND_PASSWORD` (judge tier) or upgrade with `ADMIN_PASSWORD` (admin tier). Three sections:

1. **Status bar** - live fleet health, polled every 3s.
2. **Test scenarios** - 8 interactive cards (test an address, publish a threat, send a malicious payload, trigger an attack, cache replay, cross-chain mirror status, publisher earnings, resilience test).
3. **Pitch controls** (admin only) - one-click scripted scenarios, pause/resume, manual queue insertion.

## Repository layout

```
demo/
  agents/           # TypeScript agent (one Dockerfile, parameterised by env)
    src/
      agent.ts             # main loop
      ambient/             # per-role ambient behaviour
      commands/            # operator-driven command handlers
  threats/          # curated antibody seed data (5 files, ~70 entries)
  scripts/          # generate-compose, fund-agents-og, publish-threats, ...
  scenarios/        # 5 scripted demo moments
  infrastructure/   # axl-spoke notes, pipedream webhook docs
  docker-compose.yml  # generated; commit after regenerating
```

## License

Apache-2.0.
