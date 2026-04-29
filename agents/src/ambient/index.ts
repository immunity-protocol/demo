import type { AmbientContext } from "../context.js";
import type { AgentRole } from "../wallets.js";
import { runPublisherAmbient } from "./publisher.js";
import { runScenarioAmbient } from "./scenario_agent.js";
import { runTraderAmbient } from "./trader.js";
import { runWolfAmbient } from "./wolf.js";

/**
 * Per-tick ambient action for the given role. Each role file plugs into the
 * switch below and logs whatever it did so dashboards can pick it up.
 *
 * Returning a no-op (just logging "skipped") is fine when the role's
 * weighted-random roll lands on a "do nothing this tick" branch.
 *
 * The legacy `watcher` role was retired in 2026-04 (see wallets.ts note);
 * `external_threat_alert` commands now route to publishers via the app's
 * CommandBroker.pickOnlinePublisher().
 */
export async function runAmbient(role: AgentRole, ctx: AmbientContext): Promise<void> {
  switch (role) {
    case "trader":   return runTraderAmbient(ctx);
    case "wolf":     return runWolfAmbient(ctx);
    case "publisher":return runPublisherAmbient(ctx);
    case "scenario": return runScenarioAmbient(ctx);
  }
}
