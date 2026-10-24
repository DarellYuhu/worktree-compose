import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { composeProjectName } from "../utils/sanitize.js";
import { escapesRoot } from "../utils/paths.js";
import { isCandidate, worktreeAdminDir } from "../git/worktree.js";
import type { WorktreeInfo } from "../git/worktree.js";

/**
 * Persistent worktree identity. Each worktree's index (which drives its ports)
 * and compose project name are assigned once, at first sight, and stored in
 * `<git common dir>/wtc/state.json`. Deriving them from the position in
 * `git worktree list` (≤0.2) meant removing worktree #1 renamed #2 → #1, so
 * its running stack was orphaned and a second stack started on new ports.
 * The file lives inside `.git`: never committed, shared by every worktree.
 *
 * A record is tied to its worktree by its path and by a random id kept in
 * the worktree's git admin dir (`.git/worktrees/<name>/wtc-id`):
 * `git worktree move` keeps the admin dir (same id, so the record follows
 * the worktree), while `git worktree remove` deletes it (so a new worktree
 * created at a reused path is a new worktree, not the old one's heir).
 *
 * Records whose worktree is gone (orphans) are never released implicitly:
 * a stack may still hold their ports on a daemon this process cannot see.
 * Only `wtc prune` / `wtc clean` tear them down and forget them. A worktree
 * git still lists is never gone, even when wtc cannot manage it: a locked
 * one whose checkout is missing (an unmounted drive), or one that became
 * the main checkout. Their records are *unavailable*, not orphaned.
 */

export interface WorktreeRecord {
  path: string;
  index: number;
  project: string;
  branch: string;
  createdAt: string;
  /** Stable worktree id (also stored as `wtc-id` in the worktree's git admin dir). */
  id?: string;
  /** Repo-relative (`/`-separated) env files wtc wrote into the worktree. */
  envFiles?: string[];
}

export interface ResolvedWorktree extends WorktreeInfo {
  index: number;
  project: string;
  /** Stable id, when the worktree's admin dir holds one. */
  id?: string;
  /** Env files wtc wrote into the worktree (see WorktreeRecord). */
  envFiles?: string[];
}

export interface StateFile {
  version: 1;
  worktrees: WorktreeRecord[];
  /**
   * Projects of records wtc forgot (pruned or cleaned), for diagnosis. Never
   * used to claim a leftover as this repository's: another clone with the
   * same directory name can reuse the very same project name.
   */
  retired?: string[];
  /**
   * The main checkout, recorded in layouts where git cannot locate it from
   * every worktree (see RepoInfo.recordMain).
   */
  mainCheckout?: string;
}

export const STATE_VERSION = 1;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
/**
 * A lock whose holder still runs is broken only after this long. The
 * critical section is file I/O plus one `git worktree list` (container
 * calls happen before the lock is taken), so a holder this old is wedged —
 * or its PID was reused.
 */
const LOCK_MAX_AGE_MS = 10 * 60_000;
const RETIRED_LIMIT = 200;
const ID_FILE = "wtc-id";

export function stateDir(commonDir: string): string {
  return path.join(commonDir, "wtc");
}

export function stateFile(commonDir: string): string {
  return path.join(stateDir(commonDir), "state.json");
}

