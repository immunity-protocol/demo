import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";
import { runAttack } from "./attack.js";
import { runManipulate } from "./manipulate.js";

/**
 * Dispatch a command to its handler. Each handler file plugs into the switch
 * below. Unknown command types fail loudly so the operator can see something
 * went wrong (rather than silently completing).
 */
export async function runCommand(cmd: Command, ctx: AmbientContext): Promise<CommandResult> {
  switch (cmd.commandType) {
    case "attack":
      return runAttack(cmd, ctx);
    case "manipulate":
      return runManipulate(cmd, ctx);
    default:
      ctx.log.warn("unknown command_type", { command_type: cmd.commandType, command_id: cmd.id });
      return {
        status: "failed",
        detail: { error: `unknown command_type: ${cmd.commandType}` },
      };
  }
}
