import path from "node:path";
import { ENGINE_PROBE_TIMEOUT_MS, runSafe } from "../utils/exec.js";
import type { WtcConfig } from "../config.js";

export interface ComposeEngine {
  /** argv prefix for compose, e.g. ["docker","compose"], ["podman","compose"], ["docker-compose"], ["podman-compose"] */
  compose: string[];
  /** Container CLI flavor used for sweeps/status: "docker" | "podman". */
  cli: "docker" | "podman";
  /**
   * argv prefix for container-CLI calls (`ps`, `info`, sweeps): the binary
   * plus any global flags that preceded `compose` (`docker --context colima
   * compose` → `["docker", "--context", "colima"]`), so status and sweeps
   * talk to the same daemon compose does.
   */
  cliArgv: string[];
  /** Human label, e.g. "docker compose". */
  label: string;
}

/** Returns true when `<argv> version` runs successfully. */
export type EngineProbe = (argv: string[]) => boolean;

/** Returns true when the container daemon behind `cliArgv` answers. */
export type DaemonProbe = (cliArgv: string[]) => boolean;

/** Auto-detection order: Compose v2 plugin first, then Podman, then standalone binaries. */
export const ENGINE_CANDIDATES: string[][] = [
  ["docker", "compose"],
  ["podman", "compose"],
  ["docker-compose"],
  ["podman-compose"],
];

export const NO_ENGINE_MESSAGE =
  `No container compose tool found. Install Docker with Compose v2, or Podman ` +
  `(podman compose / podman-compose), or set WTC_COMPOSE_COMMAND / "composeCommand".`;

const defaultProbe: EngineProbe = (argv) =>
  runSafe(argv[0], [...argv.slice(1), "version"], { timeoutMs: ENGINE_PROBE_TIMEOUT_MS }) !== null;

/**
 * `<cliArgv> info`: talks to the daemon (or podman machine), so it exits
 * non-zero when that is down — unlike `version`, which succeeds client-only.
 */
export function daemonCheckArgs(engine: Pick<ComposeEngine, "cliArgv">): [string, string[]] {
  return cliCall(engine, "info");
}

const defaultDaemonProbe: DaemonProbe = (cliArgv) => {
  const [file, args] = daemonCheckArgs({ cliArgv });
  return runSafe(file, args, { timeoutMs: ENGINE_PROBE_TIMEOUT_MS }) !== null;
};

let detected: ComposeEngine | null = null;

export function engineFromArgv(argv: string[]): ComposeEngine {
  const cli = path.basename(argv[0]).includes("podman") ? "podman" : "docker";
  // `<bin> [global flags…] compose`: everything before the `compose`
  // subcommand also applies to plain container-CLI calls.
  const sub = argv.indexOf("compose", 1);
  const cliArgv = sub > 0 ? argv.slice(0, sub) : [cli];
  return { compose: argv, cli, cliArgv, label: argv.join(" ") };
}

function splitCommand(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function fromConfig(value: unknown, source: string): string[] {
  const argv =
    typeof value === "string"
      ? splitCommand(value)
      : Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[]).filter((v) => v.trim() !== "")
        : null;
  if (!argv || argv.length === 0) {
    throw new Error(
      `Invalid ${source}: expected a command such as "docker compose" or ["podman", "compose"].`,
    );
  }
  return argv;
}

/** True when `argv` is exactly one of the known compose commands. */
export function isKnownComposeCommand(argv: string[]): boolean {
  return ENGINE_CANDIDATES.some(
    (c) => c.length === argv.length && c.every((part, i) => part === argv[i]),
  );
}

/**
 * Pick the compose command: `WTC_COMPOSE_COMMAND`, then config
 * `composeCommand`, then auto-detection (cached per process). Resolved
 * lazily — only commands that touch containers need it, so `promote` works
 * without Docker installed.
 *
 * `composeCommand` comes from a file committed to the repository, so it may
 * only *choose* one of the known compose tools: an arbitrary argv there
 * would let a cloned repo run any program — even from `wtc doctor` /
 * `wtc_doctor`, which agents treat as read-only — and extra flags such as
 * `docker --config ./dir compose` load repo-shipped CLI plugins. Custom
 * commands belong in `WTC_COMPOSE_COMMAND`, which the user controls.
 *
 * Auto-detection finds the installed candidates (`version` succeeds,
 * which needs no daemon). When more than one is installed it prefers the
 * first whose daemon answers (`info`), so a quit Docker Desktop does not
 * shadow a running Podman; when none answers — or only one is installed —
 * it takes the first installed one.
 */
export function resolveEngine(
  config: WtcConfig,
  env: NodeJS.ProcessEnv = process.env,
  probe?: EngineProbe,
  daemonProbe?: DaemonProbe,
): ComposeEngine {
  const fromEnv = env.WTC_COMPOSE_COMMAND;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return engineFromArgv(fromConfig(fromEnv, "WTC_COMPOSE_COMMAND"));
  }
  if (config.composeCommand !== undefined) {
    const argv = fromConfig(config.composeCommand, `"composeCommand" config`);
    if (!isKnownComposeCommand(argv)) {
      throw new Error(
        `"composeCommand" ${JSON.stringify(argv.join(" "))} is not a known compose tool ` +
          `(${ENGINE_CANDIDATES.map((c) => c.join(" ")).join(", ")}). ` +
          `Repository config may only choose one of those; to run a custom command, ` +
          `set WTC_COMPOSE_COMMAND in your environment.`,
      );
    }
    return engineFromArgv(argv);
  }

  const injected = probe !== undefined || daemonProbe !== undefined;
  if (!injected && detected) return detected;
  const check = probe ?? defaultProbe;
  // An injected version probe without a daemon probe means "daemons are up".
  const daemonProbeFn = daemonProbe ?? (probe ? () => true : defaultDaemonProbe);

  const installed = ENGINE_CANDIDATES.filter((candidate) => check(candidate)).map(engineFromArgv);
  if (installed.length === 0) throw new Error(NO_ENGINE_MESSAGE);
  let chosen = installed[0];
  if (installed.length > 1) {
    // `docker compose` and `docker-compose` share a daemon: ask it once.
    const answers = new Map<string, boolean>();
    const daemonUp = (engine: ComposeEngine) => {
      const key = engine.cliArgv.join("\0");
      if (!answers.has(key)) answers.set(key, daemonProbeFn(engine.cliArgv));
      return answers.get(key) === true;
    };
    chosen = installed.find(daemonUp) ?? installed[0];
  }
  if (!injected) detected = chosen;
  return chosen;
}

/** Forget the cached auto-detected engine (tests). */
export function resetEngineCache(): void {
  detected = null;
}

/** Arguments (after `engine.compose[0]`) for a compose call on `project`. */
export function composeArgs(
  engine: ComposeEngine,
  project: string,
  ...rest: string[]
): string[] {
  return [...engine.compose.slice(1), "-p", project, ...rest];
}

/** The executable for compose calls. */
export function composeBin(engine: ComposeEngine): string {
  return engine.compose[0];
}

/** `[file, args]` for a container-CLI call (`ps`, `volume ls`, …) on the engine's daemon. */
export function cliCall(engine: Pick<ComposeEngine, "cliArgv">, ...args: string[]): [string, string[]] {
  return [engine.cliArgv[0], [...engine.cliArgv.slice(1), ...args]];
}

/** True for the Compose v2 plugin (`docker compose`, `podman compose`). */
export function isComposePlugin(engine: ComposeEngine): boolean {
  return engine.compose.length >= 2 && engine.compose.includes("compose", 1);
}