function lockFile(commonDir: string): string {
  return path.join(stateDir(commonDir), "state.lock");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** The holder PID of a lock's `<pid>:<token>` content, or null when unreadable. */
function lockPid(content: string | null): number | null {
  const m = /^(\d+):\S+\s*$/.exec(content ?? "");
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Only ESRCH proves a process is gone; EPERM means it exists but is not ours to signal. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Break the lock if it is stale. Returns true when the caller should retry
 * acquiring right away (lock broken, or released meanwhile).
 *
 * A lock is stale only when its holder PID no longer exists, or when it is
 * older than 10 minutes. Age alone never breaks a live holder sooner — an
 * age rule of 30 s let a waiter steal the lock from a process still inside
 * its critical section. The stale lock is renamed aside and its content
 * (unique token) compared, so a fresh lock that replaced it between our
 * read and the rename is put back, not lost.
 */
function breakStaleLock(lock: string): boolean {
  const content = readText(lock);
  if (content === null) return true;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch {
    return true;
  }
  const pid = lockPid(content);
  const stale = Date.now() - mtimeMs > LOCK_MAX_AGE_MS || (pid !== null && processIsGone(pid));
  if (!stale) return false;

  const aside = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return true;
  }
  try {
    if (readText(aside) !== content) {
      // A fresh lock replaced the stale one: restore it.
      try {
        fs.linkSync(aside, lock);
      } catch {
        // Yet another lock already took its place; nothing to restore into.
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
  return true;
}

/**
 * Run `fn` holding an exclusive lock on the registry. The CLI and the MCP
 * server (or two agents) may reconcile at the same moment; without the lock
 * both could hand out the same index. `fn` must never call a container
 * engine — a slow daemon would hold every other wtc process up.
 *
 * The lock holds `<pid>:<random token>`; on release it is removed only if
 * it still holds our token, so a holder never deletes another's lock.
 */
export function withStateLock<T>(
  commonDir: string,
  fn: () => T,
  opts: { timeoutMs?: number } = {},
): T {
  const lock = lockFile(commonDir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const content = `${process.pid}:${randomUUID()}`;

  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const broken = breakStaleLock(lock);
      if (Date.now() >= deadline) {
        const pid = lockPid(readText(lock));
        throw new Error(
          `Timed out waiting for the wtc state lock (${lock})` +
            (pid !== null ? `, held by process ${pid}` : "") +
            `. Another wtc command is running; retry when it finishes. ` +
            `If no wtc process is running at all, delete that file.`,
        );
      }
      if (!broken) sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      fs.writeSync(fd, content);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    break;
  }

  try {
    return fn();
  } finally {
    // Not ours any more (broken as stale by a waiter): leave it alone.
    if (readText(lock) === content) fs.rmSync(lock, { force: true });
  }
}

function isRecord(value: unknown): value is WorktreeRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.project === "string" &&
    typeof r.branch === "string" &&
    typeof r.createdAt === "string" &&
    Number.isInteger(r.index) &&
    (r.index as number) > 0 &&
    (r.id === undefined || typeof r.id === "string") &&
    (r.envFiles === undefined ||
      (Array.isArray(r.envFiles) && r.envFiles.every((f) => typeof f === "string")))
  );
}

/** Thrown for a state file written by a newer wtc: never discard it. */
export class NewerStateError extends Error {
  constructor(file: string, version: number) {
    super(`${file} was written by a newer wtc (state version ${version}); upgrade wtc.`);
    this.name = "NewerStateError";
  }
}

type Parsed =
  | { ok: true; state: StateFile; malformed: number }
  | { ok: false; problem: string };

function emptyState(): StateFile {
  return { version: STATE_VERSION, worktrees: [], retired: [] };
}

function parseState(file: string, text: string): Parsed {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, problem: "not a JSON object" };
  }
  const d = doc as Record<string, unknown>;
  if (Number.isInteger(d.version) && (d.version as number) > STATE_VERSION) {
    // A newer wtc (e.g. the global CLI) shares this file with an older one
    // (e.g. a cached MCP server). Resetting it would renumber every stack.
    throw new NewerStateError(file, d.version as number);
  }
  if (d.version !== STATE_VERSION) {
    return { ok: false, problem: `unsupported state version ${JSON.stringify(d.version)}` };
  }
  if (!Array.isArray(d.worktrees)) {
    return { ok: false, problem: `"worktrees" is not an array` };
  }
  const valid = d.worktrees.filter(isRecord);
  const retired = Array.isArray(d.retired)
    ? d.retired.filter((p): p is string => typeof p === "string")
    : [];
  const mainCheckout =
    typeof d.mainCheckout === "string" && path.isAbsolute(d.mainCheckout) ? d.mainCheckout : undefined;
  return {
    ok: true,
    state: { version: STATE_VERSION, worktrees: valid, retired, ...(mainCheckout ? { mainCheckout } : {}) },
    malformed: d.worktrees.length - valid.length,
  };
}

/**
 * Read the registry without side effects: `null` when there is none or it
 * is unreadable. Throws NewerStateError for a newer format.
 */
export function peekState(commonDir: string): StateFile | null {
  const file = stateFile(commonDir);
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseState(file, text);
  return parsed.ok ? parsed.state : null;
}

