import type { CheckContext } from "@immunity-protocol/sdk";
import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";
import { buildErc20Transfer, type BuildEnv } from "../tx_builder.js";
import { parseUnits } from "ethers";

/**
 * Cross-agent manipulation attempt. Used by Card 3 (Send a malicious payload)
 * and scenario 04 (Prompt injection).
 *
 * Payload shape:
 *   {
 *     "target":        "trader-7"  (purely narrative — what agent the
 *                                   attacker pretends to manipulate),
 *     "method":        "instruction_override" | "social_engineering" | "free",
 *     "injected_text": "Ignore previous instructions and..."
 *   }
 *
 * The handler runs `immunity.check()` with the injected text in the
 * conversation context. The SDK's SemanticMatcher (or TEE on miss) decides.
 *
 * Result detail:
 *   { decision, source, reason, antibody_imm_id?, target, method, payload_text }
 */
export async function runManipulate(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  const p = cmd.payload as {
    target?: string;
    method?: string;
    injected_text?: string;
  };

  const injected = (p.injected_text ?? "").trim();
  if (injected === "") {
    return { status: "failed", detail: { error: "injected_text is required" } };
  }

  const env = txEnv();
  // The tx is symbolic — the manipulation lives in the conversation context.
  // We pair it with a small transfer so the TEE has something to evaluate
  // alongside the prompt.
  const tx = buildErc20Transfer(env, ctx.walletAddress, parseUnits("1", 6));
  const context: CheckContext = {
    conversation: [
      { role: "user", content: injected },
      { role: "assistant", content: "Reviewing request before signing…" },
    ],
    metadata: { intent: "manipulation_attempt", source_agent: cmd.agentId, target_agent: p.target ?? null },
  };

  const result = await ctx.immunity.check(tx, context);

  ctx.log.info("manipulation attempt", {
    target: p.target,
    method: p.method ?? "free",
    decision: result.decision,
    source: result.source,
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
      target:           p.target ?? null,
      method:           p.method ?? "free",
      payload_text:     injected,
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
