import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";

/**
 * Dispatch a command to its handler. Each handler file plugs into the switch
 * below. Unknown command types fail loudly so the operator can see something
 * went wrong (rather than silently completing).
 */
export async function runCommand(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  switch (cmd.commandType) {
    default:
      ctx.log.warn("unknown command_type", { command_type: cmd.commandType, command_id: cmd.id });
      return {
        status: "failed",
        detail: { error: `unknown command_type: ${cmd.commandType}` },
      };
  }
}