/**
 * Read the registry. A corrupt file is moved aside as
 * `state.json.bak-<epoch>` (never silently overwritten) and replaced by an
 * empty registry, with a warning; malformed records are dropped after a
 * backup copy. With `readOnly`, nothing is moved or copied — the problem is
 * only reported. A file from a newer wtc is never touched: NewerStateError.
 */
export function readState(
  commonDir: string,
  warnings: string[] = [],
  opts: { readOnly?: boolean } = {},
): StateFile {
  const file = stateFile(commonDir);
  const text = readText(file);
  if (text === null) return emptyState();

  const parsed = parseState(file, text);
  if (parsed.ok) {
    if (parsed.malformed > 0) {
      if (opts.readOnly) {
        warnings.push(`Ignoring ${parsed.malformed} malformed record(s) in ${file}.`);
      } else {
        const backup = `${file}.bak-${Date.now()}`;
        fs.copyFileSync(file, backup);
        warnings.push(`Ignored ${parsed.malformed} malformed record(s) in ${file} (backup: ${backup}).`);
      }
    }
    return parsed.state;
  }

  if (opts.readOnly) {
    warnings.push(
      `wtc state file is unreadable (${parsed.problem}): ${file}. Left in place; ` +
        `the next command that changes anything moves it aside and starts fresh.`,
    );
    return emptyState();
  }
  const backup = `${file}.bak-${Date.now()}`;
  fs.renameSync(file, backup);
  warnings.push(
    `wtc state file was unreadable (${parsed.problem}); moved it to ${backup} and started fresh.`,
  );
  return emptyState();
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeState(commonDir: string, state: StateFile): void {
  const file = stateFile(commonDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const retired = [...new Set(state.retired ?? [])].slice(-RETIRED_LIMIT);
  const doc: StateFile = {
    version: STATE_VERSION,
    worktrees: state.worktrees,
    retired,
    ...(state.mainCheckout ? { mainCheckout: state.mainCheckout } : {}),
  };
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function lowestFreeIndex(used: Set<number>): number {
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

/** The stable id stored in a worktree's admin dir, if it has one yet. */
export function readWorktreeId(adminDir: string | undefined): string | undefined {
  if (!adminDir) return undefined;
  const id = readText(path.join(adminDir, ID_FILE))?.trim();
  return id || undefined;
}

/** Create the worktree's id file; `undefined` when its admin dir is not writable. */
function createWorktreeId(adminDir: string | undefined): string | undefined {
  if (!adminDir) return undefined;
  const id = randomUUID();
  try {
    fs.writeFileSync(path.join(adminDir, ID_FILE), id + "\n", { flag: "wx" });
    return id;
  } catch {
    return readWorktreeId(adminDir);
  }
}

interface LiveWorktree extends WorktreeInfo {
  /** Its id, read from the admin dir (undefined when it has none yet). */
  id?: string;
}

/**
 * Is `record` the record of the live worktree `wt`? Its id matches, or —
 * for a record without an id, or a worktree that cannot hold one (no admin
 * dir) — its path does. A path match whose ids differ (or a fresh admin
 * dir with no id yet) is a *different* worktree created at a reused path.
 */
function isRecordOf(record: WorktreeRecord, wt: LiveWorktree): boolean {
  if (record.id !== undefined && record.id === wt.id) return true;
  return pathMatches(record, wt);
}

function pathMatches(record: WorktreeRecord, wt: LiveWorktree): boolean {
  return (
    path.resolve(record.path) === path.resolve(wt.path) &&
    (record.id === undefined || record.id === wt.id || (wt.id === undefined && !wt.adminDir))
  );
}

/** A running stack a worktree without a record may adopt (see ReconcileOptions.adoptable). */
export interface AdoptableStack {
  index: number;
  project: string;
}

export interface ReconcileOptions {
  commonDir: string;
  repoName: string;
  /**
   * Lists the worktrees in `git worktree list` order (main/bare/prunable
   * entries included; prunable ones count for legacy positions but are
   * never live). Called *inside* the lock, so the worktree set and the
   * registry are read at the same moment: a worktree another process
   * registered meanwhile is never mistaken for an orphan.
   */
  listWorktrees: () => WorktreeInfo[];
  /**
   * Identities of running stacks, keyed by the (resolved) path of the live
   * worktree that is their compose working_dir. A worktree without a
   * record adopts its stack's index and project when that index is free.
   * Computed by the caller *before* reconciling — container calls never run
   * under the lock. `undefined` means no stack probe was available: an
   * empty registry is then not persisted (positional identities are only
   * computed), so the next engine-aware command can adopt running stacks.
   */
  adoptable?: Map<string, AdoptableStack>;
  /**
   * Compute identities without side effects: no lock, no state write, no
   * `wtc-id` created, and a corrupt file is reported rather than moved aside.
   */
  readOnly?: boolean;
  /** Record this path as the main checkout when the registry is written (RepoInfo.recordMain). */
  mainCheckout?: string;
  now?: () => Date;
}

/** The record of a worktree git still lists but wtc cannot manage. */
export interface UnavailableRecord extends WorktreeRecord {
  /**
   * `missing`: locked, and its checkout is missing on disk (an unmounted
   * drive). `main`: it is now the main checkout (bare layouts).
   */
  reason: "missing" | "main";
}

export interface ReconcileResult {
  /** Live worktrees, in git order, with their persistent index and project. */
  worktrees: ResolvedWorktree[];
  /** Records whose worktree is gone; their index stays reserved until prune/clean. */
  orphans: WorktreeRecord[];
  /**
   * Records of worktrees git still lists but wtc cannot start (see
   * UnavailableRecord): kept with their index and stack, never orphans —
   * prune and clean leave them alone.
   */
  unavailable: UnavailableRecord[];
  warnings: string[];
  /** The worktree listing the result was computed from. */
  listed: WorktreeInfo[];
}

/**
 * Match live worktrees to their records, assigning new identities as needed.
 *
 * - Records match by path, then by stable id: a moved worktree keeps its
 *   index and project (the stored path is updated); a new worktree at a
 *   reused path does not inherit the old one's (see isRecordOf).
 * - Records with no live worktree are orphans. They keep their index — their
 *   stack may still hold its ports — until `wtc prune` / `wtc clean`.
 * - A worktree without a record adopts a running stack's identity
 *   (`adoptable`) when its index is free. Otherwise an empty registry
 *   (fresh install, 0.2 upgrade, corrupt file) assigns positional indices
 *   in `git worktree list` order — exactly the old naming, so 0.2 stacks are
 *   adopted, not duplicated — and a non-empty one the lowest index no
 *   record (live or orphaned) holds.
 */
export function reconcileWorktrees(opts: ReconcileOptions): ReconcileResult {
  if (opts.readOnly) {
    const warnings: string[] = [];
    const listed = opts.listWorktrees();
    const state = readState(opts.commonDir, warnings, { readOnly: true });
    return assignIdentities(opts, listed, state, warnings, false);
  }

  if (!fs.existsSync(stateFile(opts.commonDir))) {
    const pre = opts.listWorktrees();
    if (!pre.some(isCandidate)) {
      // Nothing to record and nothing recorded: don't create .git/wtc at all.
      return { worktrees: [], orphans: [], unavailable: [], warnings: [], listed: pre };
    }
    if (opts.adoptable === undefined) {
      // A fresh registry without a stack probe is computed, never persisted,
      // so nothing is written — not even the lock.
      const warnings: string[] = [];
      const state = readState(opts.commonDir, warnings, { readOnly: true });
      return assignIdentities(opts, pre, state, warnings, false);
    }
  }

  return withStateLock(opts.commonDir, () => {
    const listed = opts.listWorktrees();
    const warnings: string[] = [];
    const state = readState(opts.commonDir, warnings);
    const persist = state.worktrees.length > 0 || opts.adoptable !== undefined;
    return assignIdentities(opts, listed, state, warnings, persist);
  });
}

function assignIdentities(
  opts: ReconcileOptions,
  listed: WorktreeInfo[],
  state: StateFile,
  warnings: string[],
  persist: boolean,
): ReconcileResult {
  const now = opts.now ?? (() => new Date());
  const fresh = state.worktrees.length === 0;
  const records = state.worktrees;
  let changed = false;

  const live: LiveWorktree[] = listed.filter(isCandidate).map((wt) => ({
    ...wt,
    path: path.resolve(wt.path),
    id: readWorktreeId(wt.adminDir),
  }));

  // 1. Match records to live worktrees: by path, then by id.
  const matched = new Map<LiveWorktree, WorktreeRecord>();
  const claimed = new Set<WorktreeRecord>();
  const claim = (wt: LiveWorktree, record: WorktreeRecord) => {
    matched.set(wt, record);
    claimed.add(record);
  };
  for (const wt of live) {
    const record = records.find((r) => !claimed.has(r) && pathMatches(r, wt));
    if (record) claim(wt, record);
  }
  for (const wt of live) {
    if (matched.has(wt) || wt.id === undefined) continue;
    const record = records.find((r) => !claimed.has(r) && r.id === wt.id);
    if (!record) continue;
    record.path = wt.path; // `git worktree move`: same worktree, new path.
    changed = true;
    claim(wt, record);
  }
  // Worktrees git still lists but wtc cannot start keep their records too:
  // locked ones missing on disk, and one that became the main checkout.
  const unavailable: UnavailableRecord[] = [];
  for (const entry of listed) {
    if (!holdsRecord(entry) || isCandidate(entry)) continue;
    const wt: LiveWorktree = { ...entry, path: path.resolve(entry.path), id: readWorktreeId(entry.adminDir) };
    const record =
      records.find((r) => !claimed.has(r) && pathMatches(r, wt)) ??
      (wt.id === undefined ? undefined : records.find((r) => !claimed.has(r) && r.id === wt.id));
    if (!record) continue;
    if (record.path !== wt.path) {
      record.path = wt.path;
      changed = true;
    }
    claimed.add(record);
    unavailable.push({ ...record, reason: entry.missing ? "missing" : "main" });
  }

  // Stamp ids on records written before ids existed.
  for (const [wt, record] of matched) {
    if (record.id !== undefined) continue;
    const id = wt.id ?? (persist ? createWorktreeId(wt.adminDir) : undefined);
    if (id) {
      record.id = id;
      changed = true;
    }
  }

  // 2. Every record keeps its index: orphans are only forgotten by prune/clean.
  const orphans = records.filter((r) => !claimed.has(r));
  const used = new Set(records.map((r) => r.index));
  const projects = new Set(records.map((r) => r.project));

  // 3. Worktrees without a record adopt their running stack's identity.
  const adopted = new Map<LiveWorktree, AdoptableStack>();
  for (const wt of live) {
    if (matched.has(wt)) continue;
    const stack = opts.adoptable?.get(wt.path);
    if (!stack || used.has(stack.index) || projects.has(stack.project)) continue;
    adopted.set(wt, stack);
    used.add(stack.index);
    projects.add(stack.project);
  }

  // 4. Number the rest.
  const kept = [...records];
  const resolved: ResolvedWorktree[] = [];
  // ≤0.2 numbered every non-main entry (prunable ones included) 1..N.
  let legacyPosition = 0;
  const byPath = new Map(live.map((wt) => [wt.path, wt]));
  for (const entry of listed) {
    if (entry.isMain || entry.bare) continue;
    legacyPosition++;
    if (!isCandidate(entry)) continue;
    const wt = byPath.get(path.resolve(entry.path));
    if (!wt) continue;

    let record = matched.get(wt);
    if (!record) {
      const stack = adopted.get(wt);
      const index = stack
        ? stack.index
        : fresh && !used.has(legacyPosition)
          ? legacyPosition
          : lowestFreeIndex(used);
      record = {
        path: wt.path,
        index,
        project: stack ? stack.project : composeProjectName(opts.repoName, index, wt.branch),
        branch: wt.branch,
        createdAt: now().toISOString(),
      };
      const id = wt.id ?? (persist ? createWorktreeId(wt.adminDir) : undefined);
      if (id) record.id = id;
      used.add(index);
      kept.push(record);
      changed = true;
    }
    resolved.push({
      ...wt,
      index: record.index,
      project: record.project,
      id: record.id,
      envFiles: record.envFiles,
    });
  }

  let mainCheckout = state.mainCheckout;
  if (opts.mainCheckout !== undefined && mainCheckout !== path.resolve(opts.mainCheckout)) {
    mainCheckout = path.resolve(opts.mainCheckout);
    changed = true;
  }

  if (persist && changed) {
    writeState(opts.commonDir, {
      version: STATE_VERSION,
      worktrees: kept,
      retired: state.retired,
      ...(mainCheckout ? { mainCheckout } : {}),
    });
  }

  orphans.sort((a, b) => a.index - b.index);
  unavailable.sort((a, b) => a.index - b.index);
  return { worktrees: resolved, orphans, unavailable, warnings, listed };
}

/**
 * Entries whose records stay theirs: every linked worktree git still lists
 * — managed ones, locked ones missing on disk, and one marked main — but
 * not the first entry (main checkout, bare repo or git dir) nor ones git
 * reports gone (prunable).
 */
function holdsRecord(wt: WorktreeInfo): boolean {
  return !wt.bare && !wt.prunable && (!wt.isMain || wt.markedMain === true);
}

/**
 * True when a record's worktree still exists in `listed` (same identity
 * rules as reconcile): any linked worktree git still lists counts —
 * including a locked one missing on disk and one marked main — not only
 * those wtc can start. Clean and prune re-check this right before tearing
 * an orphan down: another process may have registered or moved its
 * worktree since, and `down -v` must never hit a worktree that exists.
 */
export function recordIsLive(record: WorktreeRecord, listed: WorktreeInfo[]): boolean {
  return listed
    .filter(holdsRecord)
    .some((wt) => isRecordOf(record, { ...wt, path: path.resolve(wt.path), id: readWorktreeId(wt.adminDir) }));
}

/** True when the live worktree `wt` already has a record in `state`. */
export function hasRecord(state: StateFile | null, wt: WorktreeInfo): boolean {
  if (!state) return false;
  const live = { ...wt, id: readWorktreeId(wt.adminDir) };
  return state.worktrees.some((r) => isRecordOf(r, live));
}

/**
 * Drop records by compose project (unique per record) — used by clean and
 * prune after teardown. Keyed by project, not path: a reused path can hold
 * both an orphan's record and a new worktree's. An unreadable registry is
 * left alone rather than moved aside.
 */
export function forgetRecords(commonDir: string, projects: string[]): void {
  if (projects.length === 0) return;
  if (!fs.existsSync(stateFile(commonDir))) return;
  const drop = new Set(projects);
  withStateLock(commonDir, () => {
    const state = peekState(commonDir);
    if (!state) return;
    const kept = state.worktrees.filter((r) => !drop.has(r.project));
    if (kept.length !== state.worktrees.length) {
      const retired = [...(state.retired ?? []), ...projects];
      writeState(commonDir, { ...state, worktrees: kept, retired });
    }
  });
}

/**
 * Remember env files wtc wrote into the worktree at `wtPath` (absolute, or
 * relative to the worktree), merged with — and deduplicated against — those
 * already recorded. Stored repo-relative with `/` separators. Clean treats
 * exactly these as wtc's own changes, so they never make a worktree dirty.
 * A worktree without a record (registry not persisted yet) is skipped.
 */
export function recordEnvFiles(commonDir: string, wtPath: string, files: string[]): void {
  if (!fs.existsSync(stateFile(commonDir))) return;
  const root = path.resolve(wtPath);
  const rel = files
    .map((f) => (path.isAbsolute(f) ? path.relative(root, f) : path.normalize(f)))
    .filter((f) => f !== "" && f !== "." && !escapesRoot(f))
    .map((f) => f.split(path.sep).join("/"));
  if (rel.length === 0) return;
  // Identify the worktree before locking (may ask git).
  const adminDir = worktreeAdminDir(root);
  const wt: LiveWorktree = {
    path: root,
    branch: "",
    isMain: false,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    adminDir,
    id: readWorktreeId(adminDir),
  };
  withStateLock(commonDir, () => {
    const state = peekState(commonDir);
    const record = state?.worktrees.find((r) => isRecordOf(r, wt));
    if (!state || !record) return;
    const merged = [...new Set([...(record.envFiles ?? []), ...rel])];
    if (record.envFiles && merged.length === record.envFiles.length) return;
    record.envFiles = merged;
    writeState(commonDir, state);
  });
}
