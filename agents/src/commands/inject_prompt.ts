import type { CheckContext } from "@immunity-protocol/sdk";
import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";

/**
 * Card 09 / inject_prompt: a judge picks a specific online trader and
 * pastes freeform text. The trader runs `immunity.check(null, ctx)` with
 * the payload carried as a single user-role conversation turn. Mirrors
 * the indirect-injection threat model — the agent receiving content from
 * an untrusted upstream channel.
 *
 * Payload shape:
 *   { "payload": "<freeform text up to 2000 chars>", "source": "playground" }
 *
 * Result detail returned to the playground modal:
 *   { decision, source, reason, antibody_imm_id?, antibody_imm_seq?,
 *     check_id?, novel, payload_chars, payload_excerpt }
 *
 * The payload is echoed back as a 240-char excerpt for the modal so the
 * judge can verify what they sent without re-typing it from the form.
 */
export async function runInjectPrompt(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  const payload = String((cmd.payload as { payload?: unknown }).payload ?? "");
  if (payload === "") {
    return { status: "failed", detail: { error: "payload is required" } };
  }

  const context: CheckContext = {
    conversation: [{ role: "user", content: payload }],
  };

  let result;
  try {
    result = await ctx.immunity.check(null, context);
  } catch (err) {
    return { status: "failed", detail: { error: String(err) } };
  }

  ctx.log.info("inject_prompt evaluated", {
    decision: result.decision,
    source: result.source,
    novel: result.novel,
    antibody: result.antibodies[0]?.immId,
  });

  return {
    status: "completed",
    detail: {
      decision: result.decision,
      allowed: result.allowed,
      source: result.source,
      reason: result.reason,
      novel: result.novel,
      antibody_imm_id: result.antibodies[0]?.immId ?? null,
      antibody_imm_seq: result.antibodies[0]?.immSeq ?? null,
      check_id: result.checkId,
      payload_chars: payload.length,
      payload_excerpt: payload.length > 240 ? payload.slice(0, 240) + "…" : payload,
    },
  };
}
