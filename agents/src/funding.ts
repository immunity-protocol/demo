import type { Immunity } from "@immunity-protocol/sdk";
import { Contract, type Signer, parseUnits } from "ethers";
import type { Logger } from "./log.js";

const MOCK_USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

export interface FundingConfig {
  /** Wallet USDC target. Topped up via MockUSDC.mint() on boot. */
  walletTargetUsdc: bigint;
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
  const usdc = new Contract(config.mockUsdcAddress, MOCK_USDC_ABI, signer);

  // 1. Wallet top-up.
  const walletBalance = (await usdc.balanceOf(walletAddress)) as bigint;
  if (walletBalance < config.walletTargetUsdc) {
    const need = config.walletTargetUsdc - walletBalance;
    log.info("minting USDC to wallet", {
      need_usdc: formatUsdc(need),
      current_usdc: formatUsdc(walletBalance),
      target_usdc: formatUsdc(config.walletTargetUsdc),
    });
    const tx = await usdc.mint(walletAddress, need);
    await tx.wait();
  } else {
    log.debug("wallet already funded", { current_usdc: formatUsdc(walletBalance) });
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
  const registryTarget = env.USDC_REGISTRY_TARGET ?? "10";
  return {
    walletTargetUsdc:   parseUnits(walletTarget,   6),
    registryTargetUsdc: parseUnits(registryTarget, 6),
    mockUsdcAddress: usdc,
  };
}

function formatUsdc(wei: bigint): string {
  const s = wei.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}
