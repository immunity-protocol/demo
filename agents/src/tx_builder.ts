import type { ProposedTx } from "@immunity-protocol/sdk";
import { Interface, MaxUint256, parseUnits, randomBytes, getAddress, hexlify } from "ethers";

/**
 * Construct realistic-looking treasury txs for the ambient + scenario layers.
 *
 * Important: these txs are NOT broadcast. They're constructed solely so
 * `immunity.check(tx, ctx)` has something realistic to inspect (and so the
 * resulting on-chain CheckSettled event carries plausible token/chain facts
 * for the indexer to surface in the dashboard).
 *
 * Amounts are USDC-decimals (6). Counterparty addresses are checksummed.
 */

const ERC20_ABI = [
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
];
const ERC20 = new Interface(ERC20_ABI);

// Uniswap V3 SwapRouter02 (Sepolia + Mainnet). Used as a "DEX router" target
// purely for the to-address; we never broadcast so the chain doesn't matter.
const SAFE_DEX_ROUTERS: readonly string[] = [
  "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 Router
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap V3 Router 02
];

export interface BuildEnv {
  chainId: number;
  usdcAddress: string;
}

/**
 * Lognormal-ish amount picker so most txs are small ($500-$5k) but the tail
 * extends well into 6 figures.
 */
export function lognormalUsdcAmount(minUsd: number, maxUsd: number): bigint {
  const r = Math.random();
  // Skew small: r^2 keeps the median near minUsd, the long tail reaches maxUsd.
  const skewed = minUsd + (maxUsd - minUsd) * Math.pow(r, 2.4);
  const dollars = Math.max(1, Math.round(skewed));
  return parseUnits(String(dollars), 6);
}

export function pickRouter(): string {
  const idx = Math.floor(Math.random() * SAFE_DEX_ROUTERS.length);
  return getAddress(SAFE_DEX_ROUTERS[idx]!);
}

export function buildErc20Transfer(env: BuildEnv, to: string, amount: bigint): ProposedTx {
  return {
    to: getAddress(env.usdcAddress) as ProposedTx["to"],
    value: 0n,
    data: ERC20.encodeFunctionData("transfer", [getAddress(to), amount]) as ProposedTx["data"],
    chainId: env.chainId,
  };
}

export function buildErc20Approve(env: BuildEnv, spender: string, amount: bigint = MaxUint256): ProposedTx {
  return {
    to: getAddress(env.usdcAddress) as ProposedTx["to"],
    value: 0n,
    data: ERC20.encodeFunctionData("approve", [getAddress(spender), amount]) as ProposedTx["data"],
    chainId: env.chainId,
  };
}

/**
 * "Swap" tx: USDC.transfer(router, amount). A real swap would call the router
 * with calldata, but for value-at-risk indexing the underlying token-out
 * shape is the same: USDC moves to the router, get tokens back. Captures the
 * "I'm trading $X of USDC" intent without needing the router's full ABI.
 */
export function buildSwap(env: BuildEnv, amount: bigint): ProposedTx {
  return buildErc20Transfer(env, pickRouter(), amount);
}

/**
 * Random wallet address. Useful for "approve to a fresh spender" or similar
 * benign churn.
 */
export function randomAddress(): string {
  return getAddress(hexlify(randomBytes(20)));
}
