import fs from "node:fs";
import path from "node:path";
import { buildContext, getEnvTargets } from "../context.js";
import { samePath } from "../git/worktree.js";
import { recordEnvFiles } from "../state/registry.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { syncWorktreeFiles } from "../sync/files.js";
import { findEnvSource, injectPortOverrides, prepareEnvFile } from "../sync/env.js";
import { selectWorktrees } from "../selectors.js";
import {
  composeEnv,
  composeRun,
  NO_WORKTREES_HINT,
  reportContextWarnings,
  throwIfAborted,
  withContext,
} from "./compose.js";
import type { EnvCliOptions } from "../context.js";
import type { WorktreeSelector } from "../selectors.js";
import type { Reporter } from "../utils/log.js";
import type { CoreIo } from "./types.js";

export interface StartOptions extends EnvCliOptions {
  /** Worktrees to start (index, branch, dir name, path, "."); empty = all. */
  worktrees?: WorktreeSelector[];
  /** Pass `--build` to `compose up` (default true). */
  build?: boolean;
  /**
   * Pass `--remove-orphans` to `compose up` (restart): containers of
   * services the compose file no longer declares would otherwise keep
   * running — and holding their ports — after the restart.
   */
  removeOrphans?: boolean;
}

export interface StartedWorktree {
  index: number;
  branch: string;
  path: string;
  project: string;
  ports: Record<string, number>;
}

export interface StartResult {
  started: StartedWorktree[];
}

/**
 * Sync infra files, inject ports + project name into env files, and run
 * `compose up -d` for each selected worktree. Stops at the first failure.
 */
export async function startWorktrees(
  options: StartOptions,
  reporter: Reporter,
  io: CoreIo,
): Promise<StartResult> {
  const ctx = buildContext(options, { cwd: io.cwd, probeStacks: true, requireMainFor: "start worktree stacks" });
  reportContextWarnings(ctx, reporter, { isolation: true });

  if (ctx.worktrees.length === 0) {
    reporter.warn(NO_WORKTREES_HINT);
    return { started: [] };
  }

  const targets = selectWorktrees(ctx.worktrees, options.worktrees, ctx.cwd);
  const envTargets = getEnvTargets(ctx);
  const engine = ctx.getEngine();
  const build = options.build !== false;
  const started: StartedWorktree[] = [];

  for (const wt of targets) {
    throwIfAborted(io);
    // Never treat the env/config source as a worktree, and never recreate a
    // missing checkout just to run compose in it.
    if (samePath(wt.path, ctx.repoRoot)) {
      throw new Error(
        `Worktree ${wt.index} (${wt.branch}) is the main checkout (${ctx.repoRoot}); wtc does not start it as a worktree.`,
      );
    }
    if (!fs.existsSync(path.join(wt.path, ".git"))) {
      throw new Error(
        `Worktree ${wt.index} (${wt.branch}) is missing on disk (${wt.path}). Remount it, or run 'git worktree prune' and 'wtc prune'.`,
      );
    }

    const allocations = allocateWorktreePorts(
      ctx.portMappings,
      wt.index,
      ctx.portStride,
    );

    reporter.header(`Worktree ${wt.index}: ${wt.branch}`);
    reporter.info(`Path:    ${wt.path}`);
    reporter.info(`Project: ${wt.project}`);
    reporter.info(
      `Ports:   ${allocations.map((a) => `${a.envVar}=${a.port}`).join(" ") || "(none)"}`,
    );

    const syncWarnings = syncWorktreeFiles(ctx.repoRoot, wt.path, ctx.composeFile, ctx.config.sync);
    // Skipped sync entries were already reported with the context warnings.
    for (const w of syncWarnings) if (!ctx.warnings.includes(w)) reporter.warn(w);
    reporter.success("Synced infrastructure files");

    const injected: string[] = [];
    for (const target of envTargets) {
      const envWarnings: string[] = [];
      const envPath = prepareEnvFile(ctx.repoRoot, wt.path, target, envWarnings);
      for (const w of envWarnings) reporter.warn(w);
      if (!envPath) {
        if (envWarnings.length === 0) {
          reporter.warn(
            `No ${target.envFileName} (or .env.example) found for ${target.label}; skipped`,
          );
        }
        continue;
      }
      const injection = injectPortOverrides(envPath, allocations, target.overrides, {
        projectName: wt.project,
        writeProjectName: target.dir === "",
        root: wt.path,
        source: findEnvSource(ctx.repoRoot, target) ?? undefined,
      });
      for (const w of injection.warnings) reporter.warn(w);
      injected.push(path.relative(wt.path, envPath));
    }
    if (injected.length > 0) {
      reporter.success(`Injected port overrides into ${injected.join(", ")}`);
    }
    // Remember exactly which env files wtc wrote (before compose runs: they
    // are written even if `up` fails), so clean treats only those as wtc's
    // own changes.
    recordEnvFiles(ctx.repo.commonDir, wt.path, injected);

    try {
      await composeRun(
        engine,
        wt.project,
        ["up", "-d", ...(build ? ["--build"] : []), ...(options.removeOrphans ? ["--remove-orphans"] : [])],
        {
          cwd: wt.path,
          env: composeEnv(wt.project, allocations),
          live: io.live,
          signal: io.signal,
          onLine: io.onOutput,
        },
      );
    } catch (err) {
      throw withContext(`Failed to start worktree ${wt.index} (${wt.branch})`, err);
    }

    reporter.success(`Worktree ${wt.index} started`);
    started.push({
      index: wt.index,
      branch: wt.branch,
      path: wt.path,
      project: wt.project,
      ports: Object.fromEntries(allocations.map((a) => [a.envVar, a.port])),
    });
  }

  return { started };
}
