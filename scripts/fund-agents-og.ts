/**
 * One-shot bootstrap: send native OG to every agent wallet so they have gas
 * for their on-chain check() and publish() calls. Idempotent - checks each
 * wallet's balance and skips agents already at or above the target.
 *
 * Per-agent target: agents listed in TEE_REAL_AGENTS get OG_TEE_FUND_TARGET
 * (default 3.5) so they can bootstrap a 3+ OG 0G Compute ledger. Everyone
 * else gets OG_FUND_TARGET (default 0.3), the demo gas float.
 *
 * Usage:
 *   npm run fund:og                       # uses DEPLOYER_PRIVATE_KEY
 *
 * Env required:
 *   DEPLOYER_PRIVATE_KEY  funded with enough OG to cover sum of targets
 *   MASTER_SEED           BIP-39 mnemonic that derives the 60 agent wallets
 *   GALILEO_RPC_URL       (defaults to https://evmrpc-testnet.0g.ai)
 *   OG_FUND_TARGET        (default 0.3) baseline gas float
 *   OG_TEE_FUND_TARGET    (default 3.5) target for TEE-real agents
 *   TEE_REAL_AGENTS       comma-separated agent ids that get the higher target
 */
import { JsonRpcProvider, Wallet, parseEther, formatEther } from "ethers";
import { allAgentSlots, deriveWallet } from "../agents/src/wallets.js";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`missing env: ${key}`);
  return v;
}

async function main(): Promise<void> {
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");
  const masterSeed = requireEnv("MASTER_SEED");
  const rpcUrl = process.env.GALILEO_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const baseTarget = parseEther(process.env.OG_FUND_TARGET ?? "0.3");
  const teeTarget = parseEther(process.env.OG_TEE_FUND_TARGET ?? "3.5");
  const realTeeAgents = new Set(
    (process.env.TEE_REAL_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );

  const provider = new JsonRpcProvider(rpcUrl);
  const deployer = new Wallet(deployerPk, provider);
  const deployerAddress = await deployer.getAddress();
  const deployerBalance = await provider.getBalance(deployerAddress);
  console.log(`deployer ${deployerAddress} has ${formatEther(deployerBalance)} OG`);
  if (realTeeAgents.size > 0) {
    console.log(`TEE-real agents (target ${formatEther(teeTarget)} OG): ${[...realTeeAgents].join(", ")}`);
  }

  const slots = allAgentSlots();
  const slotsNeedingFunding: { agentId: string; address: string; need: bigint; target: bigint }[] = [];

  for (const slot of slots) {
    const wallet = deriveWallet(masterSeed, slot.agentId);
    const address = await wallet.getAddress();
    const balance = await provider.getBalance(address);
    const target = realTeeAgents.has(slot.agentId) ? teeTarget : baseTarget;
    const tag = realTeeAgents.has(slot.agentId) ? " [TEE]" : "";
    if (balance < target) {
      slotsNeedingFunding.push({ agentId: slot.agentId, address, need: target - balance, target });
    } else {
      console.log(`  skip ${slot.agentId.padEnd(12)}${tag} ${address}  ${formatEther(balance)} OG (≥ ${formatEther(target)})`);
    }
  }

  if (slotsNeedingFunding.length === 0) {
    console.log("\nAll 60 agents already funded. Nothing to do.");
    return;
  }

  const totalNeed = slotsNeedingFunding.reduce((sum, s) => sum + s.need, 0n);
  console.log(`\n${slotsNeedingFunding.length} agents need funding, total ${formatEther(totalNeed)} OG`);
  if (deployerBalance < totalNeed) {
    throw new Error(`deployer has ${formatEther(deployerBalance)} OG but needs ${formatEther(totalNeed)} OG`);
  }

  let nonce = await provider.getTransactionCount(deployerAddress);
  const chainId = (await provider.getNetwork()).chainId;
  for (const s of slotsNeedingFunding) {
    const tx = await deployer.sendTransaction({
      to: s.address,
      value: s.need,
      nonce: nonce++,
      chainId,
    });
    console.log(`  fund ${s.agentId.padEnd(12)} ${s.address}  +${formatEther(s.need)} OG  ${tx.hash}`);
    // Don't wait for receipts on every tx - just on the last so we don't
    // race the next script. Sequential nonces handle ordering.
  }

  console.log("\nWaiting for the last tx to confirm…");
  // Small drain: give the chain a moment, then verify the final agent.
  const last = slotsNeedingFunding[slotsNeedingFunding.length - 1]!;
  for (let i = 0; i < 30; i++) {
    const balance = await provider.getBalance(last.address);
    if (balance >= last.target) {
      console.log(`  confirmed: ${last.agentId} has ${formatEther(balance)} OG`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.warn("Last tx didn't confirm within 60s. Verify manually before starting the fleet.");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
