import type { CheckContext } from "@immunity-protocol/sdk";
import type { AmbientContext } from "../context.js";
import { pickRandomIncident } from "../data/incidents.js";
import { pickUnreadSocialPost } from "../db.js";
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
import { displayNameFor } from "../display_names.js";

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

/**
 * 20% of trader ticks: instead of running a tx, the trader reads one
 * unread row from demo.social_feed (mock external content posted by
 * wolves or seeded benign baseline) and runs immunity.check() with the
 * content carried as ctx.sources.extractedText. The SemanticMatcher
 * substring-matches against published markers; matches block the
 * "ingestion" the way they would if the agent had scraped the page.
 *
 * If there's nothing unread, the tick falls through to normal tx ambient.
 */
const SOCIAL_FEED_SCAN_RATE = 0.20;

export async function runTraderAmbient(ctx: AmbientContext): Promise<void> {
  if (Math.random() < SOCIAL_FEED_SCAN_RATE) {
    const ran = await maybeScanSocialFeed(ctx);
    if (ran) return;
    // Nothing unread; fall through to normal tx ambient so the tick
    // doesn't degrade into a no-op when the social feed is quiet.
  }

  const env = txEnv();
  const roll = Math.random();

  let payload: { description: string; tx: ReturnType<typeof buildErc20Transfer> | ReturnType<typeof buildSwap> | ReturnType<typeof buildErc20Approve> };

  let actionType: "swap" | "transfer" | "approve";
  let target: string | null = null;
  if (roll < 0.70) {
    const amount = lognormalUsdcAmount(500, 50_000);
    payload = { description: `swap ${formatUsdc(amount)} USDC via DEX router`, tx: buildSwap(env, amount) };
    actionType = "swap";
  } else if (roll < 0.90) {
    const amount = lognormalUsdcAmount(100, 10_000);
    const to = pickCounterparty();
    target = to;
    payload = { description: `transfer ${formatUsdc(amount)} USDC → ${shortAddr(to)}`, tx: buildErc20Transfer(env, to, amount) };
    actionType = "transfer";
  } else if (roll < 0.95) {
    const spender = Math.random() < ORGANIC_BAD_RATE ? pickKnownBad().address : pickRouter();
    target = spender;
    payload = { description: `approve(MAX) → ${shortAddr(spender)}`, tx: buildErc20Approve(env, spender) };
    actionType = "approve";
  } else {
    ctx.log.debug("trader idle tick");
    return;
  }

  const incident = Math.random() < INCIDENT_RATE ? pickRandomIncident() : null;
  const baseContext: CheckContext = incident
    ? incident.variant.context
    : { conversation: [{ role: "user", content: "routine treasury operation" }] };
  // When the tx routes through an ERC-20 contract, the recipient/spender
  // is buried in the calldata and `tx.to` is the token contract — so the
  // SDK's AddressMatcher (which probes `tx.to` and `context.counterparty.id`)
  // would never see the actual counterparty. Surface it explicitly so an
  // ADDRESS antibody for the recipient fires Tier-1 cache lookups.
  const context: CheckContext = target
    ? { ...baseContext, counterparty: { ...(baseContext.counterparty ?? {}), id: target } }
    : baseContext;

  try {
    const result = await ctx.immunity.check(payload.tx, context);
    const incidentTag = incident
      ? { incidentFamily: incident.family.id, incidentVariant: incident.variant.id, incidentSurface: incident.variant.surface }
      : {};
    if (result.allowed) {
      ctx.log.info("ambient allow", { action: payload.description, source: result.source, novel: result.novel, ...incidentTag });
      ctx.recordActivity({
        actionType,
        actionSummary: payload.description,
        status: result.novel ? "novel" : "allow",
        target,
        family: incident?.family.id ?? null,
      });
    } else {
      ctx.log.info("ambient block", {
        action: payload.description,
        reason: result.reason,
        antibody: result.antibodies[0]?.immId,
        source: result.source,
        ...incidentTag,
      });
      ctx.recordActivity({
        actionType,
        actionSummary: `${payload.description} — blocked: ${result.reason}`,
        status: "block",
        antibodyImmId: result.antibodies[0]?.immId ?? null,
        target,
        family: incident?.family.id ?? null,
      });
    }
  } catch (err) {
    ctx.log.warn("ambient check error", { action: payload.description, err: String(err) });
    ctx.recordActivity({
      actionType,
      actionSummary: `${payload.description} — error: ${String(err).slice(0, 120)}`,
      status: "error",
      target,
      family: incident?.family.id ?? null,
    });
  }
}

