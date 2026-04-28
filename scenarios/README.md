# Scenarios

Pre-canned demo moments. Each file inserts the same row(s) the matching `/playground` Section-3 button would, so you can replay the demo from a shell when the page is unreachable. Apply with:

```sh
./scripts/run-scenario.sh 01      # exact prefix match
./scripts/run-scenario.sh fresh   # substring match
```

## The five scripted moments

| # | File | What it does | Narrative beat |
|---|---|---|---|
| 01 | `01-fresh-detection.sql` | Wolf-1 attempts a novel attack with rich context. Cache misses, TEE evaluates, antibody auto-mints. | "First time the network sees this attack. Watch it think, decide, and protect everyone." |
| 02 | `02-cache-replay.sql` | Wolf-2 replays a known threat (Atomic Wallet drainer). AddressMatcher hits in microseconds. | "Same kind of attack. Different attacker. Block in milliseconds. The first agent paid; everyone else benefits." |
| 03 | `03-twitter-trigger.sql` | Watcher-1 publishes ADDRESS antibody from a simulated external alert. | "Community tweet. Five seconds to propagated antibody. Every agent immune." |
| 04 | `04-prompt-injection.sql` | Scenario-1 fires a prompt-injection at trader-7. SemanticMatcher catches it. | "The instruction is plain text. The SDK catches it before any tx is built." |
| 05 | `05-resilience-kill-nodes.sh` | Hard-kills 5 random trader containers (`docker kill`). | "We can take any 5 agents off the network. Everything else keeps working." |

Scenarios are idempotent (each apply enqueues a fresh row) so running them mid-demo is always safe.
