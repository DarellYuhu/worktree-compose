import { worktreeLabel } from "./git/worktree.js";
import type { WorktreeInfo } from "./git/worktree.js";
import { resolveProjectNames } from "./utils/sanitize.js";
import { assignPortSlots } from "./ports/allocate.js";

export interface WorktreePlan {
  wt: WorktreeInfo;
  /** Branch name, or the short HEAD sha for detached worktrees. */
  label: string;
  /** Compose project name, collision-resolved against the full label set. */
  project: string;
  /** Stable hash-based port slot, independent of the worktree list order. */
  slot: number;
}

/**
 * Everything identity-related for the current set of worktrees: compose
 * project names and port slots, both derived from stable labels instead of
 * list indices. Plans align positionally with the input worktrees, so the
 * CLI's positional index (plans[i] for worktrees[i], 1-based for users) still
 * targets the same rows.
 */
export function buildWorktreePlans(
  repoName: string,
  worktrees: WorktreeInfo[],
): WorktreePlan[] {
  const labels = worktrees.map(worktreeLabel);
  const projects = resolveProjectNames(repoName, labels);
  const slots = assignPortSlots(labels);

  return worktrees.map((wt, i) => ({
    wt,
    label: labels[i],
    project: projects.get(labels[i])!,
    slot: slots.get(labels[i])!,
  }));
}
