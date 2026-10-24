import { execFileSync, spawn } from "node:child_process";

/**
 * Process execution without a shell. Every command is an executable plus an
 * argv array, so branch names, paths, and project names reach git/docker as
 * literal arguments — `$(…)`, backticks, quotes, and `;` are never
 * interpreted. Never add `shell: true` here.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Trim stdout (default true). Disable for `-z` output where whitespace is data. */
  trim?: boolean;
  /**
   * Kill the command after this many milliseconds and fail with a
   * "timed out" CommandError. Used for container-engine probes (`ps`, `info`,
   * `version`, sweeps): a wedged daemon must not hang wtc — or the MCP
   * server, whose event loop a synchronous call blocks — indefinitely.
   * Never set it on `compose up --build`, which may legitimately run long.
   */
  timeoutMs?: number;
}

/**
 * Timeout for container-engine probes and listings: engine `version`,
 * `ps`, `info`, the per-project fallback `compose ps`, sweep `ls`/`rm`.
 * Never for `compose up --build` / `down`, which may legitimately run long.
 */
export const ENGINE_PROBE_TIMEOUT_MS = 20_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 256 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 200;
/** Lines of stderr kept in a CommandError message. */
const MESSAGE_TAIL_LINES = 20;

/** Human-readable rendering of a command, for messages only — never executed. */
export function displayCommand(file: string, args: string[]): string {
  return [file, ...args].join(" ");
}

/** Last `maxLines` lines of `text`, trimmed. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.trim().split("\n");
  return lines.slice(-maxLines).join("\n").trim();
}

export class CommandError extends Error {
  /** The command as displayed to humans (args joined with spaces). */
  command: string;
  /** Exit code, or `null` when the process could not be started or was killed. */
  code: number | null;
  /** Trimmed stderr tail (empty for live commands, whose stderr went to the terminal). */
  stderr: string;

  constructor(command: string, code: number | null, stderr: string, reason?: string) {
    const tail = tailLines(stderr, MESSAGE_TAIL_LINES);
    const head = reason
      ? `${reason}: ${command}`
      : `Command failed${code === null ? "" : ` (exit ${code})`}: ${command}`;
    super(tail ? `${head}\n${tail}` : head);
    this.name = "CommandError";
    this.command = command;
    this.code = code;
    this.stderr = tail;
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function timeoutReason(timeoutMs: number | undefined): string {
  return `Command timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`;
}

/** Convert a child_process failure into a CommandError with the stderr tail. */
function toCommandError(
  file: string,
  args: string[],
  err: unknown,
  timeoutMs?: number,
): CommandError {
  const command = displayCommand(file, args);
  const e = err as NodeJS.ErrnoException & {
    status?: number | null;
    stderr?: unknown;
    signal?: string | null;
  };
  if (e?.code === "ENOENT") {
    return new CommandError(command, null, "", `Command not found (${file})`);
  }
  if (e?.code === "ETIMEDOUT") {
    return new CommandError(command, null, asText(e?.stderr), timeoutReason(timeoutMs));
  }
  const stderr = asText(e?.stderr);
  const code = typeof e?.status === "number" ? e.status : null;
  if (code === null && e?.signal) {
    return new CommandError(command, null, stderr, `Command killed by ${e.signal}`);
  }
  if (code === null && !stderr && e?.message) {
    return new CommandError(command, null, e.message);
  }
  return new CommandError(command, code, stderr);
}

/** Run a command and return its trimmed stdout. Throws CommandError on failure. */
export function run(file: string, args: string[], opts: RunOptions = {}): string {
  try {
    const out = execFileSync(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: opts.timeoutMs,
    });
    return opts.trim === false ? out : out.trim();
  } catch (err) {
    throw toCommandError(file, args, err, opts.timeoutMs);
  }
}

/** Like `run`, but returns `null` on any failure. */
export function runSafe(
  file: string,
  args: string[],
  opts: RunOptions = {},
): string | null {
  try {
    return run(file, args, opts);
  } catch {
    return null;
  }
}

/** Run with inherited stdio (CLI only — never from the MCP server). */
export function runLive(file: string, args: string[], opts: RunOptions = {}): void {
  try {
    execFileSync(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (err) {
    throw toCommandError(file, args, err);
  }
}

/**
 * Bounded output collector: keeps only the last ~64 KiB / 200 lines so a
 * chatty `docker compose up --build` cannot grow memory without bound.
 */
class Tail {
  private text = "";

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > TAIL_BYTES * 2) {
      this.text = this.text.slice(-TAIL_BYTES);
    }
  }

  value(): string {
    const bounded = this.text.length > TAIL_BYTES ? this.text.slice(-TAIL_BYTES) : this.text;
    const lines = bounded.split("\n");
    return lines.slice(-TAIL_LINES).join("\n");
  }
}

export interface RunAsyncOptions extends RunOptions {
  /** Inherit stdio (CLI) instead of capturing bounded tails (MCP). */
  live?: boolean;
  /**
   * Abort the command (SIGTERM) when this signal fires — e.g. an MCP
   * client cancelling a long `compose up --build`.
   */
  signal?: AbortSignal;
  /** Called with each complete line of captured output (not with `live`). */
  onLine?: (line: string) => void;
}

/** Splits streamed chunks into complete lines for `onLine`. */
function lineSplitter(onLine: ((line: string) => void) | undefined): (chunk: string) => void {
  if (!onLine) return () => {};
  let partial = "";
  return (chunk: string) => {
    const parts = (partial + chunk).split(/\r?\n|\r/);
    partial = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) onLine(line);
  };
}

/**
 * Spawn-based variant that never blocks the event loop (the MCP server keeps
 * answering while `docker compose up --build` runs). With `live`, stdio is
 * inherited (CLI); otherwise output is captured as bounded tails.
 * Resolves on exit code 0, rejects with CommandError otherwise (including
 * when `signal` aborts it or `timeoutMs` elapses).
 */
export function runAsync(
  file: string,
  args: string[],
  opts: RunAsyncOptions = {},
): Promise<RunResult> {
  const command = displayCommand(file, args);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CommandError(command, null, "", "Command cancelled"));
      return;
    }
    const stdout = new Tail();
    const stderr = new Tail();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: opts.live ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(toCommandError(file, args, err));
      return;
    }

    let stopReason: string | null = null;
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
    };
    const onAbort = () => stop("Command cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => stop(timeoutReason(opts.timeoutMs)), opts.timeoutMs)
        : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const outLines = lineSplitter(opts.onLine);
    const errLines = lineSplitter(opts.onLine);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout.push(chunk);
      outLines(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
      errLines(chunk);
    });

    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toCommandError(file, args, err));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = { code: code ?? -1, stdout: stdout.value(), stderr: stderr.value() };
      if (stopReason) {
        reject(new CommandError(command, null, result.stderr, stopReason));
      } else if (code === 0) {
        resolve(result);
      } else if (code === null) {
        reject(new CommandError(command, null, result.stderr, `Command killed by ${signal ?? "signal"}`));
      } else {
        reject(new CommandError(command, code, result.stderr || result.stdout));
      }
    });
  });
}
