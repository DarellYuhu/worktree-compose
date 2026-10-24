import chalk from "chalk";

/**
 * Where operations report progress. The CLI prints to the terminal; the MCP
 * server collects lines and returns them as tool output — it must never write
 * to stdout, which carries the JSON-RPC stream.
 */
export interface Reporter {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  header(msg: string): void;
}

let logStream: "stdout" | "stderr" = "stdout";

/**
 * Route all human-oriented output to stderr. `wtc mcp` calls this at startup
 * so nothing but the transport can ever reach stdout.
 */
export function setLogStream(stream: "stdout" | "stderr"): void {
  logStream = stream;
}

/** Print a plain line (tables, file lists) on the current log stream. */
export function print(...parts: unknown[]): void {
  if (logStream === "stderr") {
    console.error(...parts);
  } else {
    console.log(...parts);
  }
}

export function info(msg: string): void {
  print(chalk.blue("ℹ"), msg);
}

export function success(msg: string): void {
  print(chalk.green("✔"), msg);
}

export function warn(msg: string): void {
  print(chalk.yellow("⚠"), msg);
}

export function error(msg: string): void {
  console.error(chalk.red("✖"), msg);
}

export function header(msg: string): void {
  print(chalk.bold.cyan(`\n=== ${msg} ===`));
}

/** Terminal reporter — the CLI's behavior. */
export const consoleReporter: Reporter = {
  info: (msg) => info(msg),
  success: (msg) => success(msg),
  warn: (msg) => warn(msg),
  error: (msg) => error(msg),
  header: (msg) => header(msg),
};

/** Reporter that records plain-text lines (MCP tool output, tests). */
export class CollectingReporter implements Reporter {
  lines: string[] = [];

  /** `onLine` sees each line as it is recorded (MCP progress notifications). */
  constructor(private readonly onLine?: (line: string) => void) {}

  private push(line: string): void {
    this.lines.push(line);
    this.onLine?.(line);
  }

  info(msg: string): void {
    this.push(msg);
  }

  success(msg: string): void {
    this.push(`✔ ${msg}`);
  }

  warn(msg: string): void {
    this.push(`⚠ ${msg}`);
  }

  error(msg: string): void {
    this.push(`✖ ${msg}`);
  }

  header(msg: string): void {
    this.push(`=== ${msg} ===`);
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** Reporter that discards everything. */
export const silentReporter: Reporter = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  header: () => {},
};
