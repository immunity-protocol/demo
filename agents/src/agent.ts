import { Immunity } from "@immunity-protocol/sdk";
import { type FeeData, FeeData as FeeDataCtor, JsonRpcProvider, Wallet } from "ethers";
import { runAmbient } from "./ambient/index.js";
import { AxlClient } from "./axl/client.js";
import { drainInbox } from "./axl/inbox.js";
import { runCommand } from "./commands/index.js";
import { createClaudeTeeShim } from "./llm/claude-tee-shim.js";
import {
  closePool,
  connectPool,
  dequeueCommand,
  getFleetState,
  insertAgentActivity,
  markCommandComplete,
  upsertHeartbeat,
} from "./db.js";
import { displayNameFor } from "./display_names.js";
import { defaultFundingConfig, ensureFundedWallet, ensureTeeReady } from "./funding.js";
import { createLogger } from "./log.js";
import { deriveWallet, parseAgentId } from "./wallets.js";
import type { AmbientContext } from "./context.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

interface AgentConfig {
  agentId: string;
  masterSeed: string;
  databaseUrl: string;
  axlUrl: string;
  rpcUrl: string;
  tickMinMs: number;
  tickMaxMs: number;
}

function loadConfig(): AgentConfig {
  const env = process.env;
  const required = (key: string): string => {
    const v = env[key];
    if (v === undefined || v === "") {
      throw new Error(`missing required env var: ${key}`);
    }
    return v;
  };
  return {
    agentId:     required("AGENT_ID"),
    masterSeed:  required("MASTER_SEED"),
    databaseUrl: required("DATABASE_URL"),
    axlUrl:      required("AXL_URL"),
    rpcUrl:      env.GALILEO_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    tickMinMs:   Number.parseInt(env.AGENT_TICK_MIN_MS ?? "15000", 10),
    tickMaxMs:   Number.parseInt(env.AGENT_TICK_MAX_MS ?? "90000", 10),
  };
}

