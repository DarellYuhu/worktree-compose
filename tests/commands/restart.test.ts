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

const execMock = jest.fn<string, [string]>(() => "");
const execLiveMock = jest.fn<string, [string]>(() => "");
const execSafeMock = jest.fn<string, [string]>(() => "");

jest.unstable_mockModule("../../src/utils/exec.js", () => ({
  exec: execMock,
  execLive: execLiveMock,
  execSafe: execSafeMock,
}));

// Silence command output so test reports stay readable.
jest.unstable_mockModule("../../src/utils/log.js", () => ({
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  header: jest.fn(),
}));

// startCommand prints a listing at the end; keep that out of the test output.
jest.unstable_mockModule("../../src/commands/list.js", () => ({
  listCommand: jest.fn(),
}));

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
    execMock.mockReset();
    execLiveMock.mockReset();
    execSafeMock.mockReset();

    tmpBase = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-restart-")),
    );
    repoRoot = path.join(tmpBase, "repository");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "compose.yaml"), composeYaml());
    fs.writeFileSync(path.join(repoRoot, ".env.example"), "PORT=4000\n");

    worktreesPorcelain = "";

    execMock.mockImplementation((command: string) => {
      if (command.includes("rev-parse --show-toplevel")) return repoRoot;
      if (command.includes("worktree list")) return worktreesPorcelain;
      return "";
    });
    execLiveMock.mockImplementation(() => "");
    execSafeMock.mockImplementation(() => "");
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /** Only compose-level execs count: git probes go through `exec` too. */
  function dockerCalls(): string[] {
    return [...execLiveMock.mock.calls, ...execMock.mock.calls]
      .map((call) => String(call[0]))
      .filter((command) => command.includes("docker"));
  }

  it("validates the env file name before stopping any worktree", () => {
    expect(() => restartCommand([], { envFile: "../escape" })).toThrow(
      /Invalid env file name/,
    );
    expect(dockerCalls()).toHaveLength(0);
  });

  it("validates workspace selectors before stopping any worktree", () => {
    expect(() => restartCommand([], { workspaces: ["nope"] })).toThrow(
      /Workspace "nope" not found/,
    );
    expect(dockerCalls()).toHaveLength(0);
  });

  it("stops and starts when the env options are valid", () => {
    const wtDir = path.join(tmpBase, "wt-one");
    fs.mkdirSync(wtDir, { recursive: true });
    worktreesPorcelain =
      `worktree ${repoRoot}\nbranch refs/heads/main\n\n` +
      `worktree ${wtDir}\nbranch refs/heads/feat\n\n`;

    restartCommand([], {});

    const calls = dockerCalls();
    expect(calls.filter((c) => c.includes("down"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("up -d"))).toHaveLength(1);
  });
});
