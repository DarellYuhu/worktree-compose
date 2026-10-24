import fs from "node:fs";
import path from "node:path";

/** True if a root-relative path escapes the root (or is absolute). */
export function escapesRoot(rel: string): boolean {
  if (path.isAbsolute(rel)) return true;
  const normalized = path.normalize(rel);
  return normalized === ".." || normalized.startsWith(`..${path.sep}`);
}

/**
 * Resolve a caller-supplied relative path inside `root`, or `null` when it is
 * absolute or would land outside `root` (including `root` itself).
 */
export function resolveInside(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back === "" || escapesRoot(back)) return null;
  return abs;
}

/** True if `child` is `parent` or lies inside it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || !escapesRoot(rel);
}

/**
 * `lstat` that returns `undefined` when nothing is there — including ENOTDIR
 * (a file where a directory on the way should be), which `throwIfNoEntry`
 * does not cover.
 */
export function lstatQuiet(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw err;
  }
}

/**
 * The first existing ancestor of `rel` below `root` (the final component
 * excluded) that is a symlink — or not a directory — or `null` when every
 * existing ancestor is a real directory. `path.resolve` containment is
 * purely lexical: `mkdirSync`/`copyFileSync`/`rmSync` follow a symlinked
 * directory, so `data/x.json` with `data -> /etc` lands outside `root`
 * even though the string never leaves it. Callers refuse such paths.
 */
export function symlinkAncestor(root: string, rel: string): string | null {
  const parts = path.normalize(rel).split(path.sep).filter((p) => p && p !== ".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return path.relative(root, current);
    }
  }
  return null;
}

/**
 * Where `p` will physically be once its missing components are created:
 * the realpath of its deepest existing ancestor plus the missing tail. `null`
 * when that ancestor cannot be resolved (a dangling symlink, a loop) — a
 * write could then land anywhere the link is later pointed.
 */
function physicalPath(p: string): { real: string; isDir: boolean } | null {
  let probe = path.resolve(p);
  const tail: string[] = [];
  while (!lstatQuiet(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  try {
    const real = fs.realpathSync.native(probe);
    return { real: path.join(real, ...tail), isDir: fs.statSync(real).isDirectory() };
  } catch {
    return null;
  }
}

/**
 * Whether the directory that will hold `rel` stays inside `root` physically:
 * the realpath of the nearest existing ancestor of `dirname(rel)` must be
 * inside realpath(`root`) and be a directory. Checked before anything is
 * created — `mkdirSync` through a symlinked directory would already create
 * directories outside `root`. A symlinked directory that resolves inside
 * `root` is fine.
 */
export function parentPlacement(root: string, rel: string): "inside" | "outside" | "not-dir" {
  const physicalRoot = physicalPath(root);
  const parent = physicalPath(path.dirname(path.resolve(root, rel)));
  if (!physicalRoot || !parent || !isWithin(physicalRoot.real, parent.real)) return "outside";
  return parent.isDir ? "inside" : "not-dir";
}

/**
 * True when `a` and `b` are the same file: the same realpath, or the same
 * inode (a hard link). Copying or injecting "into" the source itself would
 * rewrite the pristine original in place.
 */
export function isSameFile(a: string, b: string): boolean {
  try {
    if (fs.realpathSync.native(a) === fs.realpathSync.native(b)) return true;
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export interface WritablePathOptions {
  /** Names the path in "Skipped <label>: …" warnings (default: `rel`). */
  label?: string;
  /** Names `root` in warnings (default "the worktree"). */
  where?: string;
  /** Warn when a symlink or special file at the path is replaced (default true). */
  warnReplace?: boolean;
}

/**
 * Make `<root>/<rel>` safe to write a fresh regular file to, and return its
 * absolute path — or `null` (with a warning) when wtc must not write there.
 *
 * The tree under `root` is not trusted: a worktree's branch can commit
 * `infra -> /etc` or `.env -> ~/.ssh/config`, and `copyFileSync` /
 * `writeFileSync` follow both. So the directory that will hold the file
 * must resolve inside `root` (see `parentPlacement`), and a symlink or
 * special file at the final component is unlinked — never followed, never
 * removed recursively — so the write creates a new regular file. A
 * directory at the path is left alone.
 */
export function prepareWritablePath(
  root: string,
  rel: string,
  warnings: string[],
  opts: WritablePathOptions = {},
): string | null {
  const label = opts.label ?? rel;
  const where = opts.where ?? "the worktree";
  const abs = resolveInside(root, rel);
  if (!abs) {
    warnings.push(`Skipped ${label}: it is not a path inside ${where}.`);
    return null;
  }
  const placement = parentPlacement(root, rel);
  if (placement === "outside") {
    warnings.push(
      `Skipped ${label}: it resolves outside ${where} (through a symlinked directory); wtc does not write there.`,
    );
    return null;
  }
  if (placement === "not-dir") {
    warnings.push(`Skipped ${label}: a parent of it in ${where} is a file, not a directory.`);
    return null;
  }
  const existing = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!existing || existing.isFile()) return abs;
  if (existing.isDirectory()) {
    warnings.push(`Skipped ${label}: it is a directory in ${where}.`);
    return null;
  }
  fs.unlinkSync(abs);
  if (opts.warnReplace !== false) {
    const kind = existing.isSymbolicLink() ? "a symlink" : "a special file";
    warnings.push(
      `${rel} in ${where} was ${kind}; replaced it with a regular file (wtc never writes through one).`,
    );
  }
  return abs;
}
