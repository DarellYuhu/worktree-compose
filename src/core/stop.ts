import { buildContext } from "../context.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { selectWorktrees } from "../selectors.js";
import { composeEnv, composeRun, reportContextWarnings, throwIfAborted } from "./compose.js";
import type { WorktreeSelector } from "../selectors.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

export interface StopOptions {
  /** Worktrees to stop (index, branch, dir name, path, "."); empty = all. */
  worktrees?: WorktreeSelector[];
  /** Skip context warnings (restart reports them once, from start). */
  quiet?: boolean;
}

export interface StopResult {
  stopped: { index: number; branch: string; project: string }[];
  failed: { index: number; branch: string; project: string; error: string }[];
  /** Stacks that could not be stopped (non-zero → exit 1 / MCP isError). */
  failures: number;
}

/**
 * `compose stop` for each selected worktree; one failure does not stop the
 * rest. Containers are stopped, not removed: data in volumes declared only
 * by an image (postgres, redis… without a named volume) lives in anonymous
 * volumes that a `down` + `up` would replace with empty ones. `wtc start`
 * resumes the same containers; `clean`/`prune` remove everything.
 */
export async function stopWorktrees(
  options: StopOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<StopResult> {
  // Probe like start and list: with a lost or corrupt registry, worktrees
  // then adopt their running stacks' identities instead of positional
  // names that never existed (`compose stop` on those is a silent no-op).
  // The probe runs `ps` only when some worktree has no record.
  const ctx = buildContext({}, { cwd: io.cwd, probeStacks: true });
  if (!options.quiet) reportContextWarnings(ctx, reporter, { isolation: false });
  const result: StopResult = { stopped: [], failed: [], failures: 0 };

  if (ctx.worktrees.length === 0) {
    reporter.warn("No worktrees to stop.");
    return result;
  }

  const targets = selectWorktrees(ctx.worktrees, options.worktrees, ctx.cwd);
  const engine = ctx.getEngine();

  for (const wt of targets) {
    throwIfAborted(io);
    reporter.info(`Stopping ${wt.project}...`);
    const entry = { index: wt.index, branch: wt.branch, project: wt.project };
    let env: Record<string, string> | undefined;
    try {
      env = composeEnv(
        wt.project,
        allocateWorktreePorts(ctx.portMappings, wt.index, ctx.portStride),
      );
    } catch {
      env = undefined;
    }
    try {
      await composeRun(engine, wt.project, ["stop"], {
        cwd: wt.path,
        env,
        live: io.live,
        signal: io.signal,
        onLine: io.onOutput,
      });
      reporter.success(`Stopped worktree ${wt.index} (${wt.branch})`);
      result.stopped.push(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reporter.warn(`Could not stop ${wt.project}: ${message}`);
      result.failed.push({ ...entry, error: message });
    }
  }

  result.failures = result.failed.length;
  return result;
}
