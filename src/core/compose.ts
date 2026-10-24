import { CommandError, runAsync } from "../utils/exec.js";
import { composeArgs, composeBin } from "../compose/engine.js";
import { allocationEnv } from "../ports/allocate.js";
import { PROJECT_NAME_VAR } from "../sync/env.js";
import type { RunResult } from "../utils/exec.js";
import type { ComposeEngine } from "../compose/engine.js";
import type { PortAllocation } from "../ports/types.js";
import type { Reporter } from "../utils/log.js";
import type { WtcContext } from "../context.js";
import type { CoreIo } from "./types.js";

/**
 * Process environment for a compose call on a worktree stack: the project
 * name plus every allocated port, so `${VAR}` interpolation resolves to the
 * worktree's ports no matter which env filename is configured.
 */
export function composeEnv(
  project: string,
  allocations: PortAllocation[],
): Record<string, string> {
  return { [PROJECT_NAME_VAR]: project, ...allocationEnv(allocations) };
}

export interface ComposeCallOptions {
  cwd: string;
  env?: Record<string, string>;
  live: boolean;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/** Run `<compose> -p <project> <args…>` without blocking the event loop. */
export function composeRun(
  engine: ComposeEngine,
  project: string,
  args: string[],
  opts: ComposeCallOptions,
): Promise<RunResult> {
  return runAsync(composeBin(engine), composeArgs(engine, project, ...args), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    live: opts.live,
    signal: opts.signal,
    onLine: opts.onLine,
  });
}

/** Prefix an error with what was being done, keeping CommandError details. */
export function withContext(prefix: string, err: unknown): Error {
  if (err instanceof CommandError) {
    err.message = `${prefix}: ${err.message}`;
    return err;
  }
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Report a context's general warnings (and isolation warnings when asked). */
export function reportContextWarnings(
  ctx: WtcContext,
  reporter: Reporter,
  opts: { isolation: boolean },
): void {
  for (const w of ctx.warnings) reporter.warn(w);
  if (opts.isolation) {
    for (const w of ctx.isolationWarnings) reporter.warn(w);
  }
}

/** Throw if the operation was cancelled (checked between worktrees). */
export function throwIfAborted(io: CoreIo): void {
  if (io.signal?.aborted) throw new Error("Cancelled.");
}

export const NO_WORKTREES_HINT =
  "No extra worktrees found. Create one with:\n  git worktree add ../my-branch my-branch";
