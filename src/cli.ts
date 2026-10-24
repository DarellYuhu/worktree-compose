#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { listCommand } from "./commands/list.js";
import { promoteCommand } from "./commands/promote.js";
import { cleanCommand } from "./commands/clean.js";
import { pruneCommand } from "./commands/prune.js";
import { doctorCommand } from "./commands/doctor.js";
import { skillCommand } from "./commands/skill.js";
import { startMcpServer } from "./mcp/server.js";
import { error, setLogStream } from "./utils/log.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("wtc")
  .description("Zero-config Docker Compose isolation for git worktrees")
  .version(VERSION);

function collectWorkspace(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface StartCliOptions {
  env?: string;
  workspace?: string[];
  build?: boolean;
}

function startCliOptions(options: StartCliOptions) {
  return {
    envFile: options.env,
    workspaces: options.workspace,
    build: options.build !== false,
  };
}

const WORKTREES_ARG_HELP =
  "Worktrees by index, branch, directory name, path, or . (omit for all)";

function withStartOptions(command: Command): Command {
  return command
    .option(
      "--env <name>",
      'Env filename to copy and inject (default: config "envFile", else ".env")',
    )
    .option(
      "--workspace <name>",
      "Workspace to also inject env into (repeatable)",
      collectWorkspace,
      [] as string[],
    )
    .option("--no-build", "Skip --build on docker compose up");
}

withStartOptions(
  program
    .command("start")
    .description("Start Docker Compose stacks for worktrees")
    .argument("[worktrees...]", WORKTREES_ARG_HELP),
).action(async (worktrees: string[], options: StartCliOptions) => {
  await wrap(() => startCommand(worktrees, startCliOptions(options)));
});

program
  .command("stop")
  .description("Stop the containers of worktree stacks (start resumes them)")
  .argument("[worktrees...]", WORKTREES_ARG_HELP)
  .action(async (worktrees: string[]) => {
    await wrap(() => stopCommand(worktrees));
  });

withStartOptions(
  program
    .command("restart")
    .description("Restart Docker Compose stacks for worktrees")
    .argument("[worktrees...]", WORKTREES_ARG_HELP),
).action(async (worktrees: string[], options: StartCliOptions) => {
  await wrap(() => restartCommand(worktrees, startCliOptions(options)));
});

program
  .command("list")
  .alias("ls")
  .description("List worktrees with status, ports and URLs")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    await wrap(() => listCommand({ json: options.json }));
  });

program
  .command("promote")
  .description("Copy changed files from a worktree into the current checkout")
  .argument("<worktree>", "Worktree by index, branch, directory name, or path")
  .option(
    "--force",
    "Also promote files the current branch changed since the worktree branched (overwrites those commits)",
  )
  .action(async (worktree: string, options: { force?: boolean }) => {
    await wrap(() => promoteCommand(worktree, { force: options.force }));
  });

program
  .command("clean")
  .description(
    "Tear down every worktree stack (down -v: deletes their volumes), remove worktrees that hold no work, sweep leftovers this checkout owns",
  )
  .option(
    "--force",
    "Also remove worktrees with uncommitted changes, commits on no branch, unpushed submodule commits, and locked ones",
  )
  .option("--keep-worktrees", "Tear down stacks (deleting their volumes) but keep every worktree")
  .option("--dry-run", "Show what would be stopped/removed; change nothing")
  .option(
    "--sweep",
    "Also remove <repo>-wt-N-* stacks whose worktree directory no longer exists (e.g. left by wtc 0.2), judged from their containers: volumes or networks with no container left are listed, never removed",
  )
  .action(
    async (options: {
      force?: boolean;
      keepWorktrees?: boolean;
      dryRun?: boolean;
      sweep?: boolean;
    }) => {
      await wrap(() =>
        cleanCommand({
          force: options.force,
          keepWorktrees: options.keepWorktrees,
          dryRun: options.dryRun,
          sweep: options.sweep,
        }),
      );
    },
  );

program
  .command("prune")
  .description("Tear down stacks of deleted worktrees (down -v: deletes their volumes) and forget them")
  .option("--dry-run", "Show what would be pruned; change nothing")
  .action(async (options: { dryRun?: boolean }) => {
    await wrap(() => pruneCommand({ dryRun: options.dryRun }));
  });

program
  .command("doctor")
  .description("Check git, compose, engine, ports and isolation settings")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    await wrap(() => doctorCommand({ json: options.json }));
  });

program
  .command("skill")
  .description("Print the bundled agent skill (SKILL.md), or install it")
  .option("--install", "Write it to ~/.claude/skills/worktree-compose/SKILL.md")
  .option("--dir <path>", "Install under <path>/worktree-compose/ instead")
  .action(async (options: { install?: boolean; dir?: string }) => {
    await wrap(() => skillCommand(options));
  });

program
  .command("mcp")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    // stdout carries JSON-RPC: route every log line (and any stray
    // console.log) to stderr before anything else runs.
    setLogStream("stderr");
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;
    try {
      await startMcpServer();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function wrap(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

await program.parseAsync();
