import { worktreeLabel } from "./git/worktree.js";
import type { WorktreeInfo } from "./git/worktree.js";
import { resolveProjectNames, shortHash } from "./utils/sanitize.js";
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
 * Labels unique across the current set. A branch is checked out in at most one
 * worktree, but two detached worktrees can sit at the same commit and then
 * share the short-sha label; duplicate labels are suffixed with a short hash
 * of the worktree path (stable for the worktree's lifetime) so two stacks
 * never collapse into one project name or port slot. Only labels that
 * actually collide get the suffix, so the common detached case keeps the
 * plain sha.
 */
function uniqueLabels(worktrees: WorktreeInfo[]): string[] {
  const base = worktrees.map(worktreeLabel);
  const counts = new Map<string, number>();
  for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
  return base.map((label, i) =>
    counts.get(label)! > 1
      ? `${label}-${shortHash(worktrees[i].path, 4)}`
      : label,
  );
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
  const labels = uniqueLabels(worktrees);
  const projects = resolveProjectNames(repoName, labels);
  const slots = assignPortSlots(labels);

  return worktrees.map((wt, i) => ({
    wt,
    label: labels[i],
    project: projects.get(labels[i])!,
    slot: slots.get(labels[i])!,
  }));
}
