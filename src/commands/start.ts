import { startWorktrees } from "../core/start.js";
import type { StartOptions } from "../core/start.js";
import { consoleReporter, print } from "../utils/log.js";
import { listCommand } from "./list.js";

export async function startCommand(
  worktrees: string[],
  options: Omit<StartOptions, "worktrees"> = {},
): Promise<void> {
  const result = await startWorktrees(
    { ...options, worktrees },
    consoleReporter,
    { live: true },
  );
  if (result.started.length === 0) return;

  print("");
  await listCommand({ quiet: true });
}
