import type { AmbientContext } from "../context.js";
import { postSocialFeed, sendAxlDm } from "../a2a/attacks.js";
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

export async function runWolfAmbient(ctx: AmbientContext): Promise<void> {
  const roll = Math.random();
  if (roll < TRADER_BLEND_RATE) {
    return runTraderAmbient(ctx);
  }
  if (roll < TRADER_BLEND_RATE + AXL_DM_RATE) {
    const result = await sendAxlDm(ctx, {});
    if (result.status === "sent") {
      ctx.log.info("wolf social_dm sent", {
        target_agent: result.target?.agentId,
        target_display: result.target?.displayName,
        family: result.family?.id,
        variant: result.variant?.id,
        surface: result.variant?.surface,
      });
      ctx.recordActivity({
        actionType: "social_dm_out",
        actionSummary: `social-engineering DM → ${result.target?.displayName ?? result.target?.agentId} (family=${result.family?.id ?? "?"}, surface=${result.variant?.surface ?? "?"})`,
        status: "info",
        target: result.target?.agentId ?? null,
        family: result.family?.id ?? null,
      });
    } else if (result.status === "no-target") {
      ctx.log.debug("wolf: no online traders for DM");
    } else if (result.status === "send-failed") {
      ctx.log.warn("wolf: AXL send failed", { err: result.error });
      ctx.recordActivity({
        actionType: "social_dm_out",
        actionSummary: `DM failed: ${(result.error ?? "").slice(0, 120)}`,
        status: "error",
        target: result.target?.agentId ?? null,
        family: result.family?.id ?? null,
      });
    } else {
      ctx.log.debug("wolf: no DM-shaped incident available");
    }
    return;
  }
  const result = await postSocialFeed(ctx, {});
  if (result.status === "posted") {
    ctx.log.info("wolf social_feed post inserted", {
      feed_id: result.feedId,
      source: result.source,
      url: result.url,
      family: result.family?.id,
      variant: result.variant?.id,
      surface: result.variant?.surface,
    });
    ctx.recordActivity({
      actionType: "feed_post",
      actionSummary: `planted bait on ${result.source} (${result.family?.id ?? "?"}) → ${(result.url ?? "").slice(0, 60)} — waiting for traders to scrape`,
      status: "info",
      family: result.family?.id ?? null,
      details: { feed_id: result.feedId, url: result.url },
    });
  } else if (result.status === "post-failed") {
    ctx.log.warn("wolf: social_feed insert failed", { err: result.error });
    ctx.recordActivity({
      actionType: "feed_post",
      actionSummary: `feed_post failed: ${(result.error ?? "").slice(0, 120)}`,
      status: "error",
      family: result.family?.id ?? null,
    });
  } else {
    ctx.log.debug("wolf: no source-shaped incident available");
  }
}
