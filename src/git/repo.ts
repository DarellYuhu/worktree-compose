import fs from "node:fs";
import path from "node:path";
import { run, runSafe } from "../utils/exec.js";
import { peekState } from "../state/registry.js";
import { getWorktrees, parseWorktreePorcelain, samePath } from "./worktree.js";
import type { WorktreeInfo } from "./worktree.js";

export interface RepoInfo {
  /** Main worktree path — source of truth for compose/config/env files. */
  mainRoot: string;
  /** Toplevel of the cwd's checkout (equals mainRoot unless run from a linked worktree). */
  currentRoot: string;
  /** Absolute git common dir, shared by every worktree (holds wtc's registry). */
  commonDir: string;
  /**
   * Stable repository name (compose project prefix): basename(mainRoot), or
   * for a bare repository the repo's own name (`proj.git`, `proj/.bare` →
   * `proj`) — the same no matter which worktree wtc runs from.
   */
  repoName: string;
  /** The common dir is a bare repository and every checkout is a linked worktree. */
  bare: boolean;
  /**
   * No main checkout could be identified (a bare repository with no
   * worktree on its default branch, or a `--separate-git-dir` repository
   * seen from a linked worktree, with none recorded): `mainRoot` is only
   * the current checkout. No linked worktree is then treated as the main
   * one, the registry is never written, and commands that would sync
   * files into, start, or remove other checkouts refuse to run (see
   * `fallbackReason`).
   */
  mainRootIsFallback: boolean;
  /** Why the main checkout is unknown and how to fix it (set with `mainRootIsFallback`). */
  fallbackReason?: string;
  /**
   * The main checkout was found in a layout git cannot answer for from
   * every worktree (bare, `--separate-git-dir`): reconcile records it in the
   * registry so later runs find it even when the layout no longer tells
   * (default branch checked out elsewhere, mid-rebase, run from a linked
   * worktree).
   */
  recordMain: boolean;
  /** Notes about how the layout was resolved, for the caller to report. */
  warnings: string[];
}

