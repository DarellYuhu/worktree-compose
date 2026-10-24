import { promoteWorktree } from "../core/promote.js";
import { consoleReporter } from "../utils/log.js";

export async function promoteCommand(worktree: string, options: { force?: boolean } = {}): Promise<void> {
  await promoteWorktree({ worktree, force: options.force }, consoleReporter, { live: true });
}
