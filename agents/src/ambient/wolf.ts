import type { AmbientContext } from "../context.js";
import { AxlClient, encodeEnvelope } from "../axl/client.js";
import { INCIDENT_FAMILIES, type IncidentFamily, type IncidentVariant } from "../data/incidents.js";
import { insertSocialFeedPost, listOnlineTargetTraders, type OnlinePeer } from "../db.js";
import { runTraderAmbient } from "./trader.js";

/**
 * Wolf ambient.
 *
 * Wolves spend most of their time blending in as quiet traders so the
 * dashboard isn't constantly red. The remaining 20% of ticks splits across
 * two A2A vectors:
 *
 *   - AXL DM (10%)        : direct social-engineering message to a random
 *                           online trader. Picks an incident with a
 *                           conversation- or tool-shaped variant; the
 *                           target's inbox drain (axl/inbox.ts) runs
 *                           immunity.check() with the payload.
 *   - social_feed (10%)   : indirect injection — wolves post a
 *                           sources-shaped variant to demo.social_feed.
 *                           Traders periodically scan unread rows from
 *                           that table; the SEMANTIC marker substring
 *                           inside the content fires their check.
 *
 * Self-attacks (the wolf running immunity.check on its own malicious tx)
 * remain available via the operator-driven `attack` command — see
 * commands/attack.ts. They're not part of ambient anymore: A2A is the
 * realistic threat model the demo is designed to showcase.
 */

const TRADER_BLEND_RATE = 0.80;
const AXL_DM_RATE = 0.10;
// remaining 10% → social_feed post

// Cached AXL client. The wolf's own AXL spoke URL comes from env (set by
// the agent boot in agent.ts; we don't have AmbientContext.axl yet, so we
// build a thin client per file to avoid plumbing the URL through every
// call site).
let axl: AxlClient | null = null;
function getAxl(): AxlClient {
  if (axl) return axl;
  const url = process.env.AXL_URL;
  if (!url) throw new Error("AXL_URL not set");
  axl = new AxlClient(url);
  return axl;
}

export async function runWolfAmbient(ctx: AmbientContext): Promise<void> {
  const roll = Math.random();
  if (roll < TRADER_BLEND_RATE) {
    return runTraderAmbient(ctx);
  }
  if (roll < TRADER_BLEND_RATE + AXL_DM_RATE) {
    return pushAxlDm(ctx);
  }
  return postToSocialFeed(ctx);
}

async function pushAxlDm(ctx: AmbientContext): Promise<void> {
  const candidates = INCIDENT_FAMILIES.flatMap((f) =>
    f.variants
      .filter((v) => v.vector === "conversation" || v.vector === "tool_trace")
      .map((v) => ({ family: f, variant: v })),
  );
  if (candidates.length === 0) {
    ctx.log.debug("wolf: no DM-shaped variants in catalog");
    return;
  }
  const { family, variant } = candidates[Math.floor(Math.random() * candidates.length)]!;

  let targets: OnlinePeer[];
  try {
    targets = await listOnlineTargetTraders(ctx.pool, ctx.slot.agentId);
  } catch (err) {
    ctx.log.warn("wolf: heartbeat lookup failed", { err: String(err) });
    return;
  }
  if (targets.length === 0) {
    ctx.log.debug("wolf: no online traders with axl_peer_id; skipping DM");
    return;
  }
  const target = targets[Math.floor(Math.random() * targets.length)]!;

  const body = encodeEnvelope({
    app: "immunity-demo",
    v: 1,
    kind: "social_dm",
    payload: {
      family_id: family.id,
      variant_id: variant.id,
      surface: variant.surface,
      context: variant.context,
    },
  });

  try {
    const sent = await getAxl().send(target.axlPeerId, body);
    ctx.log.info("wolf social_dm sent", {
      target_agent: target.agentId,
      target_display: target.displayName,
      family: family.id,
      variant: variant.id,
      surface: variant.surface,
      bytes: sent,
    });
  } catch (err) {
    // Peer offline or transient AXL error — log and move on; the demo
    // shouldn't crash a wolf because one trader was briefly unreachable.
    ctx.log.warn("wolf: AXL send failed", {
      target_agent: target.agentId,
      err: String(err),
    });
  }
}

async function postToSocialFeed(ctx: AmbientContext): Promise<void> {
  const candidates = INCIDENT_FAMILIES.flatMap((f) =>
    f.variants
      .filter((v) => v.vector === "sources")
      .map((v) => ({ family: f, variant: v })),
  );
  if (candidates.length === 0) {
    ctx.log.debug("wolf: no source-shaped variants in catalog");
    return;
  }
  const { family, variant } = candidates[Math.floor(Math.random() * candidates.length)]!;

  // Collapse the variant's context.sources[] into a single content blob.
  // The marker is in there by catalog invariant; the trader's social-feed
  // scanner will pass it through immunity.check() as ctx.sources.extractedText
  // and the SemanticMatcher will substring-match.
  const sources = variant.context.sources ?? [];
  if (sources.length === 0) {
    ctx.log.debug("wolf: variant has no sources entries", { variant: variant.id });
    return;
  }
  const first = sources[0]!;
  const url = first.url;
  const content = sources
    .map((s) => s.extractedText ?? "")
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
  if (!content) {
    ctx.log.debug("wolf: variant sources had no extractedText", { variant: variant.id });
    return;
  }

  // Best-effort source-kind tagging for the dashboard.
  const sourceKind = inferSourceKind(url);

  try {
    const id = await insertSocialFeedPost(ctx.pool, {
      source: sourceKind,
      url,
      content,
      postedByAgentId: ctx.slot.agentId,
    });
    ctx.log.info("wolf social_feed post inserted", {
      feed_id: id,
      source: sourceKind,
      url,
      family: family.id,
      variant: variant.id,
      surface: variant.surface,
    });
  } catch (err) {
    ctx.log.warn("wolf: social_feed insert failed", { err: String(err) });
  }
}

function inferSourceKind(url: string): string {
  if (url.startsWith("https://twitter.")) return "twitter";
  if (url.startsWith("https://reddit.")) return "reddit";
  if (url.startsWith("https://github.com")) return "github";
  if (url.startsWith("https://discord")) return "discord";
  if (url.startsWith("https://t-archive.")) return "telegram";
  if (url.startsWith("https://stackoverflow.")) return "stackoverflow";
  if (url.startsWith("https://slowmist.")) return "blog";
  return "web";
}

// Re-exports for the operator-driven attack command (axl_dm / social_feed_post
// modes) — they reuse the same primitives.
export const __wolfTesting = { pushAxlDm, postToSocialFeed };

// Suppress unused-import warning when there are zero variant types to filter.
type _ImportedJustForType = IncidentVariant | IncidentFamily;
