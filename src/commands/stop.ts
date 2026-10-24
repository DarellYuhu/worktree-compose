import { stopWorktrees } from "../core/stop.js";
import { consoleReporter } from "../utils/log.js";

export async function stopCommand(worktrees: string[]): Promise<void> {
  const result = await stopWorktrees({ worktrees }, consoleReporter, { live: true });
  if (result.failures > 0) process.exitCode = 1;
}
