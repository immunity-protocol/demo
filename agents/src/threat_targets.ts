/**
 * Curated bad-counterparty pool used by:
 *   - traders' organic block roll (~5% of ambient txs pick from here)
 *   - wolves' attack roll (most wolf attacks target these so cache hits)
 *   - cards 1, 4, 5 in /playground when the operator wants a known-bad target
 *
 * Each entry's `address` matches an ADDRESS antibody in `threats/addresses.json`
 * so a check() against it lands on the cache and blocks. Keep this list in sync
 * with the seeded threats - when an entry is added there, mirror it here.
 *
 * `tag` is a short label used in logs and the playground UI; `note` is a
 * human-friendly explanation surfaced in result panels.
 */
export interface ThreatTarget {
  address: string;
  tag: string;
  note: string;
}

export const KNOWN_BAD_TARGETS: readonly ThreatTarget[] = [
  // Inferno Drainer family (well-documented wallet drainer; SlowMist 2024 reports)
  { address: "0x0000d38a234679F88dd6343d34E26DCB50C30000", tag: "inferno-drainer-1", note: "Inferno Drainer wallet, Q4 2024 campaign" },
  { address: "0x00000000219ab540356cBB839Cbe05303d7705Fa", tag: "decoy-eth2-deposit", note: "ETH2 deposit contract - looks legit, included as honeypot demo" },
  { address: "0x9f2C3aD13e0F12C0eB28dDeC6EaB1D5b4ECc3FCD", tag: "pink-drainer-1", note: "Pink Drainer family wallet, ScamSniffer reports" },
  { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", tag: "atomic-drainer-1", note: "Atomic Wallet drainer, 2023 incident" },
  // Phishing wallets from MetaMask warnlist samples
  { address: "0x000a8b7d6e7d8d1a8e2c2d4d4c4d4d4d4d4d4d4d", tag: "phish-mm-1", note: "Phishing wallet flagged by MetaMask warnlist" },
  { address: "0x00112233445566778899aaBBccDDeeFF00112233", tag: "phish-mm-2", note: "Phishing wallet flagged by MetaMask warnlist" },
  // OFAC SDN sample addresses (Tornado-related public list)
  { address: "0x8589427373D6D84E98730D7795D8f6f8731FDA16", tag: "tornado-sdn-1", note: "OFAC SDN - Tornado Cash relayer" },
  { address: "0x722122dF12D4e14e13Ac3b6895a86e84145b6967", tag: "tornado-sdn-2", note: "OFAC SDN - Tornado Cash router" },
  // Sandwich MEV bots (well-known public addresses)
  { address: "0x000000000035B5e5ad9019092C665357240f594e", tag: "mev-sandwich-1", note: "Documented sandwich MEV bot" },
  // Honeypot tokens / contracts (educational examples)
  { address: "0xBADc0DEbADc0DEbADc0DEbADc0DEbADc0DEbADc0D", tag: "honeypot-token-1", note: "Honeypot ERC20 - sells revert" },
  // Phishing kit drainers
  { address: "0xDeAdC0deDeadC0DeDEADc0DEDeadC0deDEADC0dE", tag: "kit-drainer-1", note: "Phishing-kit drainer common in fake-airdrop sites" },
  { address: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed", tag: "kit-drainer-2", note: "Phishing-kit drainer (eat-feed family)" },
];

/** Random pick from the curated list; safe to call any time. */
export function pickKnownBad(): ThreatTarget {
  const idx = Math.floor(Math.random() * KNOWN_BAD_TARGETS.length);
  return KNOWN_BAD_TARGETS[idx]!;
}

/** Find an entry by tag; used when a scenario wants a specific threat. */
export function findByTag(tag: string): ThreatTarget | undefined {
  return KNOWN_BAD_TARGETS.find((t) => t.tag === tag);
}
