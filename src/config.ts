import fs from "node:fs";
import path from "node:path";

export interface WtcConfig {
  /** JSON Schema reference for editor completion; ignored by wtc. */
  $schema?: string;
  /** Extra repo-relative files/directories copied from the main checkout on start. */
  sync?: string[];
  envOverrides?: Record<string, string>;
  /**
   * Env filename to copy from the main checkout into each worktree and inject
   * port overrides into. Workspace targets use the same name. Defaults to `.env`.
   */
  envFile?: string;
  /**
   * Monorepo workspaces (by package name, directory name, or path) that also
   * receive env file copies + port override injection, in addition to the repo
   * root. Empty/omitted means root-only (the zero-config behavior).
   */
  workspaces?: string[];
  /**
   * Per-workspace env overrides, keyed by workspace name (or directory).
   * Values support `${VAR}` interpolation against allocated port values.
   */
  workspaceEnvOverrides?: Record<string, Record<string, string>>;
  /**
   * Per-worktree-index port stride. Allocated port =
   * 20000 + defaultPort + worktreeIndex * portStride. Defaults to 1.
   * Raise it (e.g. 100) when a project exposes clustered default host
   * ports so that adjacent worktrees do not collide across services.
   */
  portStride?: number;
  /**
   * Compose command to run instead of auto-detection, e.g. `"podman compose"`
   * or `["docker-compose"]`. `WTC_COMPOSE_COMMAND` takes precedence.
   */
  composeCommand?: string | string[];
}

function readJsonFile(file: string): unknown {
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface LoadedConfig {
  config: WtcConfig;
  /** File the config came from, or `null` for the zero-config default. */
  source: string | null;
}

/** Load `.wtcrc.json`, else `package.json#wtc`, recording which file was used. */
export function loadConfigWithSource(repoRoot: string): LoadedConfig {
  const rcPath = path.join(repoRoot, ".wtcrc.json");
  if (fs.existsSync(rcPath)) {
    const doc = readJsonFile(rcPath);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`Invalid config in ${rcPath}: expected a JSON object.`);
    }
    return { config: doc as WtcConfig, source: rcPath };
  }

  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = readJsonFile(pkgPath) as Record<string, unknown> | null;
    if (pkg && typeof pkg.wtc === "object" && pkg.wtc !== null && !Array.isArray(pkg.wtc)) {
      return { config: pkg.wtc as WtcConfig, source: `${pkgPath}#wtc` };
    }
  }

  return { config: {}, source: null };
}

export function loadConfig(repoRoot: string): WtcConfig {
  return loadConfigWithSource(repoRoot).config;
}