/** Absolute `rev-parse` path output (git < 2.31 has no --path-format: resolve against cwd). */
function revParsePath(cwd: string, flag: string): string {
  const abs = runSafe("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag]);
  if (abs && path.isAbsolute(abs)) return path.resolve(abs);
  return path.resolve(cwd, run("git", ["-C", cwd, "rev-parse", flag]));
}

/**
 * Name of a bare repository: basename(commonDir) minus a trailing `.git`
 * (`proj.git` → `proj`); when that leaves `.bare`, `.git` or nothing (the
 * `proj/.bare` + `.git`-file layout), the parent's name (`proj`).
 */
export function bareRepoName(commonDir: string): string {
  const name = path.basename(commonDir).replace(/\.git$/, "");
  if (name === "" || name === ".bare" || name === ".git") {
    return path.basename(path.dirname(commonDir));
  }
  return name;
}

/**
 * The first `git worktree list` entry is not a checkout: submodules and
 * `--separate-git-dir` repos list their git dir there (it resolves to the
 * common dir, or has no `.git` entry of its own).
 */
function isNotCheckout(dir: string, commonDir: string): boolean {
  return samePath(dir, commonDir) || !fs.existsSync(path.join(dir, ".git"));
}

/**
 * The main checkout recorded in the registry (see RepoInfo.recordMain), if
 * it still checks out: `valid` decides. Never throws.
 */
function recordedMain(commonDir: string, valid: (dir: string) => boolean): string | null {
  let recorded: string | undefined;
  try {
    recorded = peekState(commonDir)?.mainCheckout;
  } catch {
    return null; // A newer wtc's registry: not ours to interpret.
  }
  if (!recorded || !fs.existsSync(path.join(recorded, ".git"))) return null;
  try {
    return valid(recorded) ? path.resolve(recorded) : null;
  } catch {
    return null;
  }
}

/**
 * Locate the repository from `cwd`. Everything keys off the MAIN worktree:
 * agents and the MCP server usually run inside a linked worktree, and using
 * that worktree's toplevel would change the repo name (and therefore every
 * compose project name) and sync infra files from the wrong checkout.
 *
 * Layouts beyond a plain clone:
 * - bare repo + worktrees: the main checkout is the worktree on the bare
 *   repo's default branch (HEAD), else the one recorded in the registry;
 *   the name comes from the bare repo.
 * - submodules and `--separate-git-dir`: `git worktree list` shows the git
 *   dir, not the checkout; the checkout is `core.worktree` (submodules) or,
 *   when running from it, the current toplevel. From a linked worktree of a
 *   `--separate-git-dir` repo git records no main checkout at all: the one
 *   recorded in the registry is used.
 * When none is found, the current checkout stands in, flagged
 * `mainRootIsFallback` (see there).
 */
export function getRepoInfo(cwd: string = process.cwd()): RepoInfo {
  const currentRoot = runSafe("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!currentRoot) {
    throw new Error("Not inside a git repository (run wtc from your project).");
  }
  const current = path.resolve(currentRoot);
  const commonDir = revParsePath(cwd, "--git-common-dir");

  const worktrees = parseWorktreePorcelain(
    run("git", ["-C", cwd, "worktree", "list", "--porcelain"]),
  );
  const first = worktrees[0];
  const warnings: string[] = [];
  const base = { currentRoot: current, commonDir, warnings };

  if (!first || first.bare) {
    const head = runSafe("git", ["--git-dir", commonDir, "symbolic-ref", "-q", "HEAD"]);
    const branch = head ? head.replace(/^refs\/heads\//, "") : null;
    const live = (w: WorktreeInfo) => !w.bare && !w.prunable && fs.existsSync(path.join(w.path, ".git"));
    const primary = branch ? worktrees.find((w) => live(w) && w.branch === branch) : undefined;
    const repoName = bareRepoName(commonDir);
    if (primary) {
      return { ...base, mainRoot: path.resolve(primary.path), repoName, bare: true, mainRootIsFallback: false, recordMain: true };
    }
    // The main worktree is mid-rebase/bisect, or on another branch for now.
    const recorded = recordedMain(commonDir, (dir) => worktrees.some((w) => live(w) && samePath(w.path, dir)));
    if (recorded) {
      return { ...base, mainRoot: recorded, repoName, bare: true, mainRootIsFallback: false, recordMain: false };
    }
    const fallbackReason =
      (branch
        ? `no worktree of this bare repository has its default branch (${branch}) checked out ` +
          `(is your main worktree mid-rebase or mid-bisect?), so wtc cannot tell which checkout is the main one. ` +
          `Check ${branch} out in your main worktree (or add one: git worktree add <dir> ${branch}), then retry.`
        : `this bare repository's HEAD names no branch, so wtc cannot tell which checkout is the main one. ` +
          `Point HEAD at your default branch (git --git-dir ${commonDir} symbolic-ref HEAD refs/heads/<branch>) ` +
          `and check that branch out in your main worktree, then retry.`);
    warnings.push(
      `Cannot locate the main checkout: ${fallbackReason} Until then compose, config and env files are read from ` +
        `the current checkout (${current}), and start, restart and clean refuse to run.`,
    );
    return {
      ...base,
      mainRoot: current,
      repoName,
      bare: true,
      mainRootIsFallback: true,
      fallbackReason,
      recordMain: false,
    };
  }

  let mainRoot = path.resolve(first.path);
  let recordMain = false;
  if (isNotCheckout(first.path, commonDir)) {
    const coreWorktree = runSafe("git", ["--git-dir", commonDir, "config", "core.worktree"]);
    if (coreWorktree) {
      mainRoot = path.resolve(commonDir, coreWorktree);
    } else if (samePath(revParsePath(cwd, "--git-dir"), commonDir)) {
      // Running from the main checkout itself: remember it for the others.
      mainRoot = current;
      recordMain = true;
    } else {
      const recorded = recordedMain(commonDir, (dir) => samePath(revParsePath(dir, "--git-dir"), commonDir));
      if (recorded) {
        mainRoot = recorded;
      } else {
        const fallbackReason =
          `git does not record where the main checkout of a --separate-git-dir repository is, ` +
          `and wtc has not seen it yet. Run this command from the main checkout ` +
          `(after one 'wtc start' there, wtc finds it from linked worktrees too).`;
        warnings.push(
          `Cannot locate the main checkout: ${fallbackReason} Until then compose, config and env files are read from ` +
            `the current checkout (${current}), and start, restart and clean refuse to run.`,
        );
        return {
          ...base,
          mainRoot: current,
          repoName: path.basename(current),
          bare: false,
          mainRootIsFallback: true,
          fallbackReason,
          recordMain: false,
        };
      }
    }
  }

  return { ...base, mainRoot, repoName: path.basename(mainRoot), bare: false, mainRootIsFallback: false, recordMain };
}

/**
 * The repository's worktrees (see getWorktrees), with the main checkout
 * marked only when it was actually found: a fallback main is just the
 * current checkout, and marking it would hide a live worktree.
 */
export function listRepoWorktrees(repo: RepoInfo): WorktreeInfo[] {
  return getWorktrees(repo.mainRoot, repo.mainRootIsFallback ? undefined : repo.mainRoot, repo.commonDir);
}

/** Throw when the main checkout is unknown (see RepoInfo.mainRootIsFallback). */
export function assertMainCheckout(repo: RepoInfo, action: string): void {
  if (repo.mainRootIsFallback) {
    throw new Error(
      `Refusing to ${action}: cannot locate the main checkout (the source of compose, config and env files) — ` +
        `${repo.fallbackReason} Without it wtc could sync files into, start, or remove the wrong checkout.`,
    );
  }
}
