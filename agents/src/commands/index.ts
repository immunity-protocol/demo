import type { Command, CommandResult } from "../db.js";
import type { AmbientContext } from "../context.js";
import { runAttack } from "./attack.js";
import { runCheckOnly } from "./check_only.js";
import { runExternalThreatAlert } from "./external_threat_alert.js";
import { runManipulate } from "./manipulate.js";
import { runSwap } from "./swap.js";

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
    case "external_threat_alert":
      return runExternalThreatAlert(cmd, ctx);
    case "swap":
      return runSwap(cmd, ctx);
    case "check_only":
      return runCheckOnly(cmd, ctx);
    default:
      ctx.log.warn("unknown command_type", { command_type: cmd.commandType, command_id: cmd.id });
      return {
        status: "failed",
        detail: { error: `unknown command_type: ${cmd.commandType}` },
      };
  }
}
