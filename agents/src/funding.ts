import type { Immunity } from "@immunity-protocol/sdk";
import { Contract, type ContractTransactionResponse, type Signer, parseUnits } from "ethers";
import type { Logger } from "./log.js";

const MOCK_USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

type MockUsdcCallable = {
  balanceOf: (address: string) => Promise<bigint>;
  mint: (to: string, amount: bigint) => Promise<ContractTransactionResponse>;
};

export interface FundingConfig {
  /** Wallet USDC target. Topped up via MockUSDC.mint() on boot. */
  walletTargetUsdc: bigint;
  /**
   * Wallet USDC floor — only mint if balance is below this. Set well below
   * `walletTargetUsdc` so a fully-funded agent's reboot never re-mints
   * (idempotent boot under a thundering herd against the public RPC's 50
   * req/s cap was the v1 boot-convergence failure mode). Default: 1 USDC.
   * If balance < floor, mint enough to reach `walletTargetUsdc`.
   */
  walletFloorUsdc: bigint;
  /** Registry deposit target (covers check fees + publish stake headroom). */
  registryTargetUsdc: bigint;
  /** Address of the mock USDC contract on Galileo. */
  mockUsdcAddress: string;
}

/**
 * Bring the agent's wallet USDC + Registry deposit up to target. Idempotent:
 * a restart finds the agent already funded and short-circuits.
 *
 * Two top-ups happen here:
 *
 *   1. MockUSDC wallet balance → walletTargetUsdc. Visible in the explorer
 *      and used to make synthesized treasury transfers feel real (the agent
 *      doesn't broadcast, but the value-at-risk surfaced via check() is
 *      derived from amounts the agent claims to have).
 *
 *   2. Registry deposit → registryTargetUsdc. Pays for check fees (0.002
 *      USDC each) and publisher stakes (1 USDC each, refunded after 72h).
 *
 * Both steps require positive starting balance from MockUSDC, which has a
 * public mint on Galileo so this is safe to call from any agent wallet.
 */
export async function ensureFundedWallet(
  immunity: Immunity,
  signer: Signer,
  walletAddress: string,
  config: FundingConfig,
  log: Logger,
): Promise<void> {
  const usdc = new Contract(config.mockUsdcAddress, MOCK_USDC_ABI, signer) as Contract & MockUsdcCallable;

  // 1. Wallet top-up.
  // Use a low floor (default 1 USDC) so most reboots are zero-cost: an
  // agent that already holds 250k from a previous mint short-circuits at
  // the floor check and skips the entire RPC + on-chain mint flow. The
  // mint amount, when triggered, still tops up to the higher target so
  // the agent has plenty of headroom for the demo session.
  const walletBalance = await usdc.balanceOf(walletAddress);
  if (walletBalance < config.walletFloorUsdc) {
    const need = config.walletTargetUsdc - walletBalance;
    log.info("minting USDC to wallet", {
      need_usdc: formatUsdc(need),
      current_usdc: formatUsdc(walletBalance),
      floor_usdc: formatUsdc(config.walletFloorUsdc),
      target_usdc: formatUsdc(config.walletTargetUsdc),
    });
    const tx = await usdc.mint(walletAddress, need);
    await tx.wait();
  } else {
    log.debug("wallet at or above floor", {
      current_usdc: formatUsdc(walletBalance),
      floor_usdc: formatUsdc(config.walletFloorUsdc),
    });
  }

  // 2. Registry deposit top-up. The SDK's deposit() handles the approve-and-
  //    transferFrom dance internally.
  const registryBalance = await immunity.balance();
  if (registryBalance < config.registryTargetUsdc) {
    const need = config.registryTargetUsdc - registryBalance;
    log.info("depositing to registry", {
      need_usdc: formatUsdc(need),
      current_usdc: formatUsdc(registryBalance),
    });
    await immunity.deposit(need);
  } else {
    log.debug("registry already funded", { current_usdc: formatUsdc(registryBalance) });
  }
}

export function defaultFundingConfig(env: NodeJS.ProcessEnv): FundingConfig {
  const usdc = env.MOCK_USDC_ADDRESS;
  if (!usdc) {
    throw new Error("MOCK_USDC_ADDRESS env var is required");
  }
  const walletTarget = env.USDC_FUND_TARGET ?? "250000";
  const walletFloor = env.USDC_FUND_FLOOR ?? "1";
  const registryTarget = env.USDC_REGISTRY_TARGET ?? "10";
  return {
    walletTargetUsdc:   parseUnits(walletTarget,   6),
    walletFloorUsdc:    parseUnits(walletFloor,    6),
    registryTargetUsdc: parseUnits(registryTarget, 6),
    mockUsdcAddress: usdc,
  };
}

/**
 * Pre-fund the 0G Compute broker ledger for this wallet so the SDK's TEE
 * verifier init succeeds on the first novel-threat check. Without this,
 * the verifier internally calls `addLedger(3)` which needs 3+ OG; agents
 * holding ~0.3 OG end up with the verifier disabled and a fleet-wide
 * fall-through to trust-cache (no SEMANTIC auto-mint).
 *
 * Idempotent: calls into the SDK's `ensureTeeFunded()` which short-circuits
 * if the ledger is already funded. Errors are swallowed and logged — TEE
 * is best-effort; the agent still works (with degraded novel-threat
 * detection) when 0G Compute is unavailable.
 */
export async function ensureTeeReady(
  immunity: Immunity,
  log: Logger,
  opts: { minLedgerOg: number; minProviderOg: number },
): Promise<void> {
  try {
    log.info("ensuring TEE compute ledger funded", opts);
    await immunity.ensureTeeFunded(opts);
    log.info("TEE compute ledger ready");
  } catch (err) {
    log.warn("TEE ledger funding failed; novel-threat path will fall back to trust-cache", {
      err: String(err).slice(0, 200),
    });
  }
}

function formatUsdc(wei: bigint): string {
  const s = wei.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}
