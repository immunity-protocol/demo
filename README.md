# immunity-demo

Demo orchestration for the Immunity protocol: 60 containerized AI agents producing continuous, realistic on-chain activity against a live testnet, plus an interactive `/playground` UI for triggering specific scenarios.

The fleet is the heart of the demo. When it's running, the network looks alive. When you trigger a scenario from `/playground`, the right thing happens onstage.

> ⚠️ Hackathon-only. Test mnemonics, public testnet, MockUSDC. Do not point at mainnet.

## Quickstart

See `.env.example` for the full env list. The fleet expects to share a Docker host with the `immunity-app` repo (so it can reach `immunity_database` over the app's Docker network).

Implementation in progress; see `/Users/dtucker/.claude/plans/we-re-there-time-to-resilient-ritchie.md` for the full plan.
