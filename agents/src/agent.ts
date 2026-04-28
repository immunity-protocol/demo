import { Immunity } from "@immunity-protocol/sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { runAmbient } from "./ambient/index.js";
import { runCommand } from "./commands/index.js";
import {
  closePool,
  connectPool,
  dequeueCommand,
  getFleetState,
  markCommandComplete,
  upsertHeartbeat,
} from "./db.js";
import { displayNameFor } from "./display_names.js";
import { defaultFundingConfig, ensureFundedWallet } from "./funding.js";
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const slot = parseAgentId(cfg.agentId);
  const displayName = displayNameFor(cfg.agentId);
  const log = createLogger({ agent_id: cfg.agentId, role: slot.role, display_name: displayName });

  log.info("agent boot", { rpc: cfg.rpcUrl, axl: cfg.axlUrl });

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const baseWallet = deriveWallet(cfg.masterSeed, cfg.agentId);
  const wallet = new Wallet(baseWallet.privateKey, provider);
  const walletAddress = await wallet.getAddress();

  const immunity = new Immunity({
    wallet,
    network: "testnet",
    axlUrl: cfg.axlUrl,
    novelThreatPolicy: "verify",
  });
  await immunity.start();

  await ensureFundedWallet(immunity, wallet, walletAddress, defaultFundingConfig(process.env), log);

  const pool = connectPool(cfg.databaseUrl);
  await upsertHeartbeat(pool, {
    agentId: cfg.agentId,
    role: slot.role,
    address: walletAddress,
    displayName,
  });
  const heartbeatTimer = setInterval(() => {
    upsertHeartbeat(pool, {
      agentId: cfg.agentId,
      role: slot.role,
      address: walletAddress,
      displayName,
    }).catch((err) => log.error("heartbeat failed", { err: String(err) }));
  }, HEARTBEAT_INTERVAL_MS);

  const ctx: AmbientContext = { slot, displayName, walletAddress, immunity, pool, log };

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

  while (!stopping) {
    try {
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
    } catch (err) {
      log.error("tick failed", { err: String(err) });
    }
    await sleep(jitteredInterval(cfg.tickMinMs, cfg.tickMaxMs));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "fatal", err: String(err) }));
  process.exit(1);
});
