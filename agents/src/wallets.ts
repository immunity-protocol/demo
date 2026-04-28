import { HDNodeWallet, Mnemonic } from "ethers";

/**
 * Stable agent IDs map to fixed HD-path indices so a restarted container
 * always derives the same wallet.
 *
 * Index allocation:
 *   trader-1  .. trader-50    →   0 .. 49
 *   wolf-1    .. wolf-3       →  50 .. 52
 *   publisher-1 .. publisher-5 → 53 .. 57
 *   watcher-1                 →  58
 *   scenario-1                →  59
 */
export type AgentRole = "trader" | "wolf" | "publisher" | "watcher" | "scenario";

const ROLE_BASE: Record<AgentRole, number> = {
  trader: 0,
  wolf: 50,
  publisher: 53,
  watcher: 58,
  scenario: 59,
};

const ROLE_COUNT: Record<AgentRole, number> = {
  trader: 50,
  wolf: 3,
  publisher: 5,
  watcher: 1,
  scenario: 1,
};

export interface AgentSlot {
  agentId: string;
  role: AgentRole;
  index: number;
  hdPath: string;
}

export function parseAgentId(agentId: string): AgentSlot {
  const match = /^([a-z]+)-(\d+)$/.exec(agentId);
  if (!match) {
    throw new Error(`invalid agent_id: "${agentId}" (expected role-N)`);
  }
  const role = match[1] as AgentRole;
  const ordinal = Number.parseInt(match[2]!, 10);
  if (!(role in ROLE_BASE)) {
    throw new Error(`unknown role "${role}" in agent_id "${agentId}"`);
  }
  const max = ROLE_COUNT[role];
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > max) {
    throw new Error(`agent_id "${agentId}" out of range (1..${max})`);
  }
  const index = ROLE_BASE[role] + (ordinal - 1);
  return { agentId, role, index, hdPath: `m/44'/60'/0'/0/${index}` };
}

export function deriveWallet(masterSeed: string, agentId: string): HDNodeWallet {
  const slot = parseAgentId(agentId);
  const mnemonic = Mnemonic.fromPhrase(masterSeed.trim());
  return HDNodeWallet.fromMnemonic(mnemonic, slot.hdPath);
}

/**
 * Enumerate every agent in the fleet in stable order. Used by orchestration
 * scripts (fund-agents-og, generate-compose) to walk the whole roster.
 */
export function allAgentSlots(): AgentSlot[] {
  const out: AgentSlot[] = [];
  for (const role of Object.keys(ROLE_BASE) as AgentRole[]) {
    for (let i = 1; i <= ROLE_COUNT[role]; i++) {
      out.push(parseAgentId(`${role}-${i}`));
    }
  }
  return out;
}
