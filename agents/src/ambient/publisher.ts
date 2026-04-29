import { createRequire } from "node:module";
import type { AmbientContext } from "../context.js";
import {
  classifyFeedItem,
  isClaudeConfigured,
  type ClassificationResult,
  type FeedItem,
} from "../llm/claude.js";

// Avoid the ESM `with { type: "json" }` import attribute (not enabled by
// our `module: "ES2022"` setting). createRequire works in Node 20+ ESM
// regardless of module mode.
const requireJson = createRequire(import.meta.url);
const feedsJson = requireJson("../data/feeds.json") as FeedItem[];

/**
 * LLM-driven publisher.
 *
 * Publishers no longer trade. Each publisher's only job is to scan a curated
 * mock feed of "external content" (twitter posts, slowmist blog snippets,
 * github issues, reddit threads — see `agents/src/data/feeds.json`) and
 * mint an antibody when Claude classifies an item as a threat.
 *
 * Tick model:
 *
 *  - 5% of ticks: pick a random unseen feed item, send to Claude Haiku 4.5,
 *    publish an ADDRESS or SEMANTIC antibody on positive classification.
 *  - 95% of ticks: idle. The fleet ticks every 15-90s, so 5 publishers ×
 *    ~5% scan rate ≈ 15 LLM calls / hour total — within the cost target
 *    documented in the SDK auto-mint plan.
 *
 * Without `ANTHROPIC_API_KEY` the publisher logs once and idles for the
 * session. The agent process stays up so the rest of the fleet can run.
 *
 * Items the publisher has already classified in this process are tracked in
 * an in-memory set so repeat picks don't burn API calls. Duplicate publishes
 * across publishers are caught by the Registry's matcherIndex uniqueness
 * (returns DuplicateAntibodyError, treated as benign).
 */

const SCAN_PROBABILITY = 0.05;

const seenThisProcess = new Set<string>();
const FEED: FeedItem[] = feedsJson;

export async function runPublisherAmbient(ctx: AmbientContext): Promise<void> {
  if (!isClaudeConfigured()) {
    ctx.log.debug("publisher idle: ANTHROPIC_API_KEY not set");
    return;
  }
  if (Math.random() >= SCAN_PROBABILITY) {
    ctx.log.debug("publisher idle tick");
    return;
  }

  const item = pickUnseen(FEED);
  if (!item) {
    ctx.log.debug("publisher: feed exhausted in this process; resetting set");
    seenThisProcess.clear();
    return;
  }

  ctx.log.info("publisher scanning", { item_id: item.id, source: item.source });
  let result: ClassificationResult | null;
  try {
    result = await classifyFeedItem(item);
  } catch (err) {
    ctx.log.warn("publisher classify error", { item_id: item.id, err: String(err) });
    return;
  }
  if (!result) {
    ctx.log.debug("publisher: classifier returned null", { item_id: item.id });
    return;
  }
  if (!result.is_threat) {
    ctx.log.info("publisher: scanned, benign", { item_id: item.id });
    return;
  }

  await publishFromClassification(ctx, item, result);
}

async function publishFromClassification(
  ctx: AmbientContext,
  item: FeedItem,
  result: ClassificationResult,
): Promise<void> {
  const reasonSummary = result.reasoning;
  const evidence = new TextEncoder().encode(
    JSON.stringify({
      schema: "immunity/threat-evidence/v1",
      classifier: "claude-haiku-4-5",
      feed_item_id: item.id,
      source: item.source,
      url: item.url,
      content_excerpt: item.content.slice(0, 800),
      classification: result,
      published_at: new Date().toISOString(),
    }),
  );

  try {
    if (result.ab_type === "ADDRESS") {
      const target = result.target;
      if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
        ctx.log.warn("publisher: address result has invalid target", { item_id: item.id, target });
        return;
      }
      const pub = await ctx.immunity.publish({
        seed: {
          abType: "ADDRESS",
          chainId: Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10),
          target: target as `0x${string}`,
        },
        verdict: result.verdict,
        confidence: result.confidence,
        severity: result.severity,
        reasonSummary,
        evidence,
      });
      ctx.log.info("publisher minted ADDRESS antibody", {
        imm_seq: pub.immSeq,
        keccak: pub.keccakId,
        tx: pub.txHash,
        target,
        item_id: item.id,
      });
    } else if (result.ab_type === "SEMANTIC") {
      const marker = result.marker;
      const flavor = result.flavor;
      if (!marker || !flavor) {
        ctx.log.warn("publisher: semantic result missing marker or flavor", { item_id: item.id });
        return;
      }
      // Verbatim-presence guard: the SDK does this server-side too on TEE
      // auto-mint, but for explicit publisher path we re-verify here so a
      // hallucinated marker never lands on chain.
      if (!item.content.toLowerCase().includes(marker.toLowerCase())) {
        ctx.log.warn("publisher: marker not present in content; skipping", {
          item_id: item.id,
          marker: marker.slice(0, 60),
        });
        return;
      }
      const pub = await ctx.immunity.publish({
        seed: {
          abType: "SEMANTIC",
          flavor,
          pattern: { kind: "marker", value: marker.toLowerCase() },
        },
        verdict: result.verdict,
        confidence: result.confidence,
        severity: result.severity,
        reasonSummary,
        evidence,
      });
      ctx.log.info("publisher minted SEMANTIC antibody", {
        imm_seq: pub.immSeq,
        keccak: pub.keccakId,
        tx: pub.txHash,
        flavor,
        marker: marker.slice(0, 60),
        item_id: item.id,
      });
    }
  } catch (err) {
    const msg = String(err);
    // Duplicate is the expected outcome when another publisher (or a prior
    // run) already minted on the same matcher. Drop to debug rather than warn
    // so the log stays quiet on the happy path.
    if (msg.includes("DuplicateAntibody") || msg.toLowerCase().includes("alreadyexists")) {
      ctx.log.debug("publisher: antibody already on chain (duplicate)", { item_id: item.id });
      return;
    }
    ctx.log.warn("publisher publish failed", { item_id: item.id, err: msg });
  }
}

function pickUnseen(feed: FeedItem[]): FeedItem | null {
  const candidates = feed.filter((f) => !seenThisProcess.has(f.id));
  if (candidates.length === 0) return null;
  const item = candidates[Math.floor(Math.random() * candidates.length)]!;
  seenThisProcess.add(item.id);
  return item;
}
