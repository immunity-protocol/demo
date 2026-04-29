import type { CheckContext } from "@immunity-protocol/sdk";
import type { AmbientContext } from "../context.js";
import { pickRandomIncident } from "../data/incidents.js";
import {
  buildErc20Approve,
  buildErc20Transfer,
  buildSwap,
  lognormalUsdcAmount,
  pickRouter,
  randomAddress,
  type BuildEnv,
} from "../tx_builder.js";
import { pickKnownBad } from "../threat_targets.js";

/**
 * Treasury operator behaviour. Weighted random pick per tick:
 *   70% USDC swap on a known DEX router ($500-$50k, lognormal)
 *   20% USDC transfer to another address ($100-$10k)
 *    5% approve (often MAX_UINT256)
 *    5% no-op tick - looks more natural than constant fire
 *
 * ~5% of all txs draw their counterparty from the curated bad-target pool, so
 * the dashboard sees occasional organic blocks even without scenario commands.
 *
 * 10% of checks pull a context variant from the incident catalog (`data/
 * incidents.ts`). The catalog has 20 marker families x 7 phrasing variants;
 * variants in the same family share a canonical marker substring, so once
 * any one publishes an antibody the rest hit Tier-1 cache on subsequent
 * encounters. The 10% rate is a deliberate dial-up from the v0.4 2% so the
 * judge sees blocks happen visibly without the fleet feeling all-attack.
 */
const ORGANIC_BAD_RATE = 0.05;
const INCIDENT_RATE = 0.10;

export async function runTraderAmbient(ctx: AmbientContext): Promise<void> {
  const env = txEnv();
  const roll = Math.random();

  let payload: { description: string; tx: ReturnType<typeof buildErc20Transfer> | ReturnType<typeof buildSwap> | ReturnType<typeof buildErc20Approve> };

  if (roll < 0.70) {
    const amount = lognormalUsdcAmount(500, 50_000);
    payload = { description: `swap ${formatUsdc(amount)} USDC via DEX router`, tx: buildSwap(env, amount) };
  } else if (roll < 0.90) {
    const amount = lognormalUsdcAmount(100, 10_000);
    const to = pickCounterparty();
    payload = { description: `transfer ${formatUsdc(amount)} USDC → ${shortAddr(to)}`, tx: buildErc20Transfer(env, to, amount) };
  } else if (roll < 0.95) {
    const spender = Math.random() < ORGANIC_BAD_RATE ? pickKnownBad().address : pickRouter();
    payload = { description: `approve(MAX) → ${shortAddr(spender)}`, tx: buildErc20Approve(env, spender) };
  } else {
    ctx.log.debug("trader idle tick");
    return;
  }

  const incident = Math.random() < INCIDENT_RATE ? pickRandomIncident() : null;
  const context: CheckContext = incident
    ? incident.variant.context
    : { conversation: [{ role: "user", content: "routine treasury operation" }] };

  try {
    const result = await ctx.immunity.check(payload.tx, context);
    const incidentTag = incident
      ? { incidentFamily: incident.family.id, incidentVariant: incident.variant.id, incidentSurface: incident.variant.surface }
      : {};
    if (result.allowed) {
      ctx.log.info("ambient allow", { action: payload.description, source: result.source, novel: result.novel, ...incidentTag });
    } else {
      ctx.log.info("ambient block", {
        action: payload.description,
        reason: result.reason,
        antibody: result.antibodies[0]?.immId,
        source: result.source,
        ...incidentTag,
      });
    }
  } catch (err) {
    ctx.log.warn("ambient check error", { action: payload.description, err: String(err) });
  }
}

function pickCounterparty(): string {
  if (Math.random() < ORGANIC_BAD_RATE) {
    return pickKnownBad().address;
  }
  return randomAddress();
}

function txEnv(): BuildEnv {
  return {
    chainId: Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10),
    usdcAddress: requireEnv("MOCK_USDC_ADDRESS"),
  };
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") {
    throw new Error(`missing env: ${key}`);
  }
  return v;
}

function formatUsdc(wei: bigint): string {
  const s = wei.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6).slice(0, 2)}`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
