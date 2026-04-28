import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";
import { buildErc20Transfer, type BuildEnv } from "../tx_builder.js";
import { parseUnits } from "ethers";

/**
 * Generic "run a check and tell me what happened" command. Powers Cards 1
 * (Test an address) and 3 (Send a malicious payload).
 *
 * Payload shape (one of `address` or `payload_text` should be present;
 * both is fine):
 *   {
 *     "address":      "0x..." (target a specific recipient),
 *     "amount_usd":   number (default 100),
 *     "payload_text": "free text shown in conversation context",
 *     "metadata":     { ... } (forwarded into CheckContext.metadata)
 *   }
 *
 * The handler synthesises a tiny USDC transfer to the address (or to itself
 * if no address provided), then calls `immunity.check()`. The interesting
 * detection happens in either the AddressMatcher (cache hit on `address`)
 * or the SemanticMatcher / TEE (driven by `payload_text`).
 *
 * Result detail:
 *   { decision, source, reason, novel, antibody_imm_id?, antibody_imm_seq?,
 *     check_id?, target, value_usd }
 */
export async function runCheckOnly(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  const p = cmd.payload as {
    address?: string;
    amount_usd?: number | string;
    payload_text?: string;
    metadata?: Record<string, unknown>;
  };

  const target = (p.address && /^0x[0-9a-fA-F]{40}$/.test(p.address))
    ? p.address.toLowerCase()
    : ctx.walletAddress;
  const amountUsd = Number(p.amount_usd ?? 100);
  const amount = parseUnits(String(Math.max(1, Math.round(amountUsd))), 6);
  const env = txEnv();

  const tx: ProposedTx = buildErc20Transfer(env, target, amount);
  const text = (p.payload_text ?? "").trim();
  const context: CheckContext = {
    conversation: text === ""
      ? [{ role: "user", content: `playground card check against ${target}` }]
      : [{ role: "user", content: text }],
    ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
  };

  const result = await ctx.immunity.check(tx, context);

  ctx.log.info("check_only run", {
    target,
    decision: result.decision,
    source: result.source,
    novel: result.novel,
  });

  return {
    status: "completed",
    detail: {
      decision: result.decision,
      allowed: result.allowed,
      source: result.source,
      reason: result.reason,
      novel: result.novel,
      antibody_imm_id:  result.antibodies[0]?.immId  ?? null,
      antibody_imm_seq: result.antibodies[0]?.immSeq ?? null,
      check_id:         result.checkId,
      target,
      value_usd:        amountUsd,
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
