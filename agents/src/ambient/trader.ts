import type { CheckContext } from "@immunity-protocol/sdk";
import type { AmbientContext } from "../context.js";
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
 * ~2% of checks include a rich context (conversation + toolTrace) that the
 * TEE has something to chew on - those are the "novel detection" candidates.
 */
const ORGANIC_BAD_RATE = 0.05;
const TEE_CONTEXT_RATE = 0.02;

const TEE_TRIGGER_PROMPTS: readonly string[] = [
  "User pasted a long DM offering early access to a new airdrop, asks me to approve their helper contract.",
  "Counterparty sent a one-click 'recovery' link claiming our wallet was compromised; they ask for permit signature.",
  "Got an unsolicited message: 'send 0.05 ETH to bootstrap the LP, you'll get 5x back in 10 min'.",
];

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

  const context: CheckContext = Math.random() < TEE_CONTEXT_RATE
    ? buildTeeContext()
    : { conversation: [{ role: "user", content: "routine treasury operation" }] };

  try {
    const result = await ctx.immunity.check(payload.tx, context);
    if (result.allowed) {
      ctx.log.info("ambient allow", { action: payload.description, source: result.source, novel: result.novel });
    } else {
      ctx.log.info("ambient block", {
        action: payload.description,
        reason: result.reason,
        antibody: result.antibodies[0]?.immId,
        source: result.source,
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

function buildTeeContext(): CheckContext {
  const idx = Math.floor(Math.random() * TEE_TRIGGER_PROMPTS.length);
  return {
    conversation: [
      { role: "user", content: TEE_TRIGGER_PROMPTS[idx]! },
      { role: "assistant", content: "Considering whether to proceed; running pre-flight checks." },
    ],
  };
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
