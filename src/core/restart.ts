import { preflightEnvOptions } from "../context.js";
import { startWorktrees } from "./start.js";
import { stopWorktrees } from "./stop.js";
import type { StartOptions, StartResult } from "./start.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

/**
 * Stop then start (`compose stop`, then start's sync/inject + `up -d
 * --remove-orphans`): unchanged services are simply started again, changed
 * ones are recreated by compose — which carries their anonymous volumes
 * over, unlike the old `down` + `up`, which brought image-declared volumes
 * back empty — and containers of services removed from the compose file
 * go away, as `down` used to make them. Env options and selectors are
 * validated while every worktree is still running, so a typo never leaves
 * stacks stopped.
 */
export async function restartWorktrees(
  options: StartOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<StartResult> {
  preflightEnvOptions(options, io.cwd, { requireMainFor: "restart worktree stacks" });
  await stopWorktrees({ worktrees: options.worktrees, quiet: true }, reporter, io);
  return startWorktrees({ ...options, removeOrphans: true }, reporter, io);
}
