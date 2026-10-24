import { exec, execSafe } from "../utils/exec.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string | null;
  isMain: boolean;
}

export function getWorktrees(repoRoot: string): WorktreeInfo[] {
  const output = exec(`git -C "${repoRoot}" worktree list --porcelain`);
  const blocks = output.split("\n\n").filter(Boolean);

  const worktrees: WorktreeInfo[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    let wtPath = "";
    let branch = "detached";
    let head: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      }
      if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace("refs/heads/", "");
      }
      if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      }
    }

    if (wtPath) {
      worktrees.push({
        path: wtPath,
        branch,
        head,
        isMain: worktrees.length === 0,
      });
    }
  }

  return worktrees;
}

/**
 * Stable naming label for a worktree: the branch, or the short HEAD sha when
 * detached — detached worktrees have no branch, and two of them must never
 * share a label (the old sentinel did exactly that).
 */
export function worktreeLabel(wt: WorktreeInfo): string {
  if (wt.branch !== "detached") return wt.branch;
  return wt.head ? wt.head.slice(0, 7) : "detached";
}

export function getNonMainWorktrees(repoRoot: string): WorktreeInfo[] {
  return getWorktrees(repoRoot).filter((wt) => !wt.isMain);
}

export function getWorktreeByIndex(
  repoRoot: string,
  index: number,
): WorktreeInfo | null {
  const nonMain = getNonMainWorktrees(repoRoot);
  return nonMain[index - 1] ?? null;
}

export function getWorktreeBranch(wtPath: string): string {
  return (
    execSafe(`git -C "${wtPath}" rev-parse --abbrev-ref HEAD`) ?? "detached"
  );
}

export function getWorktreeHead(wtPath: string): string {
  return exec(`git -C "${wtPath}" rev-parse HEAD`);
}
