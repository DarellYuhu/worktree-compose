import fs from "node:fs";
import path from "node:path";
import { samePath } from "./git/worktree.js";
import { isWithin } from "./utils/paths.js";
import type { ResolvedWorktree } from "./state/registry.js";

/** A worktree selector: index, branch name, directory basename, path, or ".". */
export type WorktreeSelector = number | string;

function available(worktrees: ResolvedWorktree[]): string {
  if (worktrees.length === 0) return "none (create one with: git worktree add ../my-branch my-branch)";
  return [...worktrees]
    .sort((a, b) => a.index - b.index)
    .map((w) => `${w.index}:${w.branch}`)
    .join(", ");
}

function describe(w: ResolvedWorktree): string {
  return `${w.index}:${w.branch} (${w.path})`;
}

/** A path token that selects `wtPath` from `cwd` (relative, `./`-prefixed when below cwd). */
function pathHint(wtPath: string, cwd: string): string {
  const rel = path.relative(realOrResolved(cwd), wtPath);
  if (rel === "") return ".";
  if (path.isAbsolute(rel)) return rel;
  return rel.startsWith("..") ? rel : `./${rel}`;
}

/** `p` with symlinks resolved, when it exists (git records worktree paths resolved). */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** The worktree whose directory contains `cwd` (deepest match wins). */
function containing(worktrees: ResolvedWorktree[], cwd: string): ResolvedWorktree | null {
  const dirs = [path.resolve(cwd), realOrResolved(cwd)];
  const matches = worktrees.filter((w) => dirs.some((d) => isWithin(w.path, d)));
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0] ?? null;
}

function matchToken(
  worktrees: ResolvedWorktree[],
  token: WorktreeSelector,
  cwd: string,
): ResolvedWorktree {
  const raw = String(token).trim();

  if (raw === ".") {
    const wt = containing(worktrees, cwd);
    if (!wt) {
      throw new Error(
        `"." does not refer to a linked worktree (cwd: ${cwd}). Available worktrees: ${available(worktrees)}.`,
      );
    }
    return wt;
  }

  // A JSON number (MCP) is always an index — callers can force one.
  if (typeof token === "number") {
    const byIndex = worktrees.find((w) => w.index === token);
    if (byIndex) return byIndex;
    throw new Error(
      `Worktree "${raw}" not found. Available worktrees: ${available(worktrees)}.`,
    );
  }

  const abs = path.resolve(cwd, raw);
  const matches = new Set<ResolvedWorktree>();
  for (const w of worktrees) {
    // Paths compare through symlinks (macOS /tmp, a symlinked ~/code…):
    // git records the resolved path.
    if (w.branch === raw || path.basename(w.path) === raw || samePath(w.path, abs)) {
      matches.add(w);
    }
  }

  // A numeric string is an index unless it also names a *different*
  // worktree (a branch or directory called "1"): then it is ambiguous
  // rather than silently shadowing that worktree. Passing the index again
  // cannot resolve that clash, so point at names and paths instead.
  if (/^\d+$/.test(raw)) {
    const byIndex = worktrees.find((w) => w.index === Number(raw));
    if (byIndex) {
      const others = [...matches].filter((w) => w !== byIndex);
      if (others.length === 0) return byIndex;
      throw new Error(
        `Worktree "${raw}" is ambiguous: index ${raw} is ${describe(byIndex)}, but "${raw}" also names ${others
          .map(describe)
          .join(", ")}. Pass the branch, the directory name, or a path such as ${pathHint(others[0].path, cwd)} of the worktree you mean.`,
      );
    }
  }

  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) {
    throw new Error(
      `Worktree "${raw}" is ambiguous: matches ${[...matches]
        .map(describe)
        .join(", ")}. Use the index instead.`,
    );
  }
  throw new Error(
    `Worktree "${raw}" not found. Available worktrees: ${available(worktrees)}.`,
  );
}

/**
 * Resolve selectors to worktrees, preserving request order and dropping
 * duplicates. Each token may be a persistent index (`2`), a branch name
 * (`feat-a`), a directory basename (`myapp-feat-a`), a path, or `.` (the
 * worktree containing `cwd`). An empty selection means every live worktree.
 */
export function selectWorktrees(
  worktrees: ResolvedWorktree[],
  selectors: WorktreeSelector[] | undefined,
  cwd: string = process.cwd(),
): ResolvedWorktree[] {
  if (!selectors || selectors.length === 0) return worktrees;
  const out: ResolvedWorktree[] = [];
  for (const token of selectors) {
    const wt = matchToken(worktrees, token, cwd);
    if (!out.includes(wt)) out.push(wt);
  }
  return out;
}
