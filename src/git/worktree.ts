import fs from "node:fs";
import path from "node:path";
import { run, runSafe } from "../utils/exec.js";

export interface WorktreeInfo {
  path: string;
  /** Branch name without `refs/heads/`, or `"detached"`. */
  branch: string;
  /**
   * The main checkout: the first entry of `git worktree list` (in bare and
   * `--separate-git-dir` layouts that entry is the repository itself), or
   * the linked worktree getWorktrees marked main (see `markedMain`).
   */
  isMain: boolean;
  /**
   * A linked worktree marked main by getWorktrees (bare layouts: the
   * worktree on the default branch). Git still lists it as a linked
   * worktree, so a record wtc made for it before it became the main
   * checkout is still its record — never an orphan.
   */
  markedMain?: boolean;
  /** Commit checked out (absent for a bare entry or an unborn branch). */
  head?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Git reports the worktree directory as missing on disk. */
  prunable: boolean;
  /**
   * Locked worktree whose checkout is missing on disk (an unmounted drive):
   * git never marks a locked worktree prunable, but it cannot be started.
   * It still exists for identity purposes: its record, index and stack are
   * kept, never pruned.
   */
  missing?: boolean;
  /**
   * The worktree's git admin dir (`<common dir>/worktrees/<name>`), see
   * `worktreeAdminDir`. It survives `git worktree move` and is deleted by
   * `git worktree remove`/`prune`, so wtc keeps its stable id there.
   */
  adminDir?: string;
}

/**
 * Parse `git worktree list --porcelain`. Blocks are separated by blank lines;
 * flag lines (`bare`, `detached`, `locked [reason]`, `prunable [reason]`) may
 * carry a trailing reason.
 */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  const flush = () => {
    if (current) worktrees.push(current);
    current = null;
  };

  for (const line of output.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: path.resolve(line.slice("worktree ".length)),
        branch: "detached",
        isMain: worktrees.length === 0,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    const wt: WorktreeInfo = current;
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    switch (key) {
      case "HEAD":
        wt.head = value;
        break;
      case "branch":
        wt.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "bare":
        wt.bare = true;
        break;
      case "detached":
        wt.detached = true;
        break;
      case "locked":
        wt.locked = true;
        break;
      case "prunable":
        wt.prunable = true;
        break;
    }
  }
  flush();

  return worktrees;
}

/** True when two paths name the same directory (resolving symlinks when they exist). */
export function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * A linked worktree's git admin dir (`<common dir>/worktrees/<name>`):
 * read from its `.git` file (`gitdir: …`, relative to the worktree) with no
 * subprocess, else asked of git. `undefined` when neither answers.
 */
export function worktreeAdminDir(wtPath: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(wtPath, ".git"), "utf-8"));
    if (match) return path.resolve(wtPath, match[1]);
  } catch {
    // Not a readable file: ask git below.
  }
  const dir = runSafe("git", ["-C", wtPath, "rev-parse", "--absolute-git-dir"]);
  return dir ? path.resolve(dir) : undefined;
}

/**
 * The admin dir (`<common dir>/worktrees/<name>`) whose `gitdir` file points
 * at `<wtPath>/.git` — found without the checkout, which may be missing.
 */
export function adminDirByPath(commonDir: string, wtPath: string): string | undefined {
  const dir = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const target = path.join(path.resolve(wtPath), ".git");
  for (const name of names) {
    const admin = path.join(dir, name);
    let gitdir: string;
    try {
      gitdir = fs.readFileSync(path.join(admin, "gitdir"), "utf-8").trim();
    } catch {
      continue;
    }
    // Absolute, or relative to the admin dir (worktree.useRelativePaths).
    if (gitdir && path.resolve(admin, gitdir) === target) return admin;
  }
  return undefined;
}

/**
 * Check a linked worktree's checkout on disk: find its admin dir, and flag
 * it when the checkout is gone. Git only reports `prunable` since 2.31, and
 * never for locked worktrees — without this a deleted worktree counted as
 * live and `start` recreated its directory (holding nothing but
 * compose.yaml and .env) to run compose in. A locked one whose checkout is
 * gone (an unmounted drive) is `missing`, not removed: git keeps it, and so
 * does wtc. Its lock is also read from the admin dir, for a git whose
 * porcelain does not report it.
 */
function inspectCheckout(wt: WorktreeInfo, commonDir: () => string | undefined): WorktreeInfo {
  if (wt.isMain || wt.bare || wt.prunable) return wt;
  if (!fs.lstatSync(path.join(wt.path, ".git"), { throwIfNoEntry: false })) {
    const common = commonDir();
    const adminDir = common ? adminDirByPath(common, wt.path) : undefined;
    const locked = wt.locked || (adminDir !== undefined && fs.existsSync(path.join(adminDir, "locked")));
    if (!locked) return { ...wt, prunable: true };
    return adminDir ? { ...wt, locked: true, missing: true, adminDir } : { ...wt, locked: true, missing: true };
  }
  const adminDir = worktreeAdminDir(wt.path);
  return adminDir ? { ...wt, adminDir } : wt;
}

/**
 * Every worktree git knows about, main first, with on-disk checks applied.
 * `mainRoot` (from getRepoInfo, when it found the main checkout) is marked
 * main too: in a bare-repo layout the first entry is the bare repo and the
 * main checkout is one of the linked worktrees — it must never be started,
 * synced onto, or removed. Pass no `mainRoot` when the main checkout is
 * unknown: then no linked worktree is mistaken for it.
 */
export function getWorktrees(repoRoot: string, mainRoot?: string, commonDir?: string): WorktreeInfo[] {
  let common = commonDir;
  const commonDirOf = (): string | undefined => {
    if (common === undefined) {
      // git < 2.31 has no --path-format: resolve the relative answer instead.
      const abs = runSafe("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const out = abs && path.isAbsolute(abs) ? abs : runSafe("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"]);
      common = out ? path.resolve(repoRoot, out) : "";
    }
    return common || undefined;
  };
  return parseWorktreePorcelain(
    run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]),
  ).map((wt, i) => {
    // The first entry is the main checkout, the bare repo, or a git dir.
    if (i === 0 || wt.bare) return wt;
    const inspected = inspectCheckout(wt, commonDirOf);
    return mainRoot !== undefined && samePath(inspected.path, mainRoot)
      ? { ...inspected, isMain: true, markedMain: true }
      : inspected;
  });
}

/** Linked worktrees wtc can manage: not the main one, not bare, still on disk. */
export function isCandidate(wt: WorktreeInfo): boolean {
  return !wt.isMain && !wt.bare && !wt.prunable && !wt.missing;
}

export function getNonMainWorktrees(repoRoot: string): WorktreeInfo[] {
  return getWorktrees(repoRoot).filter(isCandidate);
}

export function getWorktreeBranch(wtPath: string): string {
  return (
    runSafe("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]) ??
    "detached"
  );
}
