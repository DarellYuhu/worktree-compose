import { prune } from "../core/prune.js";
import type { PruneOptions } from "../core/prune.js";
import { consoleReporter } from "../utils/log.js";

export async function pruneCommand(options: PruneOptions = {}): Promise<void> {
  const result = await prune(options, consoleReporter, { live: true });
  if (result.failures > 0) process.exitCode = 1;
}
