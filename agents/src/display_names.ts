import type { AgentRole } from "./wallets.js";

/**
 * Curated ENS-style display names. The explorer in the app substitutes these
 * for hex addresses, joining via demo.agent_heartbeat.address.
 *
 * Naming intent:
 *   - traders: nature/object words that read as benign treasury operators
 *   - wolves: predator imagery so they're easy to spot in stage demos
 *   - publishers: watcher/sentinel imagery - vigilant but neutral
 *   - watcher: a single named external-feed consumer
 *   - scenario: a single named stage actor
 *
 * Lists are positionally indexed (trader-1 ↔ TRADER_NAMES[0], etc.). Editing
 * order is fine; editing names mid-demo is fine; both reattach by agent_id.
 */
const TRADER_NAMES: readonly string[] = [
  "whisperingoak.eth", "silvermoss.eth",   "ironroot.eth",     "claybrook.eth",
  "saltflats.eth",     "linenpost.eth",    "amberreef.eth",    "snowmark.eth",
  "redgranite.eth",    "blueheath.eth",    "lowerterrace.eth", "highmesa.eth",
  "northport.eth",     "eastbluff.eth",    "westhollow.eth",   "southbasin.eth",
  "marshquill.eth",    "duskpine.eth",     "dawncurve.eth",    "longshore.eth",
  "shortpier.eth",     "halfmoon.eth",     "fullsail.eth",     "quietharbor.eth",
  "loudvalley.eth",    "thinair.eth",      "deepwell.eth",     "sharpedge.eth",
  "wideplain.eth",     "tallspruce.eth",   "lowtide.eth",      "midnightfern.eth",
  "morningbell.eth",   "noonshadow.eth",   "eveningfox.eth",   "rivergate.eth",
  "stoneferry.eth",    "graniteford.eth",  "copperhill.eth",   "tinroof.eth",
  "lakehead.eth",      "creekstone.eth",   "barleyfield.eth",  "winterelm.eth",
  "summerash.eth",     "autumnbeech.eth",  "springpoplar.eth", "dusthawthorn.eth",
  "moonwillow.eth",    "starbirch.eth",
];

const WOLF_NAMES: readonly string[] = [
  "huntress.eth",
  "ravager.eth",
  "shade.eth",
];

const PUBLISHER_NAMES: readonly string[] = [
  "sentinel.eth",
  "scout.eth",
  "lighthouse.eth",
  "prime.eth",
  "outpost.eth",
];

const WATCHER_NAMES: readonly string[] = ["vigil.eth"];
const SCENARIO_NAMES: readonly string[] = ["stagehand.eth"];

const NAMES_BY_ROLE: Record<AgentRole, readonly string[]> = {
  trader: TRADER_NAMES,
  wolf: WOLF_NAMES,
  publisher: PUBLISHER_NAMES,
  watcher: WATCHER_NAMES,
  scenario: SCENARIO_NAMES,
};

export function displayNameFor(agentId: string): string {
  const match = /^([a-z]+)-(\d+)$/.exec(agentId);
  if (!match) {
    throw new Error(`invalid agent_id "${agentId}"`);
  }
  const role = match[1] as AgentRole;
  const ordinal = Number.parseInt(match[2]!, 10);
  const list = NAMES_BY_ROLE[role];
  if (list === undefined) {
    throw new Error(`no display-name list for role "${role}"`);
  }
  const name = list[ordinal - 1];
  if (name === undefined) {
    throw new Error(`agent_id "${agentId}" has no display name (ordinal ${ordinal} > ${list.length})`);
  }
  return name;
}
