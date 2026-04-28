import type { AmbientContext } from "../context.js";

/**
 * Watcher is intentionally idle. It only reacts to `external_threat_alert`
 * commands enqueued by the playground (Card 2) or by the Pipedream webhook
 * `POST /v1/internal/threat-report`.
 *
 * Keeping the ambient tick a no-op preserves the watcher's wallet for stake
 * — it should always have spare USDC ready to publish on operator demand.
 */
export async function runWatcherAmbient(ctx: AmbientContext): Promise<void> {
  ctx.log.debug("watcher idle (awaiting external_threat_alert commands)");
}
