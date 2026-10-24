import { clean } from "../core/clean.js";
import type { CleanOptions } from "../core/clean.js";
import { consoleReporter } from "../utils/log.js";

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  const result = await clean(options, consoleReporter, { live: true });
  // Kept (dirty, locked, current) worktrees are intended outcomes; only
  // real failures make the exit code non-zero.
  if (result.failures > 0) process.exitCode = 1;
}
