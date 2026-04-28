import type { Immunity } from "@immunity-protocol/sdk";
import type { Pool } from "pg";
import type { Logger } from "./log.js";
import type { AgentSlot } from "./wallets.js";

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
}
