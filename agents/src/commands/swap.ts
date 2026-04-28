import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";
import { buildSwap, type BuildEnv } from "../tx_builder.js";
import { parseUnits } from "ethers";

/**
 * Operator-driven swap. Useful for testing the dashboard with a known
 * amount, or for cards that want to demonstrate "this swap was allowed".
 *
 * Payload shape:
 *   {
 *     "amount_usd": number (default 1000),
 *     "context":    "free text shown in conversation" (optional)
 *   }
 *
 * Result detail:
 *   { decision, source, value_usd, check_id }
 */
export async function runSwap(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  const p = cmd.payload as { amount_usd?: number | string; context?: string };
  const amountUsd = Number(p.amount_usd ?? 1_000);
  const amount = parseUnits(String(Math.max(1, Math.round(amountUsd))), 6);
  const env = txEnv();

  const result = await ctx.immunity.check(buildSwap(env, amount), {
    conversation: [{ role: "user", content: p.context ?? "treasury swap requested by operator" }],
  });

  ctx.log.info("operator swap run", { usdc: amountUsd, decision: result.decision, source: result.source });

  return {
    status: "completed",
    detail: {
      decision: result.decision,
      allowed: result.allowed,
      source: result.source,
      reason: result.reason,
      value_usd: amountUsd,
      check_id: result.checkId,
    },
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
