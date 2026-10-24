import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripOverrideBlock,
  buildOverrideBlock,
  injectPortOverrides,
  prepareEnvFile,
  findEnvSource,
} from "../../src/sync/env.js";
import type { EnvTarget } from "../../src/sync/env.js";
import type { PortAllocation } from "../../src/ports/types.js";

const allocations: PortAllocation[] = [
  {
    serviceName: "backend",
    envVar: "BACKEND_PORT",
    port: 28001,
    containerPort: 8000,
  },
  {
    serviceName: "frontend",
    envVar: "FRONTEND_PORT",
    port: 25174,
    containerPort: 5173,
  },
];

describe("buildOverrideBlock", () => {
  it("creates a delimited block with port assignments", () => {
    const block = buildOverrideBlock(allocations);
    expect(block).toContain("# --- wtc port overrides ---");
    expect(block).toContain("BACKEND_PORT=28001");
    expect(block).toContain("FRONTEND_PORT=25174");
    expect(block).toContain("# --- end wtc ---");
  });

  it("interpolates envOverrides with port values", () => {
    const block = buildOverrideBlock(allocations, {
      VITE_API_URL: "http://localhost:${BACKEND_PORT}",
    });
    expect(block).toContain("VITE_API_URL=http://localhost:28001");
  });

  it("handles multiple envOverrides", () => {
    const block = buildOverrideBlock(allocations, {
      VITE_API_URL: "http://localhost:${BACKEND_PORT}",
      VITE_APP_URL: "http://localhost:${FRONTEND_PORT}",
    });
    expect(block).toContain("VITE_API_URL=http://localhost:28001");
    expect(block).toContain("VITE_APP_URL=http://localhost:25174");
  });
});

describe("stripOverrideBlock", () => {
  it("removes the override block from content", () => {
    const content = [
      "FOO=bar",
      "",
      "# --- wtc port overrides ---",
      "BACKEND_PORT=28001",
      "# --- end wtc ---",
      "",
    ].join("\n");

    const result = stripOverrideBlock(content);
    expect(result).toContain("FOO=bar");
    expect(result).not.toContain("BACKEND_PORT");
    expect(result).not.toContain("wtc port overrides");
  });

  it("returns content unchanged when no block exists", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    expect(stripOverrideBlock(content)).toBe(content);
  });

  it("handles content with only the block", () => {
    const content = [
      "# --- wtc port overrides ---",
      "X=1",
      "# --- end wtc ---",
    ].join("\n");

    const result = stripOverrideBlock(content);
    expect(result.trim()).toBe("");
  });
});

