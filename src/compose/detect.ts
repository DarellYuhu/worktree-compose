import fs from "node:fs";
import path from "node:path";
import { exec, execSafe } from "../utils/exec.js";

const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export function getRepoRoot(cwd?: string): string {
  return exec("git rev-parse --show-toplevel", {
    cwd: cwd ?? process.cwd(),
  });
}

/**
 * Root of the main worktree, resolvable from any working tree of the repo.
 * Compose project identity must not depend on where wtc runs from: a linked
 * worktree reports itself as the toplevel, which would rename every project
 * and make status diverge between invocations. Falls back to the current
 * toplevel outside git worktrees.
 */
export function getMainWorktreeRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const porcelain = execSafe("git worktree list --porcelain", { cwd: dir });
  const first = porcelain
    ?.split("\n")
    .find((line) => line.startsWith("worktree "));
  if (first) return first.slice("worktree ".length);
  return getRepoRoot(dir);
}

export function getRepoName(repoRoot: string): string {
  return path.basename(repoRoot);
}

export function detectComposeFile(repoRoot: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    const full = path.join(repoRoot, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