function pickCounterparty(): string {
  if (Math.random() < ORGANIC_BAD_RATE) {
    return pickKnownBad().address;
  }
  return randomAddress();
}

async function maybeScanSocialFeed(ctx: AmbientContext): Promise<boolean> {
  let row: Awaited<ReturnType<typeof pickUnreadSocialPost>>;
  try {
    row = await pickUnreadSocialPost(ctx.pool, ctx.slot.agentId);
  } catch (err) {
    ctx.log.warn("social_feed scan: db error", { err: String(err) });
    return false;
  }
  if (!row) return false;

  const context: CheckContext = {
    sources: [{ url: row.url, extractedText: row.content }],
  };
  // Synthetic proposed-tx represents what the agent was *about* to do
  // when it scraped this post: a treasury-sized USDC transfer. Without
  // it, extractFacts() returns all-zero and the on-chain Matched event
  // emitted by a successful block carries no token+amount; the indexer
  // can't price the threat, so the auto-minted antibody ends up with
  // value_protected_usd = 0. Same lognormal distribution as ambient
  // swaps so the value blends in with organic tx flow.
  const env = txEnv();
  const notional = lognormalUsdcAmount(500, 50_000);
  const syntheticTx = buildErc20Transfer(env, randomAddress(), notional);
  try {
    const result = await ctx.immunity.check(syntheticTx, context);
    // Resolve the wolf's display name when the post was authored by another
    // agent in the fleet. Seeded baseline rows (postedByAgentId === null)
    // get a "(seeded)" label so the feed event is still self-explanatory.
    // Putting the author into the activity summary makes the indirect-
    // injection story land on the dashboard at a glance: "trader-X read a
    // post by wolf-Y → SDK matched the embedded marker → block".
    const author = row.postedByAgentId
      ? `${displayNameFor(row.postedByAgentId)} (${row.postedByAgentId})`
      : "(seeded baseline)";
    const tag = {
      feed_id: row.id,
      source: row.source,
      posted_by: row.postedByAgentId ?? "(seeded)",
    };
    const summary = `scraped ${row.source} post by ${author} → ${row.url.slice(0, 60)}`;
    if (result.allowed) {
      ctx.log.info("social_feed scan: allowed", { ...tag, source: result.source });
      ctx.recordActivity({
        actionType: "feed_scan",
        actionSummary: summary,
        status: result.novel ? "novel" : "allow",
        target: row.postedByAgentId,
      });
    } else {
      ctx.log.info("social_feed scan: blocked", {
        ...tag,
        reason: result.reason,
        antibody: result.antibodies[0]?.immId,
        source: result.source,
      });
      ctx.recordActivity({
        actionType: "feed_scan",
        actionSummary: `${summary} — BLOCKED: ${result.reason}`,
        status: "block",
        antibodyImmId: result.antibodies[0]?.immId ?? null,
        target: row.postedByAgentId,
      });
    }
  } catch (err) {
    ctx.log.warn("social_feed scan: check failed", { err: String(err) });
    ctx.recordActivity({
      actionType: "feed_scan",
      actionSummary: `feed_scan error: ${String(err).slice(0, 120)}`,
      status: "error",
    });
  }
  return true;
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
