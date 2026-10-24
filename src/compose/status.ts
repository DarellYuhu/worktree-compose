import path from "node:path";
import { CommandError, ENGINE_PROBE_TIMEOUT_MS, run, runSafe } from "../utils/exec.js";
import { cliCall, composeArgs, composeBin } from "./engine.js";
import type { ComposeEngine } from "./engine.js";

export interface StackState {
  running: number;
  total: number;
}

export const PROJECT_LABELS = ["com.docker.compose.project", "io.podman.compose.project"];
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const ONEOFF_LABEL = "com.docker.compose.oneoff";

/**
 * Parse Docker's `Labels` string (`k=v,k=v`, in random order). Values may
 * themselves contain commas (e.g. `config_files=/a.yml,/b.yml`), so only
 * split on a comma that starts a new `key=`. A key starts with a letter and
 * may contain `/` (Docker Desktop adds `desktop.docker.io/binds/0/Source`
 * to every container with a bind mount); a value such as `/my dir/a=b.yml`
 * or `C:\x=y.yml` after a comma starts with `/` or holds `:` / `\`, so it
 * is never mistaken for a new key.
 */
export function parseLabelString(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const pair of labels.split(/,(?=[A-Za-z][A-Za-z0-9_.\/-]*=)/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Case-insensitive field lookup: Docker uses `Labels`/`ID`, Podman `labels`/`Id`. */
export function field(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function labelsOf(container: Record<string, unknown>): Record<string, string> {
  const labels = field(container, "Labels");
  if (typeof labels === "string") return parseLabelString(labels);
  if (labels && typeof labels === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}

/**
 * Parse `--format json` listings (`ps`, `network ls`, `volume ls`): Docker
 * emits NDJSON, Podman one JSON array. Throws when the output is neither.
 */
export function parseJsonListing(output: string): Record<string, unknown>[] {
  const text = output.trim();
  if (!text) return [];
  let entries: unknown[];
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Unexpected JSON listing");
    entries = parsed;
  } else {
    entries = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  return entries.map((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error("Unexpected JSON listing entry");
    return e as Record<string, unknown>;
  });
}

/** A container from `ps -a --format json`, reduced to what wtc needs. */
export interface PsContainer {
  id: string;
  /** First container name. */
  name: string;
  /** Compose project label, or `null` for non-compose containers. */
  project: string | null;
  /** Compose's `project.working_dir` label (the directory compose ran in). */
  workingDir: string | null;
  /** Lower-cased engine state: `running`, `exited`, `created`, `paused`… */
  state: string;
  running: boolean;
  /** `compose run` container (one-off), not part of the stack's services. */
  oneoff: boolean;
}

function firstName(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "").split(",")[0].trim();
}

/**
 * Every container of a `ps -a --format json` listing with what wtc needs per
 * container: compose project, working_dir (to adopt a running stack into
 * the registry), state, and whether it is a one-off. Sibling of
 * `parsePsJson`, which reduces the same listing to per-project counts.
 */
export function parsePsContainers(output: string): PsContainer[] {
  return parseJsonListing(output).map((c) => {
    const labels = labelsOf(c);
    const name = firstName(field(c, "Names"));
    const project = PROJECT_LABELS.map((l) => labels[l]).find(Boolean) ?? null;
    // Docker labels `compose run` containers oneoff=True (services carry
    // oneoff=False, so compare the value); podman-compose names them
    // `<project>_<service>_tmp<n>`.
    const oneoff =
      (labels[ONEOFF_LABEL] ?? "").toLowerCase() === "true" ||
      (project !== null && /_tmp\d+$/.test(name) && Boolean(labels["io.podman.compose.project"]));
    const state = String(field(c, "State") ?? "").toLowerCase();
    return {
      id: String(field(c, "ID") ?? ""),
      name,
      project,
      workingDir: labels[WORKING_DIR_LABEL] || null,
      state,
      running: state === "running",
      oneoff,
    };
  });
}

/**
 * Count running/total containers per compose project from `ps -a --format json`.
 * Docker emits NDJSON with a `Labels` string; Podman emits one JSON array with
 * a `Labels` object. One-off `compose run` containers are not counted: they
 * are not part of the stack, and counting them shows a healthy stack as
 * `partial` until clean. Throws when the output is neither shape.
 */
export function parsePsJson(output: string): Map<string, StackState> {
  return statesOf(parsePsContainers(output));
}

function statesOf(containers: PsContainer[]): Map<string, StackState> {
  const states = new Map<string, StackState>();
  for (const c of containers) {
    if (!c.project || c.oneoff) continue;
    const state = states.get(c.project) ?? { running: 0, total: 0 };
    state.total++;
    if (c.running) state.running++;
    states.set(c.project, state);
  }
  return states;
}

/** One `<cli> ps -a --format json` call (bounded by a timeout). Throws on failure. */
export function listContainers(engine: ComposeEngine): PsContainer[] {
  const [file, args] = cliCall(engine, "ps", "-a", "--format", "json");
  return parsePsContainers(run(file, args, { timeoutMs: ENGINE_PROBE_TIMEOUT_MS }));
}

/** One `<cli> ps -a --format json` call → state per compose project. Throws on failure. */
export function getStackStates(engine: ComposeEngine): Map<string, StackState> {
  return statesOf(listContainers(engine));
}

/**
 * Per-project fallback: `compose -p P ps -q` (running) and `ps -a -q` (total).
 * podman-compose's `ps` accepts only `-q` and always lists every container,
 * so it cannot tell running from stopped: its state is unknown.
 */
export function probeStackDirect(
  engine: ComposeEngine,
  project: string,
  cwd?: string,
): StackState | null {
  if (path.basename(engine.compose[0]) === "podman-compose") return null;
  const count = (out: string | null) =>
    out === null ? null : out.split("\n").filter((l) => l.trim()).length;
  const opts = { cwd, timeoutMs: ENGINE_PROBE_TIMEOUT_MS };
  const running = count(
    runSafe(composeBin(engine), composeArgs(engine, project, "ps", "-q"), opts),
  );
  const total = count(
    runSafe(composeBin(engine), composeArgs(engine, project, "ps", "-a", "-q"), opts),
  );
  if (running === null || total === null) return null;
  return { running, total };
}

/** Answers "what state is project P in?" — `null` means unknown (engine unreachable). */
export interface StackProbe {
  readonly engine: ComposeEngine | null;
  /** Why states are unknown (no engine, daemon down), when they are. */
  readonly problem: string | null;
  state(project: string): StackState | null;
  /**
   * Every container the engine reports (one-offs included, flagged), or
   * `null` when that listing is unavailable (engine down, or unparseable
   * `ps` output — then `problem` is null and states come per project).
   */
  containers(): PsContainer[] | null;
}

/**
 * Lazily fetch stack states once, falling back to per-project compose calls
 * when the `ps` JSON cannot be parsed (older engines, unexpected shapes).
 */
export function createStackProbe(
  engine: ComposeEngine | null,
  engineProblem: string | null = null,
  cwd?: string,
): StackProbe {
  let mode: "pending" | "map" | "fallback" | "unavailable" = engine ? "pending" : "unavailable";
  let states = new Map<string, StackState>();
  let listed: PsContainer[] = [];
  let problem: string | null = engine ? null : engineProblem;
  const cache = new Map<string, StackState | null>();

  const load = () => {
    if (mode !== "pending" || !engine) return;
    try {
      listed = listContainers(engine);
      states = statesOf(listed);
      mode = "map";
    } catch (err) {
      if (err instanceof CommandError) {
        // The CLI itself failed (daemon down, timed out, binary missing): states are unknown.
        mode = "unavailable";
        const last = err.message.split("\n").slice(-1)[0];
        problem =
          `Container engine not reachable (${engine.cliArgv.join(" ")} ps failed: ${last}). ` +
          `Start it, or set WTC_COMPOSE_COMMAND to use another engine (e.g. "podman compose").`;
      } else {
        // Unparseable output: ask compose per project instead.
        mode = "fallback";
      }
    }
  };

  return {
    engine,
    get problem() {
      load();
      return problem;
    },
    state(project: string): StackState | null {
      load();
      if (mode === "unavailable") return null;
      if (mode === "map") return states.get(project) ?? { running: 0, total: 0 };
      if (!cache.has(project)) cache.set(project, probeStackDirect(engine!, project, cwd));
      return cache.get(project) ?? null;
    },
    containers(): PsContainer[] | null {
      load();
      return mode === "map" ? listed : null;
    },
  };
}

export type StackStatus = "up" | "partial" | "exited" | "down" | "?";

export function stackStatus(state: StackState | null): StackStatus {
  if (!state) return "?";
  if (state.total === 0) return "down";
  if (state.running === state.total) return "up";
  if (state.running === 0) return "exited";
  return "partial";
}
