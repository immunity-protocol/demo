import { HDNodeWallet, Mnemonic } from "ethers";

/**
 * Stable agent IDs map to fixed HD-path indices so a restarted container
 * always derives the same wallet.
 *
 * Index allocation (60 wallets total, fixed for all time):
 *   trader-1  .. trader-50    →   0 .. 49     (50 traders)
 *   wolf-1    .. wolf-3       →  50 .. 52     (3 wolves)
 *   publisher-1 .. publisher-5 → 53 .. 57     (5 publishers)
 *   trader-51                 →  58           (formerly watcher-1; see note)
 *   scenario-1                →  59           (1 scenario actor)
 *
 * Note on trader-51: when the demo evolved from a separate `watcher` role
 * into the LLM-driven publisher model in 2026-04, the watcher slot at HD
 * index 58 still held real 0G testnet gas balance. Rather than abandoning
 * that wallet, we repurposed slot 58 as a 51st trader. This keeps the HD
 * derivation contract stable for every other agent (wolves and publishers
 * keep their own 0G), and resurrects the watcher's 0G as fleet trading
 * capital.
 *
 * The override below is the only special case in `parseAgentId`.
 */
export type AgentRole = "trader" | "wolf" | "publisher" | "scenario";

const ROLE_BASE: Record<AgentRole, number> = {
  trader: 0,
  wolf: 50,
  publisher: 53,
  scenario: 59,
};

// Fleet sized down from 60 (51 traders) to 48 (39 traders) to fit within
// 0G testnet's ~50 req/s RPC budget on cold boot. With 60 agents each
// fetching ~45 antibodies sequentially during cache bootstrap, the herd
// burned ~6 minutes of pure rate-limited backoff and many agents never
// fully hydrated. 39 traders × 45 reads in the same 15s stagger window
// leaves room for the wolves, publishers, and the scenario agent's own
// boot RPC calls without saturating the limiter.
const ROLE_COUNT: Record<AgentRole, number> = {
  trader: 39,
  wolf: 3,
  publisher: 5,
  scenario: 1,
};

/**
 * Per-agent HD-index overrides. `trader-51` lands at the freed watcher
 * slot (index 58) instead of the contiguous slot the formula would
 * compute (50). All other agents fall through to ROLE_BASE + ordinal.
 */
const HD_INDEX_OVERRIDES: Record<string, number> = {
  "trader-51": 58,
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
  const overrideIdx = HD_INDEX_OVERRIDES[agentId];
  const index = overrideIdx ?? ROLE_BASE[role] + (ordinal - 1);
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
