import type { AmbientContext } from "../context.js";
import { runTraderAmbient } from "./trader.js";

/**
 * Heuristic publisher. Most ticks they look like a trader. Sometimes they
 * notice a pattern in the activity feed and mint a new antibody.
 *
 *   70% trader-style activity (organic blocks, occasional novel-context check)
 *   30% scan recent check_events; if a simple heuristic fires, publish
 *
 * The v1 heuristic is intentionally narrow: query check_event for any address
 * that was the target of >=3 approvals in the last 5 minutes from distinct
 * agents. If found, publish an ADDRESS antibody flagging that spender. If
 * not, no-op (the publisher saw nothing worth publishing).
 *
 * The query returns nothing 99% of the time on a healthy fleet — that's by
 * design. The publishers that do mint produce the "organic publication"
 * narrative beat for the dashboard.
 */
const PUBLISH_RATE = 0.30;
const HEURISTIC_WINDOW_MIN = 5;
const HEURISTIC_THRESHOLD  = 3;

interface SuspectRow {
  spender: string;
  approvals: number;
  distinct_agents: number;
}

export async function runPublisherAmbient(ctx: AmbientContext): Promise<void> {
  if (Math.random() >= PUBLISH_RATE) {
    return runTraderAmbient(ctx);
  }
  const suspects = await findSuspects(ctx);
  if (suspects.length === 0) {
    ctx.log.debug("publisher scan: no signals", { window_min: HEURISTIC_WINDOW_MIN });
    return;
  }

  const suspect = suspects[0]!;
  const reasoning = `Heuristic: ${suspect.approvals} approvals across ${suspect.distinct_agents} distinct agents in ${HEURISTIC_WINDOW_MIN}min window pointing at ${suspect.spender}`;
  try {
    const result = await ctx.immunity.publish({
      seed: {
        abType: "ADDRESS",
        chainId: Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10),
        target: suspect.spender as `0x${string}`,
      },
      verdict: "SUSPICIOUS",
      confidence: pickConfidence(73, 86),
      severity: pickConfidence(60, 82),
    });
    ctx.log.info("publisher minted antibody", {
      imm_seq: result.immSeq,
      keccak: result.keccakId,
      tx: result.txHash,
      target: suspect.spender,
      reason: reasoning,
    });
  } catch (err) {
    ctx.log.warn("publisher publish failed", { err: String(err), target: suspect.spender });
  }
}

async function findSuspects(ctx: AmbientContext): Promise<SuspectRow[]> {
  // Heuristic stub: real implementation would JOIN to a spender column we'd
  // need to add to event.check_event. For v1 we look at recent block_events
  // pointing at the same entry — these surface "lots of agents bumping into
  // the same threat" and any not-yet-mirrored variants are worth re-flagging.
  const since = new Date(Date.now() - HEURISTIC_WINDOW_MIN * 60_000).toISOString();
  const res = await ctx.pool.query<{ spender: string; approvals: number; distinct_agents: number }>(
    `SELECT
       encode(token_address, 'hex') AS spender,
       COUNT(*)::int                AS approvals,
       COUNT(DISTINCT agent_id)::int AS distinct_agents
     FROM event.check_event
     WHERE occurred_at >= $1::timestamptz
       AND token_address IS NOT NULL
     GROUP BY token_address
     HAVING COUNT(*) >= $2 AND COUNT(DISTINCT agent_id) >= 2
     ORDER BY approvals DESC
     LIMIT 1`,
    [since, HEURISTIC_THRESHOLD],
  );
  return res.rows.map((r) => ({
    spender: `0x${r.spender}`,
    approvals: r.approvals,
    distinct_agents: r.distinct_agents,
  }));
}

function pickConfidence(min: number, max: number): number {
  // Avoid round numbers — confidence values like 90/85/80 read as suspiciously
  // human-rounded. Pick from the gaps instead.
  const candidates: number[] = [];
  for (let n = min; n <= max; n++) {
    if (n % 5 !== 0) candidates.push(n);
  }
  return candidates[Math.floor(Math.random() * candidates.length)] ?? min;
}
