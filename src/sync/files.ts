import fs from "node:fs";
import path from "node:path";
import {
  escapesRoot,
  isSameFile,
  lstatQuiet,
  parentPlacement,
  prepareWritablePath,
  resolveInside,
} from "../utils/paths.js";
import type { ComposeFile } from "../compose/types.js";

/**
 * One sync pass: main checkout → worktree. Every write goes through
 * `prepareWritablePath`, so nothing is written through a symlink the
 * worktree's branch planted (`infra -> /etc`, `compose.yaml -> ~/.bashrc`),
 * and nothing in the worktree is ever removed recursively.
 */
interface SyncRun {
  repoRoot: string;
  wtPath: string;
  warnings: string[];
}

/**
 * Make `rel` in the worktree a symlink carrying the same target as in main.
 * Symlinks are recreated, never followed: following one could copy files
 * from anywhere on disk (e.g. `secrets -> ~/.ssh`) into a worktree.
 *
 * - nothing there → create the link;
 * - a symlink with the same target → leave it (no-op);
 * - a symlink with another target, or a file → unlink (never recursive), link;
 * - a real directory → leave it with a warning: it may hold the worktree's
 *   own data (0.2 copied a symlinked sync entry as a real directory).
 */
function copySymlink(run: SyncRun, rel: string): void {
  const target = fs.readlinkSync(path.join(run.repoRoot, rel));
  const existing = lstatQuiet(path.join(run.wtPath, rel));
  if (existing?.isSymbolicLink() && fs.readlinkSync(path.join(run.wtPath, rel)) === target) return;
  if (existing?.isDirectory()) {
    run.warnings.push(
      `Skipping sync of ${rel}: it is a symlink in the main checkout but a directory in the worktree. Remove the worktree's directory yourself to resync.`,
    );
    return;
  }
  const dst = prepareWritablePath(run.wtPath, rel, run.warnings, {
    label: `sync of ${rel}`,
    warnReplace: false,
  });
  if (!dst) return;
  // A symlink or special file is already gone; a regular file is replaced too.
  if (lstatQuiet(dst)) fs.unlinkSync(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.symlinkSync(target, dst);
}

function copyFile(run: SyncRun, rel: string): void {
  const src = path.join(run.repoRoot, rel);
  if (!fs.existsSync(src)) return;
  const dst = prepareWritablePath(run.wtPath, rel, run.warnings, { label: `sync of ${rel}` });
  if (!dst) return;
  if (isSameFile(src, dst)) {
    run.warnings.push(`Skipping sync of ${rel}: it is the main checkout's own file.`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** Copy one entry: directories recurse, symlinks are recreated, special files skipped. */
function copyEntry(run: SyncRun, rel: string): void {
  const stat = fs.lstatSync(path.join(run.repoRoot, rel), { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    copySymlink(run, rel);
  } else if (stat.isDirectory()) {
    copyDir(run, rel);
  } else if (stat.isFile()) {
    copyFile(run, rel);
  }
  // Sockets, FIFOs and devices are skipped: copying them blocks or fails.
}

/** Merge a main directory into the worktree's (never replacing a file the worktree has there). */
function copyDir(run: SyncRun, rel: string): void {
  const existing = lstatQuiet(path.join(run.wtPath, rel));
  if (existing?.isFile()) {
    run.warnings.push(`Skipping sync of ${rel}: the worktree has a file there, not a directory.`);
    return;
  }
  if (existing?.isDirectory()) {
    if (parentPlacement(run.wtPath, rel) !== "inside") {
      run.warnings.push(
        `Skipping sync of ${rel}: it resolves outside the worktree (through a symlinked directory); wtc does not write there.`,
      );
      return;
    }
  } else {
    // Missing, or a symlink / special file (unlinked, not followed).
    const dst = prepareWritablePath(run.wtPath, rel, run.warnings, { label: `sync of ${rel}` });
    if (!dst) return;
    fs.mkdirSync(dst, { recursive: true });
  }
  for (const entry of fs.readdirSync(path.join(run.repoRoot, rel), { withFileTypes: true })) {
    copyEntry(run, path.join(rel, entry.name));
  }
}

/** Remote build contexts (`https://…`, `git@…`) have no local Dockerfile. */
function isRemoteContext(context: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith("git@");
}

export function getDockerfiles(
  composeFile: ComposeFile,
  repoRoot: string,
): string[] {
  const files: string[] = [];

  for (const svc of composeFile.services) {
    if (!svc.build || svc.build.inline) continue;
    const context = svc.build.context ?? ".";
    if (isRemoteContext(context)) continue;
    const dockerfile = svc.build.dockerfile ?? "Dockerfile";
    // Build contexts are relative to the file that declared the service, which
    // may be an included file rather than the root compose file. `resolve`
    // (not `join`) keeps absolute dockerfile paths absolute.
    const resolvedDir = path.resolve(path.dirname(svc.sourcePath), context);
    const fullPath = path.resolve(resolvedDir, dockerfile);
    const rel = path.relative(repoRoot, fullPath);
    if (rel === "" || escapesRoot(rel)) continue;
    files.push(rel);
  }

  return [...new Set(files)];
}

/**
 * Repo-relative paths of the `sync` entries that stay inside the repo, plus a
 * warning for each entry that is absolute or escapes it (`../secrets`).
 */
export function resolveSyncEntries(
  repoRoot: string,
  entries: string[] | undefined,
): { entries: string[]; warnings: string[] } {
  const ok: string[] = [];
  const warnings: string[] = [];
  for (const entry of entries ?? []) {
    const abs = resolveInside(repoRoot, entry);
    if (!abs) {
      warnings.push(
        `Skipping sync entry "${entry}": it must be a path inside the repository.`,
      );
      continue;
    }
    ok.push(path.relative(repoRoot, abs));
  }
  return { entries: ok, warnings };
}

/**
 * Copy compose files (with includes), Dockerfiles and `sync` entries from the
 * main checkout into a worktree. Returns warnings for skipped entries (sync
 * entries outside the repo, and destinations wtc refuses to write or
 * replaced instead of writing through) so `start` can report them.
 */
export function syncWorktreeFiles(
  repoRoot: string,
  wtPath: string,
  composeFile: ComposeFile,
  extraSync?: string[],
): string[] {
  const { entries, warnings } = resolveSyncEntries(repoRoot, extraSync);
  // Copying the main checkout onto itself would at best do nothing.
  if (isSameFile(repoRoot, wtPath)) {
    warnings.push(`Skipping file sync: ${wtPath} is the main checkout itself.`);
    return warnings;
  }
  const run: SyncRun = { repoRoot, wtPath, warnings };

  for (const src of composeFile.sourceFiles) {
    const rel = path.relative(repoRoot, src);
    if (rel === "" || escapesRoot(rel)) continue;
    copyFile(run, rel);
  }

  for (const df of getDockerfiles(composeFile, repoRoot)) {
    copyFile(run, df);
  }

  for (const rel of entries) {
    copyEntry(run, rel);
  }
  return warnings;
}