describe("injectPortOverrides", () => {
  let tmpDir: string;

  function read(name: string): string {
    return fs.readFileSync(path.join(tmpDir, name), "utf-8");
  }

  function write(name: string, content: string): string {
    const full = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-env-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rewrites existing keys in place and preserves comments/ordering", () => {
    const file = write(
      ".env.development",
      [
        "# Database",
        "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres",
        "NODE_ENV=local",
        "PORT=8080",
        "",
      ].join("\n"),
    );

    const result = injectPortOverrides(file, allocations, {
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres",
      PORT: "${BACKEND_PORT}",
    });

    expect(result.rewritten).toEqual(["DATABASE_URL", "PORT"]);
    expect(result.appended).toEqual(["BACKEND_PORT", "FRONTEND_PORT"]);

    const content = read(".env.development");
    expect(content).toContain("# Database");
    expect(content).toContain("NODE_ENV=local");
    expect(content).not.toContain(":5433");
    expect(content).toContain("BACKEND_PORT=28001");
    // Unprovided ${POSTGRES_PORT} stays unresolved rather than being dropped.
    expect(content).toContain(
      "DATABASE_URL=postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/postgres",
    );
  });

  it("resolves interpolated values into existing keys", () => {
    const file = write(
      "apps/server/.env.development",
      "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres\n",
    );

    const result = injectPortOverrides(file, allocations, {
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5432/postgres",
    });

    expect(result.rewritten).toEqual(["DATABASE_URL"]);
    expect(read("apps/server/.env.development")).toContain(
      "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres",
    );
  });

  it("appends missing keys in an idempotent block", () => {
    const file = write("dirty/.env", "NODE_ENV=local\n");

    injectPortOverrides(file, allocations, {
      VITE_API_URL: "http://localhost:${FRONTEND_PORT}",
    });
    const first = read("dirty/.env");

    injectPortOverrides(file, allocations, {
      VITE_API_URL: "http://localhost:${FRONTEND_PORT}",
    });
    const second = read("dirty/.env");

    expect(first).toBe(second);
    expect(second.match(/# --- wtc port overrides ---/g)).toHaveLength(1);
    expect(second).toContain("NODE_ENV=local");
    expect(second).toContain("VITE_API_URL=http://localhost:25174");
  });

  it("rewrites allocation keys already present in the file", () => {
    const file = write(".env", "BACKEND_PORT=8000\n");

    const result = injectPortOverrides(file, allocations);

    expect(result.rewritten).toEqual(["BACKEND_PORT"]);
    expect(read(".env")).toContain("BACKEND_PORT=28001");
    expect(read(".env")).not.toContain("BACKEND_PORT=8000");
  });

  it("keeps values containing $ intact", () => {
    const file = write(".env", "SECRET=old\n");

    injectPortOverrides(file, allocations, {
      SECRET: "pa$$&word$1",
    });

    expect(read(".env")).toContain("SECRET=pa$$&word$1");
  });

  it("does not let a previous run's block mask in-place rewriting", () => {
    const file = write(".env", "PORT=8080\n");
    injectPortOverrides(file, allocations, { PORT: "${BACKEND_PORT}" });

    injectPortOverrides(file, allocations, { PORT: "9999" });

    const content = read(".env");
    expect(content).toContain("PORT=9999");
    expect(content).not.toMatch(/^PORT=28001$/m);
  });

  it("writes no block when every entry is rewritten in place", () => {
    const file = write(".env", "BACKEND_PORT=8000\nFRONTEND_PORT=5173\n");

    injectPortOverrides(file, allocations);

    const content = read(".env");
    expect(content).not.toContain("wtc port overrides");
    expect(content).toBe("BACKEND_PORT=28001\nFRONTEND_PORT=25174\n");
  });
});

describe("prepareEnvFile", () => {
  let repoRoot: string;
  let wtPath: string;

  function writeRepo(rel: string, content: string): void {
    const full = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function target(dir: string, envFileName = ".env.development"): EnvTarget {
    return { dir, label: dir || "root", envFileName };
  }

  beforeEach(() => {
    const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-prepare-")),
    );
    repoRoot = path.join(base, "main");
    wtPath = path.join(base, "wt");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(wtPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(repoRoot), { recursive: true });
  });

  it("copies a workspace env file to the same relative path", () => {
    writeRepo("apps/server/.env.development", "DATABASE_URL=main\n");

    const dest = prepareEnvFile(repoRoot, wtPath, target("apps/server"));

    expect(dest).toBe(path.join(wtPath, "apps/server/.env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("DATABASE_URL=main\n");
  });

  it("falls back to .env.example per directory", () => {
    writeRepo("apps/server/.env.example", "DATABASE_URL=example\n");

    const dest = prepareEnvFile(repoRoot, wtPath, target("apps/server"));

    expect(dest).toBe(path.join(wtPath, "apps/server/.env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("DATABASE_URL=example\n");
  });

  it("skips a workspace with no env file and no example", () => {
    expect(prepareEnvFile(repoRoot, wtPath, target("apps/empty"))).toBeNull();
    expect(fs.existsSync(path.join(wtPath, "apps/empty"))).toBe(false);
  });

  it("creates an empty root env file when nothing exists", () => {
    const dest = prepareEnvFile(repoRoot, wtPath, target(""));

    expect(dest).toBe(path.join(wtPath, ".env.development"));
    expect(fs.readFileSync(dest!, "utf-8")).toBe("");
  });

  it("prefers the configured filename over .env.example", () => {
    writeRepo("apps/server/.env.development", "real\n");
    writeRepo("apps/server/.env.example", "example\n");

    expect(findEnvSource(repoRoot, target("apps/server"))).toBe(
      path.join(repoRoot, "apps/server/.env.development"),
    );
  });
});

describe("COMPOSE_PROJECT_NAME injection (#2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-project-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function file(name: string, content: string): string {
    const full = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  it("writes the project name first in the wtc block for the root target", () => {
    const env = file(".env", "NODE_ENV=local\n");
    const result = injectPortOverrides(env, allocations, undefined, {
      projectName: "myapp-wt-1-feat",
      writeProjectName: true,
    });

    expect(result.appended[0]).toBe("COMPOSE_PROJECT_NAME");
    const content = fs.readFileSync(env, "utf-8");
    expect(content).toContain(
      "# --- wtc port overrides ---\nCOMPOSE_PROJECT_NAME=myapp-wt-1-feat\nBACKEND_PORT=28001",
    );
  });

  it("rewrites an existing COMPOSE_PROJECT_NAME in place", () => {
    const env = file(".env", "COMPOSE_PROJECT_NAME=myapp\nNODE_ENV=local\n");
    const result = injectPortOverrides(env, allocations, undefined, {
      projectName: "myapp-wt-2-x",
      writeProjectName: true,
    });

    expect(result.rewritten).toEqual(["COMPOSE_PROJECT_NAME"]);
    const content = fs.readFileSync(env, "utf-8");
    expect(content.startsWith("COMPOSE_PROJECT_NAME=myapp-wt-2-x\nNODE_ENV=local\n")).toBe(true);
    expect(content.match(/COMPOSE_PROJECT_NAME=/g)).toHaveLength(1);
  });

  it("does not write it for workspace targets but still interpolates it", () => {
    const env = file("apps/api/.env", "");
    injectPortOverrides(
      env,
      allocations,
      { STACK: "stack-${COMPOSE_PROJECT_NAME}", API: "http://localhost:${BACKEND_PORT}" },
      { projectName: "myapp-wt-1-feat", writeProjectName: false },
    );

    const content = fs.readFileSync(env, "utf-8");
    expect(content).not.toContain("COMPOSE_PROJECT_NAME=");
    expect(content).toContain("STACK=stack-myapp-wt-1-feat");
    expect(content).toContain("API=http://localhost:28001");
  });

  it("interpolates ${COMPOSE_PROJECT_NAME} in root overrides", () => {
    const block = buildOverrideBlock(allocations, {
      NETWORK: "${COMPOSE_PROJECT_NAME}_default",
    });
    // Without a project name the placeholder is left untouched...
    expect(block).toContain("NETWORK=${COMPOSE_PROJECT_NAME}_default");

    const env = file(".env", "");
    injectPortOverrides(
      env,
      allocations,
      { NETWORK: "${COMPOSE_PROJECT_NAME}_default" },
      { projectName: "p1", writeProjectName: true },
    );
    // ...and resolved when there is one.
    expect(fs.readFileSync(env, "utf-8")).toContain("NETWORK=p1_default");
  });
});

describe("env files and symlinks (untrusted worktree branches)", () => {
  let base: string;
  let repoRoot: string;
  let wtPath: string;
  const root: EnvTarget = { dir: "", label: "root", envFileName: ".env" };

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-envlink-")));
    repoRoot = path.join(base, "main");
    wtPath = path.join(base, "wt");
    fs.mkdirSync(repoRoot);
    fs.mkdirSync(wtPath);
    fs.writeFileSync(path.join(repoRoot, ".env"), "SECRET_TOKEN=main-secret\nREDIS_PORT=6391\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function startLike(target: EnvTarget = root): { envPath: string | null; warnings: string[] } {
    const warnings: string[] = [];
    const envPath = prepareEnvFile(repoRoot, wtPath, target, warnings);
    if (envPath) {
      injectPortOverrides(envPath, allocations, { REDIS_PORT: "${BACKEND_PORT}" }, {
        projectName: "main-wt-1-pr",
        writeProjectName: target.dir === "",
      });
    }
    return { envPath, warnings };
  }

  it.each([
    ["relative", "../victim.txt"],
    ["absolute", "ABS"],
  ])("never writes main's env through a %s symlink planted at the env path", (_kind, link) => {
    const victim = path.join(base, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    fs.symlinkSync(link === "ABS" ? victim : link, path.join(wtPath, ".env"));

    const { envPath, warnings } = startLike();

    expect(fs.readFileSync(victim, "utf-8")).toBe("precious\n");
    expect(envPath).toBe(path.join(wtPath, ".env"));
    expect(fs.lstatSync(envPath!).isFile()).toBe(true);
    expect(fs.readFileSync(envPath!, "utf-8")).toContain("COMPOSE_PROJECT_NAME=main-wt-1-pr");
    expect(warnings.join("\n")).toMatch(/\.env in the worktree was a symlink; replaced it with a regular file/);
  });

  it("leaves main's .env untouched when the worktree's .env links to it", () => {
    const original = fs.readFileSync(path.join(repoRoot, ".env"), "utf-8");
    fs.symlinkSync("../main/.env", path.join(wtPath, ".env"));

    startLike();

    expect(fs.readFileSync(path.join(repoRoot, ".env"), "utf-8")).toBe(original);
    const copy = fs.readFileSync(path.join(wtPath, ".env"), "utf-8");
    expect(copy).toContain("SECRET_TOKEN=main-secret");
    expect(copy).toContain("REDIS_PORT=28001");
  });

  it("refuses a workspace directory that is a symlink out of the worktree", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(repoRoot, "apps/server"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps/server/.env"), "SERVER_SECRET=1\n");
    fs.mkdirSync(path.join(wtPath, "apps"));
    fs.symlinkSync("../../outside", path.join(wtPath, "apps/server"));

    const { envPath, warnings } = startLike({ dir: "apps/server", label: "workspace server", envFileName: ".env" });

    expect(envPath).toBeNull();
    expect(warnings.join("\n")).toMatch(/resolves outside the worktree/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("never treats the env source itself as a worktree env file", () => {
    const warnings: string[] = [];
    expect(prepareEnvFile(repoRoot, repoRoot, root, warnings)).toBeNull();
    expect(warnings.join("\n")).toMatch(/main checkout's own env file/);
    expect(fs.readFileSync(path.join(repoRoot, ".env"), "utf-8")).toBe("SECRET_TOKEN=main-secret\nREDIS_PORT=6391\n");
  });

  it("injectPortOverrides replaces a symlink instead of writing through it", () => {
    const victim = path.join(base, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    fs.symlinkSync(victim, path.join(wtPath, ".env"));
    const result = injectPortOverrides(path.join(wtPath, ".env"), allocations, undefined, { root: wtPath });
    expect(fs.readFileSync(victim, "utf-8")).toBe("precious\n");
    expect(fs.lstatSync(path.join(wtPath, ".env")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(wtPath, ".env"), "utf-8")).toContain("BACKEND_PORT=28001");
    expect(result.warnings.join("\n")).toMatch(/was a symlink; replaced it/);
  });

  it("injectPortOverrides refuses a directory that resolves outside its root", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, ".env"), "KEEP=1\n");
    fs.symlinkSync("../outside", path.join(wtPath, "api"));
    expect(() =>
      injectPortOverrides(path.join(wtPath, "api/.env"), allocations, undefined, { root: wtPath }),
    ).toThrow(/resolves outside the worktree/);
    expect(fs.readFileSync(path.join(outside, ".env"), "utf-8")).toBe("KEEP=1\n");
  });

  it("a symlinked workspace directory that stays inside the worktree is fine", () => {
    fs.mkdirSync(path.join(repoRoot, "apps/api"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps/api/.env"), "API=1\n");
    fs.mkdirSync(path.join(wtPath, "packages/api"), { recursive: true });
    fs.mkdirSync(path.join(wtPath, "apps"));
    fs.symlinkSync("../packages/api", path.join(wtPath, "apps/api"));

    const { envPath, warnings } = startLike({ dir: "apps/api", label: "workspace api", envFileName: ".env" });

    expect(warnings).toEqual([]);
    expect(envPath).toBe(path.join(wtPath, "apps/api/.env"));
    expect(fs.readFileSync(path.join(wtPath, "packages/api/.env"), "utf-8")).toContain("API=1");
  });

  it("refuses a workspace directory behind a dangling symlink", () => {
    fs.mkdirSync(path.join(repoRoot, "apps/server"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps/server/.env"), "S=1\n");
    fs.mkdirSync(path.join(wtPath, "apps"));
    fs.symlinkSync(path.join(base, "not-yet"), path.join(wtPath, "apps/server"));

    const { envPath, warnings } = startLike({ dir: "apps/server", label: "workspace server", envFileName: ".env" });

    expect(envPath).toBeNull();
    expect(warnings.join("\n")).toMatch(/resolves outside the worktree/);
    expect(fs.existsSync(path.join(base, "not-yet"))).toBe(false);
  });

  it("never rewrites the env source through a hard link (self-copy guard)", () => {
    const original = fs.readFileSync(path.join(repoRoot, ".env"), "utf-8");
    fs.linkSync(path.join(repoRoot, ".env"), path.join(wtPath, ".env"));

    const { envPath, warnings } = startLike();

    expect(envPath).toBeNull();
    expect(warnings.join("\n")).toMatch(/main checkout's own env file/);
    expect(fs.readFileSync(path.join(repoRoot, ".env"), "utf-8")).toBe(original);
    expect(() =>
      injectPortOverrides(path.join(wtPath, ".env"), allocations, undefined, {
        root: wtPath,
        source: path.join(repoRoot, ".env"),
      }),
    ).toThrow(/env source file/);
    expect(fs.readFileSync(path.join(repoRoot, ".env"), "utf-8")).toBe(original);
  });

  it("replaces a FIFO at the env path instead of blocking on it", () => {
    const fifo = path.join(wtPath, ".env");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this platform
    }
    const { envPath, warnings } = startLike();
    expect(fs.lstatSync(envPath!).isFile()).toBe(true);
    expect(warnings.join("\n")).toMatch(/was a special file; replaced it/);
  });

  it("skips a directory sitting at the env path", () => {
    fs.mkdirSync(path.join(wtPath, ".env"));
    fs.writeFileSync(path.join(wtPath, ".env/keep"), "x");
    const { envPath, warnings } = startLike();
    expect(envPath).toBeNull();
    expect(warnings.join("\n")).toMatch(/it is a directory in the worktree/);
    expect(fs.existsSync(path.join(wtPath, ".env/keep"))).toBe(true);
  });
});
