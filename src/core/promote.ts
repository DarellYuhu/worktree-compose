import fs from "node:fs";
import path from "node:path";
import { buildContext } from "../context.js";
import { selectWorktrees } from "../selectors.js";
import { escapesRoot } from "../utils/paths.js";
import {
  PROMOTE_EXCLUDES,
  assertPromotable,
  findConflicts,
  getChangedFiles,
  getLocalDirtyFiles,
  getMergeBase,
  getTargetChangedFiles,
  promoteFiles,
  resolveCommit,
} from "../git/promote.js";
import { getWorktreeBranch } from "../git/worktree.js";
import { throwIfAborted } from "./compose.js";
import type { WorktreeSelector } from "../selectors.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

export interface PromoteOptions {
  worktree: WorktreeSelector;
  /**
   * Promote even files the target branch also changed (committed) since the
   * worktree branched — overwriting, i.e. reverting, those commits. Meant for
   * promote → commit → keep iterating → promote again.
   */
  force?: boolean;
}

export interface PromoteResult {
  worktree: { index: number; branch: string; path: string };
  /** Checkout that received the files (the one wtc ran from). */
  target: string;
  targetBranch: string;
  files: string[];
  /** Paths that could not be copied (directories such as submodules). */
  skipped: string[];
}

/**
 * True when promoting `a` over `b` would change nothing: both missing (both
 * sides deleted it), both symlinks with the same target, or both regular
 * files with identical bytes.
 */
function sameContent(a: string, b: string): boolean {
  try {
    const sa = fs.lstatSync(a, { throwIfNoEntry: false });
    const sb = fs.lstatSync(b, { throwIfNoEntry: false });
    if (!sa || !sb) return !sa && !sb;
    if (sa.isSymbolicLink() && sb.isSymbolicLink()) return fs.readlinkSync(a) === fs.readlinkSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** Files both the target branch (committed) and the worktree changed since they diverged. */
export class PromoteDivergedError extends Error {
  files: string[];

  constructor(files: string[], target: string, mergeRef: string, wtBranch: string, wtPath: string) {
    super(
      `Abort: ${files.length} file(s) also changed on ${target} since ${wtBranch} branched; promoting would revert those commits` +
        ` — merge ${target} into the worktree first (git -C ${wtPath} merge ${mergeRef}), then re-run promote` +
        ` (or pass --force / MCP force to overwrite them anyway):\n` +
        files.map((f) => `  ${f}`).join("\n"),
    );
    this.name = "PromoteDivergedError";
    this.files = files;
  }
}

export class PromoteConflictError extends Error {
  conflicts: string[];

  constructor(conflicts: string[]) {
    super(
      `Abort: ${conflicts.length} file(s) have uncommitted or untracked changes in the target and would be overwritten:\n` +
        conflicts.map((f) => `  ${f}`).join("\n") +
        "\nCommit or stash your local changes first, then re-run promote.",
    );
    this.name = "PromoteConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Copy a worktree's changes (committed, staged, unstaged, untracked) into the
 * checkout wtc runs from, as uncommitted changes. Compose and env files are
 * excluded: wtc rewrites them per worktree.
 */
export async function promoteWorktree(
  options: PromoteOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<PromoteResult> {
  const ctx = buildContext({}, { cwd: io.cwd, allowMissingCompose: true });
  for (const w of ctx.warnings) reporter.warn(w);

  const [wt] = selectWorktrees(ctx.worktrees, [options.worktree], ctx.cwd);
  const target = ctx.repo.currentRoot;
  if (path.resolve(wt.path) === path.resolve(target)) {
    throw new Error(
      `Worktree ${wt.index} (${wt.branch}) is the current checkout. Run promote from the checkout that should receive the changes (usually the main worktree).`,
    );
  }

  const targetBranch = getWorktreeBranch(target);
  const displayTarget = targetBranch === "HEAD" ? "detached HEAD" : targetBranch;
  reporter.info(`Promoting worktree ${wt.index} (${wt.branch}) into ${displayTarget}`);

  const excludes = new Set(PROMOTE_EXCLUDES);
  for (const src of ctx.composeFile.sourceFiles) {
    const rel = path.relative(ctx.repoRoot, src);
    if (rel && !escapesRoot(rel)) excludes.add(rel.split(path.sep).join("/"));
  }

  const mergeBase = getMergeBase(target, wt.path);
  const files = getChangedFiles(target, wt.path, excludes, mergeBase);
  const result: PromoteResult = {
    worktree: { index: wt.index, branch: wt.branch, path: wt.path },
    target,
    targetBranch,
    files,
    skipped: [],
  };

  if (files.length === 0) {
    reporter.info("No changes to promote.");
    return result;
  }

  // Containment first (all-or-nothing, before anything is read for the
  // checks below): no path may pass through a symlink on either side.
  assertPromotable(target, wt.path, files);

  // A dirty target file that already matches the worktree's copy (e.g. from
  // an earlier promote) loses nothing when overwritten, so it isn't a conflict.
  const conflicts = findConflicts(files, getLocalDirtyFiles(target)).filter(
    (f) => !sameContent(path.join(wt.path, f), path.join(target, f)),
  );
  if (conflicts.length > 0) throw new PromoteConflictError(conflicts);

  // Whole-file copies would silently revert what the target committed since
  // the worktree branched — unless the target already has the same content.
  if (!options.force) {
    const promoted = new Set(files);
    const diverged = getTargetChangedFiles(target, mergeBase).filter(
      (f) => promoted.has(f) && !sameContent(path.join(wt.path, f), path.join(target, f)),
    );
    if (diverged.length > 0) {
      const mergeRef = targetBranch === "HEAD" ? resolveCommit(target, "HEAD").slice(0, 12) : targetBranch;
      const wtName = wt.detached ? `worktree ${wt.index}` : wt.branch;
      throw new PromoteDivergedError(diverged, displayTarget, mergeRef, wtName, wt.path);
    }
  }

  // Last point to back out: a request cancelled meanwhile writes nothing.
  throwIfAborted(io);
  result.skipped = promoteFiles(target, wt.path, files);
  const copied = files.filter((f) => !result.skipped.includes(f));
  reporter.success(
    `Promoted ${copied.length} file(s). Changes are uncommitted in ${displayTarget}.`,
  );
  for (const f of copied) reporter.info(`  ${f}`);
  for (const f of result.skipped) reporter.warn(`Skipped ${f} (not a regular file)`);
  return result;
}
