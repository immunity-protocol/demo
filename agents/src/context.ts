import type { Immunity } from "@immunity-protocol/sdk";
import type { Pool } from "pg";
import type { Logger } from "./log.js";
import type { AgentSlot } from "./wallets.js";

/**
 * One-row description of something the agent did this tick. Recorded into
 * `demo.agent_activity` and surfaced on the dashboard's live activity table.
 *
 * Status semantics:
 *   - `allow`  : check returned allowed=true (routine activity)
 *   - `block`  : antibody hit; the SDK refused the action
 *   - `novel`  : check went to TEE / fell through to policy with novel=true
 *   - `error`  : the action attempted but errored (RPC failure, etc.)
 *   - `info`   : the agent did something with no decision attached (sent a
 *                DM, scanned a feed item, minted an antibody, …)
 */
export interface ActivityRecord {
  actionType: string;
  actionSummary: string;
  status: "allow" | "block" | "novel" | "error" | "info";
  antibodyImmId?: string | null;
  txHash?: string | null;
  target?: string | null;
  family?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Fire-and-forget activity recorder bound to a specific agent's identity.
 * Implementations swallow DB errors and log at warn level — recording an
 * activity row must NEVER cause an agent's tick to fail.
 */
export type RecordActivity = (rec: ActivityRecord) => void;

/**
 * Shared per-agent runtime context handed to ambient and command handlers.
 * Everything they need to act lives here so individual files don't have to
 * accept long argument lists.
 */
export interface AmbientContext {
  slot: AgentSlot;
  displayName: string;
  walletAddress: string;
  immunity: Immunity;
  pool: Pool;
  log: Logger;
  recordActivity: RecordActivity;
}
