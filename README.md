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
   ./scripts/fleet -t local boot
   ```
   Builds the agent image, launches 60 agent containers + axl-spoke, then auto-attaches `docker compose logs -f`. Ctrl-C detaches the log stream without stopping the fleet. `docker compose ps` should show all `running`.

7. **Verify**:
   ```sh
   ./scripts/fleet -t local status
   ```
   Should report 60 agents online within 60 seconds.

## Fleet CLI

`scripts/fleet` is the canonical operator entrypoint. It wraps every shell script under `scripts/` plus the relevant `flyctl` calls, behind a single CLI with explicit `-t local` / `-t prod` target selection. Same code paths, just one place to remember.

```sh
./scripts/fleet help            # full command surface
./scripts/fleet help <command>  # per-command details (boot, logs, etc.)
npm run fleet -- -t local boot  # equivalent npm alias (note the --)
```

**Targets are required.** Every command (except `help`) needs `-t local` or `-t prod` — there's no smart default. This is deliberate: pause-the-wrong-fleet bugs are loud failures otherwise.

| Command | `-t local` | `-t prod` |
|---|---|---|
| `boot` | `start-fleet.sh` then auto-attaches logs | `fly-boot.sh` then auto-attaches `flyctl logs` |
| `boot --deploy` | flag rejected (use `boot` directly; compose `--build` runs every boot) | runs `deploy` first (image push + secret sync), then `fly-boot.sh` |
| `stop` | `stop-fleet.sh` | `fly-shutdown.sh` |
| `reset` | `reset.sh` (compose down + truncate demo tables) | local-only, errors |
| `status` | `docker compose ps` + `status.sh` | `flyctl status` + DB snapshot via ssh+psql |
| `pause` / `resume` | `pause-fleet.sh` / `resume-fleet.sh` (local Postgres) | `flyctl ssh -a immunity-app -C 'psql … UPDATE demo.fleet_state …'` |
| `logs` | `docker compose logs -f [agent]` | `flyctl logs -a immunity-fleet` (agent name folded into a grep) |
| `scenario <prefix>` | `run-scenario.sh <prefix>` | local-only, errors |
| `publish-threats` | spins up local axl-spoke, runs `npm run threats:publish` | workstation-only, errors with hint |
| `fund-og` | `npm run fund:og` | same (target-agnostic, signs with local `DEPLOYER_PRIVATE_KEY`) |
| `deploy` | prod-only, errors | syncs `ANTHROPIC_API_KEY` from `.env` to Fly secrets, then `flyctl deploy -c fly_fleet.toml --remote-only` |
| `exec` | `docker compose exec <agent> [cmd]` | `flyctl ssh console -a immunity-fleet -C "<cmd>"` |

### Filter presets for `logs`

`logs --filter <preset>` greps the stream for the patterns the demo's success paths emit. Presets compose with `--grep <regex>` for further narrowing.

| Preset | Matches |
|---|---|
| `blocks` | `ambient block`, `antibody=IMM`, `source=cache`, `social_dm blocked`, `social_feed scan: blocked` |
| `attacks` | `wolf social`, `inject_prompt`, `axl_dm`, `social_feed_post`, `wolf attack` |
| `mints` | `publisher minted`, `seedDerived=true`, `TEE outcome`, `publisher scanning` |
| `incidents` | `incidentFamily=`, `incidentVariant=`, `incidentSurface=` |
| `errors` | `"level":"error"`, `"level":"warn"`, `fatal` |

### Worked examples

```sh
# First prod boot after code changes: build+push a fresh image, sync the
# ANTHROPIC_API_KEY secret from local .env, then scale to 1 machine.
./scripts/fleet -t prod boot --deploy

# Subsequent restarts (code unchanged) — just scale up the existing image.
./scripts/fleet -t prod boot
^C                                       # detach logs (fleet keeps running)
./scripts/fleet -t prod logs --filter blocks --tail 200
./scripts/fleet -t prod logs --filter attacks --grep trader-15

# Pause prod ambient before a live demo (manual scenarios still execute).
./scripts/fleet -t prod pause
# … run scripted scenarios via the playground …
./scripts/fleet -t prod resume

# Local round-trip during development.
./scripts/fleet -t local boot --no-follow   # boot without auto-attach
./scripts/fleet -t local logs trader-1 --filter incidents
./scripts/fleet -t local exec wolf-1 sh     # interactive shell inside one container
./scripts/fleet -t local stop

