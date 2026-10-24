import fs from "node:fs";
import path from "node:path";
import { run } from "../utils/exec.js";
import { parentPlacement, resolveInside, symlinkAncestor } from "../utils/paths.js";

/** Root compose filenames; wtc overwrites these in every worktree. */
export const PROMOTE_EXCLUDES = new Set([
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);

/** Committed env templates; wtc never writes these, so they stay promotable. */
const ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env.defaults",
]);

/**
 * Local env files are excluded from promote — wtc rewrites them with
 * per-worktree ports: `.env`, `.env.development`, `.env.local`, …
 */
export function isEnvFile(file: string): boolean {
  const base = path.posix.basename(file);
  if (ENV_TEMPLATES.has(base)) return false;
  return base === ".env" || base.startsWith(".env.");
}

/** Split NUL-terminated git output (`-z`) into paths. */
export function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** Like `run`, but keeps NUL separators and trailing whitespace in paths intact. */
function gitPaths(cwd: string, args: string[]): string[] {
  return splitNul(run("git", ["-C", cwd, ...args], { trim: false }));
}

/** Resolve a ref to a commit id, or throw a readable error. */
export function resolveCommit(cwd: string, ref: string): string {
  try {
    return run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new Error(`Cannot resolve ${ref} to a commit in ${cwd} (no commits yet?).`);
  }
}

/** Merge-base of the target checkout's HEAD and the worktree's HEAD. */
export function getMergeBase(targetRoot: string, wtPath: string): string {
  const targetHead = resolveCommit(targetRoot, "HEAD");
  const wtHead = resolveCommit(wtPath, "HEAD");
  return run("git", ["-C", targetRoot, "merge-base", targetHead, wtHead]);
}

/**
 * Files the target branch itself changed (committed) since `mergeBase`.
 * Promote copies whole files, so for a file both sides changed it would
 * silently revert the target's commits.
 */
export function getTargetChangedFiles(targetRoot: string, mergeBase: string): string[] {
  return gitPaths(targetRoot, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "HEAD", "--"]);
}

/**
 * Files a worktree changed relative to its merge-base with `targetRoot`'s
 * HEAD: committed + staged + unstaged changes in one `git diff <merge-base>`
 * (merge-base vs working tree), plus untracked files. `-z` keeps non-ASCII
 * names intact (otherwise `core.quotePath` turns `café.txt` into a quoted
 * escape that matches no file); `--no-renames` reports a rename as delete +
 * add so the old path is removed from the target too.
 */
export function getChangedFiles(
  targetRoot: string,
  wtPath: string,
  excludes: Set<string> = PROMOTE_EXCLUDES,
  mergeBase: string = getMergeBase(targetRoot, wtPath),
): string[] {
  const changed = gitPaths(wtPath, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "--"]);
  const untracked = gitPaths(wtPath, ["ls-files", "--others", "--exclude-standard", "-z"]);

  const unique = [...new Set([...changed, ...untracked])];
  return unique.filter((f) => !excludes.has(f) && !isEnvFile(f));
}

/**
 * Paths in the target checkout that promote must not overwrite: tracked
 * changes (staged or unstaged) AND untracked files — an untracked file in
 * main is just as much unsaved work.
 */
export function getLocalDirtyFiles(repoRoot: string): string[] {
  const tracked = gitPaths(repoRoot, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"]);
  const untracked = gitPaths(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...tracked, ...untracked])];
}

export function findConflicts(
  files: string[],
  dirtyFiles: string[],
): string[] {
  const dirtySet = new Set(dirtyFiles);
  return files.filter((f) => dirtySet.has(f));
}

/**
 * Throw when promoting `rel` would pass through a symlink on either side.
 * Target: a symlinked (or non-directory) ancestor would make the write or
 * delete land outside the checkout (`data -> /var/shared`), and the realpath
 * of the directory that will hold the file must stay inside the target.
 * Worktree: content is never read through a symlinked directory the branch
 * planted (`config -> ~/.ssh`).
 */
function assertContained(targetRoot: string, wtPath: string, rel: string): void {
  if (!resolveInside(wtPath, rel) || !resolveInside(targetRoot, rel)) {
    throw new Error(`Refusing to promote "${rel}": path escapes the repository.`);
  }
  const targetLink = symlinkAncestor(targetRoot, rel);
  if (targetLink) {
    throw new Error(
      `Refusing to promote "${rel}": ${targetLink} in the target is a symlink (or not a directory), so the file would land outside the checkout. Replace it with a real directory first.`,
    );
  }
  if (parentPlacement(targetRoot, rel) !== "inside") {
    throw new Error(`Refusing to promote "${rel}": its directory resolves outside the target checkout.`);
  }
  const wtLink = symlinkAncestor(wtPath, rel);
  if (wtLink) {
    throw new Error(
      `Refusing to promote "${rel}": ${wtLink} in the worktree is a symlink (or not a directory); promote never reads through one. Apply that change to the target by hand.`,
    );
  }
}

/**
 * Validate every path before anything is written (all-or-nothing): each must
 * stay inside both roots lexically *and* physically — see `assertContained`.
 */
export function assertPromotable(targetRoot: string, wtPath: string, files: string[]): void {
  for (const f of files) assertContained(targetRoot, wtPath, f);
}

/**
 * Copy (or delete) each changed file from the worktree into the target.
 * Every path is validated up front (`assertPromotable`) and re-checked
 * before each write — a symlink created earlier in the same run must not be
 * followed either. A symlink at the final component in the target is
 * replaced (unlinked) on write and removed (unlinked, not followed) on
 * delete. Deletions run first. Symlinks are recreated as symlinks. Returns
 * paths that were skipped (directories such as submodules, non-empty
 * directories in the way of a file or symlink).
 */
export function promoteFiles(
  repoRoot: string,
  wtPath: string,
  files: string[],
): string[] {
  assertPromotable(repoRoot, wtPath, files);
  const resolved = files.map((f) => {
    const src = path.resolve(wtPath, f);
    const dst = path.resolve(repoRoot, f);
    return { f, src, dst, stat: fs.lstatSync(src, { throwIfNoEntry: false }) };
  });

  const skipped: string[] = [];
  const deletions = resolved.filter((r) => !r.stat);
  const writes = resolved.filter((r) => r.stat);
  for (const { f, dst } of deletions) {
    assertContained(repoRoot, wtPath, f);
    const existing = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (!existing) continue;
    if (existing.isDirectory()) {
      skipped.push(f);
      continue;
    }
    fs.unlinkSync(dst);
  }
  for (const { f, src, dst, stat } of writes) {
    if (!stat!.isFile() && !stat!.isSymbolicLink()) {
      skipped.push(f);
      continue;
    }
    assertContained(repoRoot, wtPath, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const existing = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (existing?.isDirectory()) {
      // A file or symlink replacing a directory: only an empty one can go.
      if (fs.readdirSync(dst).length > 0) {
        skipped.push(f);
        continue;
      }
      fs.rmdirSync(dst);
    } else if (existing && (stat!.isSymbolicLink() || !existing.isFile())) {
      // Never write through a symlink (or into a FIFO) sitting at the path.
      fs.unlinkSync(dst);
    }
    if (stat!.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  return skipped;
}
