import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  jest,
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
} from "@jest/globals";

type Runner = (file: string, args: string[]) => string;

const runMock = jest.fn<Runner>(() => "");
const runSafeMock = jest.fn<(file: string, args: string[]) => string | null>(() => "");
const runLiveMock = jest.fn<(file: string, args: string[]) => void>(() => {});
const runAsyncMock = jest.fn(async (_file: string, _args: string[]) => ({
  code: 0,
  stdout: "",
  stderr: "",
}));

jest.unstable_mockModule("../../src/utils/exec.js", () => ({
  run: runMock,
  runSafe: runSafeMock,
  runLive: runLiveMock,
  runAsync: runAsyncMock,
  displayCommand: (file: string, args: string[]) => [file, ...args].join(" "),
  ENGINE_PROBE_TIMEOUT_MS: 30_000,
  tailLines: (text: string) => text,
  CommandError: class CommandError extends Error {},
}));

// startCommand prints a listing at the end; keep that out of the test output.
jest.unstable_mockModule("../../src/commands/list.js", () => ({
  listCommand: jest.fn(async () => {}),
}));

const log = await import("../../src/utils/log.js");
const { restartCommand } = await import("../../src/commands/restart.js");

function composeYaml(): string {
  return [
    "services:",
    "  web:",
    "    image: nginx:alpine",
    "    ports:",
    '      - "3000:3000"',
    "",
  ].join("\n");
}

describe("restartCommand", () => {
  let tmpBase: string;
  let repoRoot: string;
  let worktreesPorcelain: string;

  beforeEach(() => {
    runMock.mockReset();
    runSafeMock.mockReset();
    runLiveMock.mockReset();
    runAsyncMock.mockClear();
    // Silence command output so test reports stay readable.
    for (const fn of ["info", "success", "warn", "header"] as const) {
      jest.spyOn(log.consoleReporter, fn).mockImplementation(() => {});
    }
    jest.spyOn(console, "log").mockImplementation(() => {});

    tmpBase = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-restart-")),
    );
    repoRoot = path.join(tmpBase, "repository");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "compose.yaml"), composeYaml());
    fs.writeFileSync(path.join(repoRoot, ".env.example"), "PORT=4000\n");

    worktreesPorcelain = `worktree ${repoRoot}\nbranch refs/heads/main\n\n`;

    const git = (args: string[]): string => {
      if (args.includes("--show-toplevel")) return repoRoot;
      if (args.includes("--git-common-dir")) return path.join(repoRoot, ".git");
      if (args.includes("worktree") && args.includes("list")) return worktreesPorcelain;
      return "";
    };
    runMock.mockImplementation((file, args) => (file === "git" ? git(args) : ""));
    runSafeMock.mockImplementation((file, args) => (file === "git" ? git(args) : ""));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /** A linked worktree checkout on disk (with its `.git` file), listed by git. */
  function addLinkedWorktree(): string {
    const wtDir = path.join(tmpBase, "wt-one");
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-one")}\n`);
    worktreesPorcelain += `worktree ${wtDir}\nbranch refs/heads/feat\n\n`;
    return wtDir;
  }

  /** Compose invocations only: git probes and engine detection don't count. */
  function composeCalls(): string[] {
    return runAsyncMock.mock.calls.map((call) => [call[0], ...call[1]].join(" "));
  }

  it("validates the env file name before stopping any worktree", async () => {
    // With a running worktree, a missing preflight would show up as a stop call.
    addLinkedWorktree();
    await expect(restartCommand([], { envFile: "../escape" })).rejects.toThrow(
      /Invalid env file name/,
    );
    expect(composeCalls()).toHaveLength(0);
  });

  it("validates workspace selectors before stopping any worktree", async () => {
    addLinkedWorktree();
    await expect(restartCommand([], { workspaces: ["nope"] })).rejects.toThrow(
      /Workspace "nope" not found/,
    );
    expect(composeCalls()).toHaveLength(0);
  });

  it("validates worktree selectors before stopping any worktree", async () => {
    addLinkedWorktree();

    await expect(restartCommand(["nope"], {})).rejects.toThrow(
      /Worktree "nope" not found\. Available worktrees: 1:feat/,
    );
    expect(composeCalls()).toHaveLength(0);
  });

  it("stops and starts when the env options are valid", async () => {
    const wtDir = addLinkedWorktree();

    await restartCommand([], {});

    const calls = composeCalls();
    // `stop`, not `down`: containers (and their anonymous volumes) survive.
    expect(calls.filter((c) => c.endsWith(" stop"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes(" down"))).toHaveLength(0);
    expect(calls.filter((c) => c.includes("up -d --build --remove-orphans"))).toHaveLength(1);
    expect(calls[0]).toContain("-p repository-wt-1-feat");
    expect(fs.readFileSync(path.join(wtDir, ".env"), "utf-8")).toContain(
      "COMPOSE_PROJECT_NAME=repository-wt-1-feat",
    );
  });
});