# Genesis publish (workstation-only; uses local axl spoke automatically).
./scripts/fleet -t local publish-threats
LIMIT=3 ./scripts/fleet -t local publish-threats   # smoke-test with 3 entries
PUBLISH_TIMEOUT_MS=180000 ./scripts/fleet -t local publish-threats
```

### Day-to-day, also

- **Regenerate compose** after editing `agents/src/wallets.ts` or `display_names.ts`: `npm run compose:generate`.
- **Regenerate supervisord** for the Fly deployment: `npm run supervisor:generate`.
- The individual scripts (`start-fleet.sh`, `pause-fleet.sh`, `fly-boot.sh`, …) still work and remain authoritative; the CLI is a thin wrapper, not a replacement.

## Deploying to Fly.io

For a showcase you don't want to be tethered to your laptop. The fleet packs into one Fly machine (`immunity-fleet`) — same agent code, supervisord runs the spoke + 60 agents inside one image. Cost: ~$60/mo always-on, or `fly scale count 0` between sessions for ~$0/day.

### One-time setup

```sh
# 1. Create the app + persistent volume for the AXL spoke identity.
fly apps create immunity-fleet --org ophelios
fly volumes create immunity_fleet_data --app immunity-fleet --region yyz --size 1 --yes

# 2. Stage secrets (will roll out on first deploy).
fly secrets set \
  MASTER_SEED="$(grep '^MASTER_SEED=' .env | cut -d= -f2- | sed 's/^"//;s/"$//')" \
  DEPLOYER_PRIVATE_KEY="$(grep '^DEPLOYER_PRIVATE_KEY=' .env | cut -d= -f2-)" \
  MOCK_USDC_ADDRESS="$(grep '^MOCK_USDC_ADDRESS=' .env | cut -d= -f2-)" \
  DATABASE_URL='postgres://postgres:<PASSWORD>@immunity-db.flycast:5432/immunity' \
  --app immunity-fleet --stage

# 3. First deploy. Builds Dockerfile.fly (compiles axl from source +
#    builds the agent JS + bundles supervisord), uploads, runs the
#    machine. Boot takes ~15 min for the full ramp (60 agents start
#    staggered 500ms apart, then each pays a few funding+RPC round-trips).
fly deploy --config fly_fleet.toml --app immunity-fleet --remote-only
```

### Day-to-day

The unified `scripts/fleet` CLI handles all of these — the explicit table below is the underlying primitive each command wraps.

| Want to | CLI | Underlying |
|---|---|---|
| Boot the swarm | `./scripts/fleet -t prod boot` | `fly scale count 1`, agents come up over ~5 min |
| Tail logs | `./scripts/fleet -t prod logs` | `fly logs --app immunity-fleet` |
| Filtered logs | `./scripts/fleet -t prod logs --filter mints` | `fly logs ... \| grep -E '<preset>'` |
| Pause ambient | `./scripts/fleet -t prod pause` | `flyctl ssh ... psql -c "UPDATE demo.fleet_state ..."` (also reachable from `/playground` admin tier) |
| Resume ambient | `./scripts/fleet -t prod resume` | symmetric |
| Fully shut down | `./scripts/fleet -t prod stop` | `fly scale count 0`, billing stops; spoke identity preserved |
| Inspect supervisord | `./scripts/fleet -t prod exec 'supervisorctl status'` | Lists all 60 agent processes + the spoke |
| Deploy a new image | `./scripts/fleet -t prod deploy` | `flyctl deploy -c fly_fleet.toml --remote-only` |

### What's in the image

- `Dockerfile.fly` — multi-stage: builds axl-hub from source (Go), builds the agent JS (Node), runtime stage with `supervisord` + both binaries.
- `infrastructure/supervisord.conf` — generated. 1 spoke + 60 agent program blocks. Each agent has its `STARTUP_DELAY_MS` baked in (500ms × ordinal) to stagger boot and avoid blowing past the 0G public RPC's 50 req/s burst cap.
- `infrastructure/axl-spoke.json` — spoke config (peers `hub-can` + `hub-usa`).
- `infrastructure/generate-key.sh` — idempotent ed25519 keygen for the spoke identity (`/data/private.pem`).
- `fly_fleet.toml` — Fly app config: shared-cpu-4x / 8GB, mounts `/data`, no HTTP service.

After editing the agent enumeration (`agents/src/wallets.ts` or `display_names.ts`), regenerate both the local compose and the Fly supervisord conf:

```sh
npm run compose:generate
npm run supervisor:generate
```

The full Fly network (all 6 apps) is documented in `immunity-app/README.md` under `## Infrastructure`.

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
