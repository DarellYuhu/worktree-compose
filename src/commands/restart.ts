import { restartWorktrees } from "../core/restart.js";
import type { StartOptions } from "../core/start.js";
import { consoleReporter, print } from "../utils/log.js";
import { listCommand } from "./list.js";

export async function restartCommand(
  worktrees: string[],
  options: Omit<StartOptions, "worktrees"> = {},
): Promise<void> {
  // Env options and selectors are validated before anything is stopped, so
  // an invalid --env name or unknown --workspace never leaves stacks down.
  const result = await restartWorktrees(
    { ...options, worktrees },
    consoleReporter,
    { live: true },
  );
  if (result.started.length === 0) return;

  print("");
  await listCommand({ quiet: true });
}
