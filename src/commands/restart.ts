import { stopCommand } from "./stop.js";
import { startCommand } from "./start.js";
import { preflightEnvOptions } from "../context.js";
import type { EnvCliOptions } from "../context.js";

export function restartCommand(
  indices: number[],
  cli: EnvCliOptions = {},
): void {
  // Starting again is manual recovery: validate the env options while every
  // worktree is still running, so an invalid --env name or unknown
  // --workspace selector never stops anything.
  preflightEnvOptions(cli);

  stopCommand(indices);
  startCommand(indices, cli);
}
