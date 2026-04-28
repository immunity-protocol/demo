import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";

/**
 * Watcher's reaction to an external threat report (Pipedream tweet,
 * playground Card 2, scenario 03). Publishes an ADDRESS antibody on chain
 * so it propagates across the fleet within seconds.
 *
 * Payload shape:
 *   {
 *     "address":    "0x... (target to flag)",
 *     "severity":   0..100,
 *     "verdict":    "MALICIOUS" | "SUSPICIOUS" (default MALICIOUS),
 *     "reasoning":  "free text shown in explorer",
 *     "source":     "pipedream" | "playground" | "scenario" (informational),
 *     "source_url": "https://..." (optional, surfaced in explorer)
 *   }
 *
 * Result detail:
 *   { imm_id, imm_seq, keccak_id, tx_hash, target, severity, verdict }
 */
export async function runExternalThreatAlert(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  const p = cmd.payload as {
    address?: string;
    severity?: number | string;
    verdict?: string;
    reasoning?: string;
    source?: string;
    source_url?: string;
  };

  const address = (p.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { status: "failed", detail: { error: "address must be 0x-prefixed 20-byte hex" } };
  }
  const severity = clamp(Number(p.severity ?? 80), 0, 100);
  const verdict = p.verdict === "SUSPICIOUS" ? "SUSPICIOUS" : "MALICIOUS";
  const confidence = pickConfidence(verdict === "MALICIOUS" ? 86 : 71, verdict === "MALICIOUS" ? 96 : 84);
  const chainId = Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10);

  ctx.log.info("watcher publishing antibody", {
    target: address,
    severity,
    verdict,
    source: p.source ?? "unknown",
  });

  const reasonSummary =
    typeof p.reasoning === "string" && p.reasoning.trim() !== ""
      ? String(p.reasoning).slice(0, 280)
      : `External threat alert from ${p.source ?? "unknown source"} reporting ${address} as ${verdict.toLowerCase()}.`;

  const result = await ctx.immunity.publish({
    seed: { abType: "ADDRESS", chainId, target: address as `0x${string}` },
    verdict,
    confidence,
    severity,
    reasonSummary,
  });

  return {
    status: "completed",
    detail: {
      imm_id:     `IMM-${new Date().getUTCFullYear()}-${String(result.immSeq).padStart(4, "0")}`,
      imm_seq:    result.immSeq,
      keccak_id:  result.keccakId,
      tx_hash:    result.txHash,
      target:     address,
      severity,
      confidence,
      verdict,
      reasoning:  p.reasoning ?? null,
      source:     p.source ?? null,
      source_url: p.source_url ?? null,
    },
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pickConfidence(min: number, max: number): number {
  const candidates: number[] = [];
  for (let n = min; n <= max; n++) {
    if (n % 5 !== 0) candidates.push(n);
  }
  return candidates[Math.floor(Math.random() * candidates.length)] ?? min;
}
