/**
 * One-shot read of the Registry's treasury balance + the publisher pool.
 * Treasury accumulates 20% of every check fee; payouts to publishers are
 * the matching 80% per match. No state is mutated.
 *
 * Usage:  npx tsx scripts/treasury.ts
 *
 * Env required: REGISTRY_ADDRESS, MOCK_USDC_ADDRESS, GALILEO_RPC_URL (optional)
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";

const REGISTRY_ABI = [
  "function treasuryBalance() view returns (uint256)",
  "function CHECK_FEE() view returns (uint256)",
  "function PUBLISH_STAKE() view returns (uint256)",
  "function STAKE_LOCK_DURATION() view returns (uint256)",
  "function TREASURY_REWARD_BPS() view returns (uint256)",
  "function PUBLISHER_REWARD_BPS() view returns (uint256)",
  "function BPS_DENOMINATOR() view returns (uint256)",
  "function usdc() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main(): Promise<void> {
  const registryAddr = process.env.REGISTRY_ADDRESS;
  if (!registryAddr) throw new Error("REGISTRY_ADDRESS required");
  const rpcUrl = process.env.GALILEO_RPC_URL ?? "https://evmrpc-testnet.0g.ai";

  const provider = new JsonRpcProvider(rpcUrl);
  const reg = new Contract(registryAddr, REGISTRY_ABI, provider);

  const [treasury, checkFee, publishStake, lockSecs, treasuryBps, publisherBps, bpsDenom, usdcAddr] =
    await Promise.all([
      reg.treasuryBalance() as Promise<bigint>,
      reg.CHECK_FEE() as Promise<bigint>,
      reg.PUBLISH_STAKE() as Promise<bigint>,
      reg.STAKE_LOCK_DURATION() as Promise<bigint>,
      reg.TREASURY_REWARD_BPS() as Promise<bigint>,
      reg.PUBLISHER_REWARD_BPS() as Promise<bigint>,
      reg.BPS_DENOMINATOR() as Promise<bigint>,
      reg.usdc() as Promise<string>,
    ]);

  const usdc = new Contract(usdcAddr, ERC20_ABI, provider);
  const [decimals, symbol, registryUsdcBal] = await Promise.all([
    usdc.decimals() as Promise<bigint>,
    usdc.symbol() as Promise<string>,
    usdc.balanceOf(registryAddr) as Promise<bigint>,
  ]);

  const dec = Number(decimals);
  const denom = Number(bpsDenom);
  const fmt = (n: bigint): string => `${formatUnits(n, dec)} ${symbol}`;

  console.log(`Registry          : ${registryAddr}`);
  console.log(`Fee token         : ${usdcAddr} (${symbol}, ${dec} decimals)`);
  console.log(`Per-check fee     : ${fmt(checkFee)}`);
  console.log(`Publish stake     : ${fmt(publishStake)} locked ${Number(lockSecs) / 3600}h`);
  console.log(`Reward split      : publisher ${(Number(publisherBps) / denom) * 100}% / treasury ${(Number(treasuryBps) / denom) * 100}%`);
  console.log("");
  console.log(`Treasury balance  : ${fmt(treasury)}    (sweepable by treasury owner)`);
  console.log(`Registry USDC bal : ${fmt(registryUsdcBal)}  (treasury + publisher pool + locked stakes)`);
  console.log(`Publisher + stake : ${fmt(registryUsdcBal - treasury)}  (rewards owed + active 1 USDC stakes)`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
