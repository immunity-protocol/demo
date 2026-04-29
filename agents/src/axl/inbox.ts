import type { CheckContext } from "@immunity-protocol/sdk";
import type { AmbientContext } from "../context.js";
import { type AxlClient, decodeEnvelope, peerIdMatches } from "./client.js";

/**
 * Per-tick AXL inbox drain.
 *
 * Pulls messages from /recv until empty and dispatches each by `kind`. The
 * v1 demo cares about a single envelope kind: `social_dm` — adversarial
 * direct message from a wolf to a trader. The recipient runs
 * `immunity.check(null, context)` with the carried context attached as
 * `conversation`, mirroring the indirect-injection threat model.
 *
 * Bounded per call (MAX_DRAIN_PER_TICK) so a flooded inbox cannot starve
 * the agent's other work; remaining messages stay queued for the next tick.
 */

const MAX_DRAIN_PER_TICK = 8;

interface SocialDmPayload {
  family_id?: string;
  variant_id?: string;
  surface?: string;
  context: CheckContext;
}

export async function drainInbox(ctx: AmbientContext, axl: AxlClient): Promise<void> {
  for (let i = 0; i < MAX_DRAIN_PER_TICK; i++) {
    let msg: { from: string; body: Uint8Array } | null;
    try {
      msg = await axl.recv();
    } catch (err) {
      ctx.log.warn("axl recv failed", { err: String(err) });
      return;
    }
    if (!msg) return;

    const env = decodeEnvelope<SocialDmPayload>(msg.body);
    if (!env) {
      ctx.log.debug("axl: dropping message with foreign envelope");
      continue;
    }
    if (env.kind !== "social_dm") {
      ctx.log.debug("axl: unknown envelope kind", { kind: env.kind });
      continue;
    }

    const fromName = await resolveSenderName(ctx, msg.from);
    const payload = env.payload;
    const context = payload.context;
    if (!context || (typeof context !== "object")) {
      ctx.log.debug("axl: social_dm with empty context");
      continue;
    }

    try {
      const result = await ctx.immunity.check(null, context);
      const tag = {
        axlFrom: fromName ?? msg.from.slice(0, 12),
        family: payload.family_id,
        variant: payload.variant_id,
        surface: payload.surface,
      };
      if (result.allowed) {
        ctx.log.info("social_dm allowed (no marker hit, novel)", { ...tag, source: result.source });
        ctx.recordActivity({
          actionType: "social_dm_in",
          actionSummary: `DM from ${fromName ?? "unknown"} (${payload.family_id ?? "?"})`,
          status: result.novel ? "novel" : "allow",
          target: fromName,
          family: payload.family_id ?? null,
        });
      } else {
        ctx.log.info("social_dm blocked", {
          ...tag,
          reason: result.reason,
          antibody: result.antibodies[0]?.immId,
          source: result.source,
        });
        ctx.recordActivity({
          actionType: "social_dm_in",
          actionSummary: `DM from ${fromName ?? "unknown"} blocked: ${result.reason}`,
          status: "block",
          antibodyImmId: result.antibodies[0]?.immId ?? null,
          target: fromName,
          family: payload.family_id ?? null,
        });
      }
    } catch (err) {
      ctx.log.warn("social_dm check error", { err: String(err) });
      ctx.recordActivity({
        actionType: "social_dm_in",
        actionSummary: `DM check error: ${String(err).slice(0, 120)}`,
        status: "error",
        target: fromName,
        family: payload.family_id ?? null,
      });
    }
  }
}

/**
 * Best-effort sender resolution by prefix-matching the truncated /recv
 * X-From-Peer-Id header against axl_peer_id values in the heartbeat
 * directory. Returns the agent_id when a unique match exists, null
 * otherwise (so the log just shows the truncated header).
 */
async function resolveSenderName(ctx: AmbientContext, fromHeader: string): Promise<string | null> {
  if (!fromHeader) return null;
  const res = await ctx.pool.query<{ agent_id: string; axl_peer_id: string }>(
    `SELECT agent_id, axl_peer_id
       FROM demo.agent_heartbeat
      WHERE axl_peer_id IS NOT NULL
        AND last_seen >= now() - interval '180 seconds'`,
  );
  for (const row of res.rows) {
    if (peerIdMatches(fromHeader, row.axl_peer_id)) return row.agent_id;
  }
  return null;
}
