import type { AmbientContext } from "../context.js";

/**
 * Scenario agent is intentionally idle. It only acts on operator commands -
 * `manipulate` (cross-agent prompt injection demo) plus any custom `attack`
 * the operator wants to fire from a known stage actor.
 */
export async function runScenarioAmbient(ctx: AmbientContext): Promise<void> {
  ctx.log.debug("scenario agent idle (awaiting operator commands)");
}
