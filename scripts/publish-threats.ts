/**
 * One-shot bootstrap: publish the curated threat data in /threats to the live
 * Registry. Idempotent - tracks committed antibodies in `.publish-state.json`
 * so reruns skip already-published entries.
 *
 * Usage:
 *   npm run threats:publish              # uses DEPLOYER_PRIVATE_KEY
 *
 * Env required:
 *   DEPLOYER_PRIVATE_KEY  funded with at least 80 USDC + a little OG
 *   GALILEO_RPC_URL       (defaults to https://evmrpc-testnet.0g.ai)
 *   AXL_URL               (the local spoke or any reachable axl node)
 *   MOCK_USDC_ADDRESS     (Galileo MockUSDC)
 */
import { Immunity, parseUsdc, type AntibodySeed, type PublishInput } from "@immunity-protocol/sdk";
import { JsonRpcProvider, Wallet, Contract, parseUnits } from "ethers";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, ".publish-state.json");
const THREATS_DIR = path.join(ROOT, "threats");

const FILES = [
  "addresses.json",
  "call-patterns.json",
  "bytecode.json",
  "graph-taints.json",
  "semantic.json",
];

const MOCK_USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

interface ThreatEntry {
  seed: AntibodySeed;
  verdict: "MALICIOUS" | "SUSPICIOUS";
  confidence: number;
  severity: number;
  expires_at?: number | string;
  reasoning?: string;
  seed_source?: string;
  evidence_url?: string | null;
}

interface PublishedRecord {
  source_file: string;
  entry_index: number;
  imm_seq: number;
  keccak_id: string;
  tx_hash: string;
  published_at: string;
}

interface State {
  published: PublishedRecord[];
}

function entryKey(file: string, idx: number): string {
  return `${file}#${idx}`;
}

async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as State;
  } catch {
    return { published: [] };
  }
}

async function saveState(state: State): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`missing env: ${key}`);
  return v;
}

async function topUpDeployer(immunity: Immunity, signer: Wallet, walletAddress: string, mockUsdc: string): Promise<void> {
  const usdc = new Contract(mockUsdc, MOCK_USDC_ABI, signer);
  const balance = (await usdc.balanceOf(walletAddress)) as bigint;
  const target = parseUnits("100", 6); // 100 USDC headroom for stakes
  if (balance < target) {
    const need = target - balance;
    console.log(`minting ${need} USDC to deployer wallet…`);
    const tx = await usdc.mint(walletAddress, need);
    await tx.wait();
  }
  const registry = await immunity.balance();
  const registryTarget = parseUsdc("80"); // ~70 antibodies × 1 USDC stake + buffer
  if (registry < registryTarget) {
    const need = registryTarget - registry;
    console.log(`depositing ${need} USDC to registry…`);
    await immunity.deposit(need);
  }
}

async function main(): Promise<void> {
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");
  const rpcUrl     = process.env.GALILEO_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const axlUrl     = requireEnv("AXL_URL");
  const mockUsdc   = requireEnv("MOCK_USDC_ADDRESS");

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(deployerPk, provider);
  const walletAddress = await wallet.getAddress();
  console.log(`publisher wallet: ${walletAddress}`);

  const immunity = new Immunity({
    wallet,
    network: "testnet",
    axlUrl,
    novelThreatPolicy: "trust-cache",
  });
  await immunity.start();

  await topUpDeployer(immunity, wallet, walletAddress, mockUsdc);

  const state = await loadState();
  const seen = new Set(state.published.map((p) => entryKey(p.source_file, p.entry_index)));

  let publishedThisRun = 0;
  let skipped = 0;

  for (const file of FILES) {
    const fullPath = path.join(THREATS_DIR, file);
    const raw = await fs.readFile(fullPath, "utf8");
    const entries = JSON.parse(raw) as ThreatEntry[];
    for (let i = 0; i < entries.length; i++) {
      const key = entryKey(file, i);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      const entry = entries[i]!;
      const input: PublishInput = {
        seed: entry.seed,
        verdict: entry.verdict,
        confidence: entry.confidence,
        severity: entry.severity,
      };
      if (entry.expires_at !== undefined && entry.expires_at !== 0 && entry.expires_at !== "0") {
        input.expiresAt = BigInt(entry.expires_at);
      }
      try {
        const result = await immunity.publish(input);
        const record: PublishedRecord = {
          source_file: file,
          entry_index: i,
          imm_seq: result.immSeq,
          keccak_id: result.keccakId,
          tx_hash: result.txHash,
          published_at: new Date().toISOString(),
        };
        state.published.push(record);
        await saveState(state);
        publishedThisRun++;
        console.log(`✓ ${file}#${i} → IMM-seq ${result.immSeq} (${result.txHash})`);
      } catch (err) {
        console.error(`✗ ${file}#${i} failed: ${String(err)}`);
        // Stop on first failure so the operator can investigate. State is
        // already persisted up to the last success, so resume just works.
        await immunity.stop();
        process.exit(1);
      }
      // Pace ourselves so the chain has time between publishes.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  await immunity.stop();
  console.log(`\nDone. Published ${publishedThisRun} this run, skipped ${skipped} (already published).`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
