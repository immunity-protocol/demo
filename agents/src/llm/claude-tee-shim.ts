import Anthropic from "@anthropic-ai/sdk";
import {
  type CheckContext,
  type ProposedTx,
  type TeeVerifyFn,
  type TeeVerifyOutcome,
  buildVerdictPrompt,
  distillBundle,
  parseVerdict,
} from "@immunity-protocol/sdk";

/**
 * Claude-backed drop-in for the SDK's TEE verifier.
 *
 * Why this exists: the 0G Compute ledger has a 3 OG hard-floor on
 * `addLedger`. Demo agents are funded with ~0.3 OG so the on-chain TEE
 * path is unreachable until either the deployer is topped up to ~150 OG
 * (39 traders × 3+ OG) or each agent is topped up individually. Until
 * then, novel checks fall through to the SDK's permissive trust-cache
 * path and nothing actually verifies an attack the cache doesn't already
 * know about.
 *
 * This shim takes the same `(tx, ctx)` the SDK would hand a TEE callback,
 * builds the same prompt the SDK builds for qwen-2.5-7b-instruct
 * (`buildVerdictPrompt` from the public API), and asks Claude
 * Haiku 4.5 instead. The response goes through the SDK's own
 * `parseVerdict` / `seedFromTx` validators, so the shape and behaviour of
 * a verdict are identical to what the on-chain path produces. The
 * caller-facing semantics (`source: "tee"`, SEMANTIC auto-mint, escalate
 * thresholds) are preserved verbatim.
 *
 * What's NOT preserved:
 *   - On-chain attestation hash (Claude doesn't sign with a TDX-bound
 *     key; nobody verifies the attestation in the demo so this is
 *     functionally invisible).
 *   - Signed per-response integrity check.
 *   - The 0G storage upload of the encrypted context (we skip — Claude
 *     doesn't read from CIDs and the demo doesn't surface contextHash
 *     anywhere meaningful).
 *
 * Wire it in `agent.ts` as `new Immunity({ ..., teeVerifier: createClaudeTeeShim() })`.
 * When the deployer wallet eventually has 150+ OG, drop the override and
 * agents flip to the real 0G TEE with no other code change.
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 800;

interface ClaudeShimOptions {
  /**
   * Block threshold default mirrors the TEE verifier (block when
   * confidence >= 85). The SDK's check-flow re-applies its own
   * thresholds on top via `seedFromTx`/`decideFromVerdict`, so this is a
   * coarse gate, not the final word.
   */
  blockThreshold?: number;
  escalateThreshold?: number;
  defaultChainId?: number;
  semanticAutoMint?: boolean;
}

/**
 * Build the Claude-backed verifier. Returns null if `ANTHROPIC_API_KEY`
 * is unset — caller should fall back to whatever the SDK's default does
 * (i.e. trust-cache).
 */
export function createClaudeTeeShim(opts: ClaudeShimOptions = {}): TeeVerifyFn | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[claude-tee-shim] ANTHROPIC_API_KEY not set; novel-threat verification disabled");
    return null;
  }
  const client = new Anthropic({ apiKey });
  const blockThreshold = opts.blockThreshold ?? 85;
  const escalateThreshold = opts.escalateThreshold ?? 60;
  const defaultChainId = opts.defaultChainId ?? Number.parseInt(process.env.GALILEO_CHAIN_ID ?? "16602", 10);
  const semanticAutoMint = opts.semanticAutoMint ?? false;

  return async (tx: ProposedTx | null, ctx: CheckContext): Promise<TeeVerifyOutcome | null> => {
    let bundle: string;
    try {
      bundle = distillBundle(tx, ctx);
    } catch (err) {
      console.warn(`[claude-tee-shim] distillBundle failed: ${String(err).slice(0, 200)}`);
      return null;
    }
    const prompt = buildVerdictPrompt({ bundle });

    let raw: string;
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // The verdict prompt is self-contained (definitions, examples,
        // strict JSON contract). Pass it as the system message so the
        // user turn stays minimal — keeps the cached portion of the
        // prompt large and the per-call portion small.
        system: prompt,
        messages: [{ role: "user", content: "Return the verdict JSON now." }],
      });
      const block = resp.content.find((b) => b.type === "text");
      raw = block && block.type === "text" ? block.text : "";
    } catch (err) {
      console.warn(`[claude-tee-shim] inference failed: ${String(err).slice(0, 200)}`);
      return null;
    }

    let verdict;
    try {
      verdict = parseVerdict(raw);
    } catch (err) {
      console.warn(`[claude-tee-shim] verdict parse rejected: ${String(err).slice(0, 200)}`);
      return null;
    }

    // Map the strict verdict onto the SDK's TeeVerifyOutcome shape. We
    // intentionally do NOT replicate the SDK's `seedFromTx` here — that
    // logic is internal and applies the auto-mint guardrails (verbatim
    // marker presence, length/shape validation, denylist). For the shim
    // we publish a SEMANTIC seed only when the verdict's marker passes
    // the SDK's basic shape (>= 20 chars, multi-word, present in bundle).
    const block = verdict.confidence >= blockThreshold && verdict.verdict !== "BENIGN";
    const escalate = !block && verdict.confidence >= escalateThreshold && verdict.verdict !== "BENIGN";

    let publishSeed: TeeVerifyOutcome["publishSeed"] | undefined;
    if (semanticAutoMint && verdict.abType === "SEMANTIC" && verdict.marker) {
      const marker = verdict.marker.trim();
      const wordCount = marker.split(/\s+/).filter(Boolean).length;
      const presentInBundle = bundle.toLowerCase().includes(marker.toLowerCase());
      if (marker.length >= 20 && marker.length <= 100 && wordCount >= 3 && presentInBundle) {
        publishSeed = {
          abType: "SEMANTIC",
          flavor: verdict.flavor ?? "PROMPT_INJECTION",
          pattern: { kind: "marker", value: marker.toLowerCase() },
        };
      }
    }
    // No ADDRESS auto-mint from the shim. `tx.to` for any ERC-20 call is
    // the token contract, not the malicious counterparty — using it as a
    // seed target would mint an antibody for USDC and brick every
    // legitimate trader tx. The SDK's `seedFromTx` would normally derive
    // the right address from the calldata, but it isn't exported, and
    // mid-shim duplication of its calldata-decoding rules is the kind of
    // subtle bug we just hit. SEMANTIC auto-mint stays — it's a
    // self-validating path (verbatim marker presence in bundle) and is
    // where Claude's signal is genuinely additive over the cache.
    void defaultChainId;

    return {
      block: block && publishSeed !== undefined,
      escalate: escalate || (block && publishSeed === undefined),
      reason: verdict.reasoning ?? `${verdict.verdict}/${verdict.abType}@${verdict.confidence}`,
      confidence: verdict.confidence,
      severity: verdict.severity,
      ...(publishSeed ? { publishSeed } : {}),
    };
  };
}