function jitteredInterval(min: number, max: number): number {
  return min + Math.floor(Math.random() * Math.max(0, max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry helper for boot-path operations that touch the 0G public RPC.
 * The testnet RPC is rate-limited (50 req/s) and occasionally returns
 * transient errors (timeouts, "no matching receipts", connection drops).
 * We absorb up to N transient failures with exponential backoff before
 * giving up; "give up" still throws so the process exits and supervisord
 * restarts us, but at least we don't die on the first blip.
 */
async function withBootRetry<T>(
  label: string,
  log: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  },
  fn: () => Promise<T>,
  attempts = 10,
): Promise<T> {
  // Exponential backoff capped at 120s. With 10 attempts, the worst-case
  // retry window is ~10 minutes — long enough that a 60-agent thundering
  // herd against the 0G RPC's 50 req/s cap eventually clears (the early
  // agents settle into their normal 45-180s tick cadence and free RPC
  // headroom for the laggards). Jitter (random 0-1s) decorrelates retries
  // so two stuck agents don't keep landing on the same throttled second.
  const MAX_BACKOFF_MS = 120_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const exp = 2_000 * Math.pow(2, i);
      const capped = Math.min(exp, MAX_BACKOFF_MS);
      const backoffMs = capped + Math.floor(Math.random() * 1_000);
      log.warn("boot step failed; retrying", { step: label, attempt: i + 1, of: attempts, backoff_ms: backoffMs, err: String(err).slice(0, 200) });
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/**
 * Galileo testnet (chain 16602) raised its minimum priority fee to 2 gwei,
 * but ethers' default `getFeeData()` over a vanilla JsonRpcProvider can
 * still return 1 gwei in periods of low congestion, which then gets
 * rejected with "transaction gas price below minimum". We wrap the
 * provider to floor the tip cap at 2 gwei.
 */
const MIN_TIP_CAP_WEI = 2_000_000_000n;

function makeProvider(rpcUrl: string): JsonRpcProvider {
  const provider = new JsonRpcProvider(rpcUrl);
  const original = provider.getFeeData.bind(provider);
  provider.getFeeData = async (): Promise<FeeData> => {
    const fee = await original();
    const tip = fee.maxPriorityFeePerGas ?? MIN_TIP_CAP_WEI;
    const cappedTip = tip < MIN_TIP_CAP_WEI ? MIN_TIP_CAP_WEI : tip;
    const base = fee.maxFeePerGas ?? cappedTip * 2n;
    const cappedFee = base < cappedTip ? cappedTip : base;
    // FeeData is frozen in ethers v6, so we have to construct a new one
    // rather than mutating fields.
    return new FeeDataCtor(fee.gasPrice, cappedFee, cappedTip);
  };
  return provider;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const slot = parseAgentId(cfg.agentId);
  const displayName = displayNameFor(cfg.agentId);
  const log = createLogger({ agent_id: cfg.agentId, role: slot.role, display_name: displayName });

  // STARTUP_DELAY_MS staggers boot across the packed-fleet machine so 60
  // simultaneous startups do not blow past the 0G RPC's 50 req/s burst cap.
  const startupDelayMs = Number.parseInt(process.env.STARTUP_DELAY_MS ?? "0", 10);
  if (startupDelayMs > 0) {
    log.info("startup delay", { delay_ms: startupDelayMs });
    await sleep(startupDelayMs);
  }

  log.info("agent boot", { rpc: cfg.rpcUrl, axl: cfg.axlUrl });

  const provider = makeProvider(cfg.rpcUrl);
  const baseWallet = deriveWallet(cfg.masterSeed, cfg.agentId);
  const wallet = new Wallet(baseWallet.privateKey, provider);
  const walletAddress = await wallet.getAddress();

  // Per-agent 0G Compute ledger needs 3 OG to bootstrap (protocol minimum
  // on `addLedger`). Demo wallets have ~0.3 OG, so the TEE path can't
  // come up. Wire in the Claude shim — same prompt, same outcome shape,
  // Anthropic backend instead of qwen-on-0G — so novel checks still get
  // verified by an LLM instead of falling through to permissive
  // trust-cache. When the deployer is funded with ~150 OG and we top up
  // each trader, drop the override and the SDK uses the real broker
  // automatically.
  const teeVerifier = slot.role === "trader" ? createClaudeTeeShim({
    semanticAutoMint: true,
    defaultChainId: Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10),
  }) : null;

  // Antibodies the operator has retired locally. The deployed Registry's
  // slash() is owner-only and we don't hold the owner key, so chain-side
  // retirement isn't available — the SDK's `denyKeccakIds` filter mutes
  // both Tier-1 cache hits and Tier-2 chain-lookup hits for these
  // entries. Add a new keccak when an auto-mint goes wrong; remove once
  // the entry is properly retired on chain.
  const KECCAK_DENYLIST: ReadonlyArray<`0x${string}`> = [
    "0xb9cc1b4c215b656bc11375d61d66508d06bb2c27476956f5ec9db8745c6ae425", // IMM-2026-0046: bad ADDRESS auto-mint targeting MOCK_USDC
  ];

  const immunity = new Immunity({
    wallet,
    network: "testnet",
    axlUrl: cfg.axlUrl,
    novelThreatPolicy: "verify",
    semanticAutoMint: true,
    ...(teeVerifier ? { teeVerifier } : {}),
    denyKeccakIds: KECCAK_DENYLIST,
    // Cache bootstrap pressure on the 0G testnet's 50 req/s public RPC
    // is the chief reason agents come up with empty caches in the
    // packed-fleet config. Sequentializing per-agent fetches (concurrency=1)
    // and accepting up to 5 per-call retries (default 3) trades a slow
    // bootstrap for a cache that actually populates. With the supervisord
    // 15s startup stagger, the fleet's bootstrap RPC pressure stretches
    // over ~15 minutes — well within the rate-limit budget.
    bootstrap: { concurrency: 1, fetchRetries: 5 },
  });
  await withBootRetry("immunity.start", log, () => immunity.start());

  // Belt-and-suspenders: also evict any denylisted entries from the
  // local cache after start(). The SDK's check-flow already filters
  // hits at match-time via `denyKeccakIds` (passed in the config above),
  // but pruning the cache too keeps memory tidy and avoids the entry
  // re-emerging if a future SDK change ever bypasses the match-time
  // filter on a code path I'm not anticipating.
  for (const keccak of KECCAK_DENYLIST) {
    if (immunity.dropFromCache(keccak)) {
      log.info("dropped denylisted antibody from cache", { keccak });
    }
  }

  await withBootRetry("ensureFundedWallet", log, () =>
    ensureFundedWallet(immunity, wallet, walletAddress, defaultFundingConfig(process.env), log),
  );

  // Skip the on-chain TEE ledger top-up when the Claude shim is wired
  // (the shim doesn't need a 0G Compute account). When the deployer is
  // funded and we drop the shim, this comes back automatically.
  if (!teeVerifier) {
    // Pre-fund the 0G Compute ledger so the lazy TEE init triggered by
    // the first novel-threat check finds an already-funded broker.
    // Idempotent and best-effort: a failure here just means TEE stays
    // cold for now, not that the agent boot fails.
    await ensureTeeReady(immunity, log, { minLedgerOg: 0.1, minProviderOg: 0.05 });
  }

  // Read our AXL spoke pubkey at boot so wolves can DM us by full pubkey
  // (the X-From-Peer-Id on /recv is a truncated prefix and cannot be used
  // as a destination — see AXL skill notes).
  const axl = new AxlClient(cfg.axlUrl);
  let axlPeerId: string | null = null;
  try {
    const topo = await axl.topology();
    axlPeerId = topo.our_public_key;
    log.info("axl peer-id resolved", { peer_id: axlPeerId.slice(0, 16) });
  } catch (err) {
    log.warn("axl topology failed; agent runs without DM intake this session", { err: String(err) });
  }

  const pool = connectPool(cfg.databaseUrl);
  // Boot-path heartbeat: wrap in retry so a single pg pool acquisition
  // timeout during the 60-agent boot herd does not crash the process and
  // make the herd worse. The interval-driven heartbeat below already
  // swallows errors, so this only protects the very first write.
  await withBootRetry("upsertHeartbeat", log, () => upsertHeartbeat(pool, {
    agentId: cfg.agentId,
    role: slot.role,
    address: walletAddress,
    displayName,
    axlPeerId,
  }));
  const heartbeatTimer = setInterval(() => {
    upsertHeartbeat(pool, {
      agentId: cfg.agentId,
      role: slot.role,
      address: walletAddress,
      displayName,
      axlPeerId,
    }).catch((err) => log.error("heartbeat failed", { err: String(err) }));
  }, HEARTBEAT_INTERVAL_MS);

  // Bind a per-agent activity recorder over the shared pool. Fire-and-forget:
  // any insert error is logged and swallowed so agent ticks never block on DB.
  const recordActivity = (rec: import("./context.js").ActivityRecord): void => {
    insertAgentActivity(pool, {
      agentId: cfg.agentId,
      role: slot.role,
      displayName,
      ...rec,
    }).catch((err) => log.warn("recordActivity failed; dropping row", { err: String(err).slice(0, 200) }));
  };

  const ctx: AmbientContext = { slot, displayName, walletAddress, immunity, pool, log, recordActivity };

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown", { signal });
    clearInterval(heartbeatTimer);
    try {
      await immunity.stop();
    } catch (err) {
      log.warn("immunity.stop failed", { err: String(err) });
    }
    await closePool();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT",  () => void shutdown("SIGINT"));

  log.info("agent ready", { wallet: walletAddress });

  // node-postgres pool clients silently die when the underlying TCP
  // connection drops (Fly Postgres maintenance, idle timeout, network
  // blip). Subsequent borrows succeed but every query fails with
  // "Connection terminated unexpectedly" forever. Detect that pattern
  // and exit non-zero so supervisord respawns this process — same fix
  // we applied to the indexer for PDO. Tracks consecutive matching
  // failures across tick + heartbeat so we don't bail on a one-off blip.
  let consecutiveConnLost = 0;
  const CONN_LOST_THRESHOLD = 5;
  const isConnLost = (e: unknown): boolean => {
    const m = String(e).toLowerCase();
    return m.includes("connection terminated")
      || m.includes("server has gone away")
      || m.includes("connection refused")
      || m.includes("broken pipe")
      || m.includes("lost connection");
  };
  const onTickResult = (err?: unknown): void => {
    if (err === undefined) {
      consecutiveConnLost = 0;
      return;
    }
    if (isConnLost(err)) {
      consecutiveConnLost++;
      if (consecutiveConnLost >= CONN_LOST_THRESHOLD) {
        log.error("pg connection lost repeatedly; exiting for supervisord respawn", {
          consecutive: consecutiveConnLost,
        });
        process.exit(3);
      }
    }
  };

  while (!stopping) {
    try {
      // Drain any AXL DMs first so wolf-pushed social_dm messages are
      // evaluated before this tick's ambient action. Bounded internally
      // (MAX_DRAIN_PER_TICK in inbox.ts) so a flood does not starve the
      // tick.
      await drainInbox(ctx, axl);

      const cmd = await dequeueCommand(pool, cfg.agentId);
      if (cmd !== null) {
        log.info("command picked up", { command_id: cmd.id, command_type: cmd.commandType });
        try {
          const result = await runCommand(cmd, ctx);
          await markCommandComplete(pool, cmd.id, result);
          log.info("command complete", { command_id: cmd.id, status: result.status });
        } catch (err) {
          await markCommandComplete(pool, cmd.id, {
            status: "failed",
            detail: { error: String(err) },
          });
          log.error("command failed", { command_id: cmd.id, err: String(err) });
        }
      } else {
        const fleet = await getFleetState(pool);
        if (!fleet.ambientPaused) {
          await runAmbient(slot.role, ctx);
        }
      }
      onTickResult();
    } catch (err) {
      log.error("tick failed", { err: String(err) });
      onTickResult(err);
    }
    await sleep(jitteredInterval(cfg.tickMinMs, cfg.tickMaxMs));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "fatal", err: String(err) }));
  process.exit(1);
});
