import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDockerfiles, syncWorktreeFiles } from "../../src/sync/files.js";
import type { ComposeFile } from "../../src/compose/types.js";

function write(dir: string, rel: string, contents: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

function composeFile(repoRoot: string, services: ComposeFile["services"] = []): ComposeFile {
  return {
    services,
    composePath: path.join(repoRoot, "compose.yaml"),
    sourceFiles: [path.join(repoRoot, "compose.yaml")],
    sharedVolumes: [],
    sharedNetworks: [],
  };
}

describe("syncWorktreeFiles", () => {
  let base: string;
  let repoRoot: string;
  let wtPath: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-sync-")));
    repoRoot = path.join(base, "repo");
    wtPath = path.join(base, "wt");
    fs.mkdirSync(wtPath, { recursive: true });
    write(repoRoot, "compose.yaml", "services: {}\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("skips sync entries that are absolute or escape the repo", () => {
    write(base, "secret.txt", "top secret\n");
    write(repoRoot, "config/app.json", "{}\n");

    const warnings = syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), [
      "../secret.txt",
      path.join(base, "secret.txt"),
      "config",
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/Skipping sync entry "..\/secret.txt"/);
    expect(fs.existsSync(path.join(base, "secret.txt"))).toBe(true);
    expect(fs.readdirSync(wtPath).sort()).toEqual(["compose.yaml", "config"]);
    expect(fs.existsSync(path.join(wtPath, "config/app.json"))).toBe(true);
  });

  it("recreates symlinks instead of following them", () => {
    write(base, "outside/credentials", "do not copy\n");
    write(repoRoot, "infra/real.conf", "conf\n");
    fs.symlinkSync(path.join(base, "outside"), path.join(repoRoot, "infra/creds"));
    fs.symlinkSync("real.conf", path.join(repoRoot, "infra/alias.conf"));

    syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["infra"]);

    const creds = path.join(wtPath, "infra/creds");
    expect(fs.lstatSync(creds).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(creds)).toBe(path.join(base, "outside"));
    expect(fs.lstatSync(path.join(wtPath, "infra/alias.conf")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(wtPath, "infra/alias.conf"))).toBe("real.conf");
    expect(fs.readFileSync(path.join(wtPath, "infra/real.conf"), "utf-8")).toBe("conf\n");
  });

  it("does not write through a symlink sitting at the destination", () => {
    const victim = write(base, "victim.txt", "original\n");
    fs.symlinkSync(victim, path.join(wtPath, "compose.yaml"));

    syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot));

    expect(fs.readFileSync(victim, "utf-8")).toBe("original\n");
    expect(fs.lstatSync(path.join(wtPath, "compose.yaml")).isFile()).toBe(true);
  });
});

describe("getDockerfiles", () => {
  const repoRoot = "/repo";
  const src = "/repo/compose.yaml";

  it("resolves absolute dockerfile paths and keeps containment", () => {
    const files = getDockerfiles(
      composeFile(repoRoot, [
        { name: "a", ports: [], sourcePath: src, build: { context: "./a", dockerfile: "/repo/docker/A.Dockerfile" } },
        { name: "b", ports: [], sourcePath: src, build: { context: "./b", dockerfile: "/etc/passwd" } },
        { name: "c", ports: [], sourcePath: src, build: { context: "./c" } },
      ]),
      repoRoot,
    );
    expect(files).toEqual(["docker/A.Dockerfile", "c/Dockerfile"]);
  });

  it("skips remote contexts and inline Dockerfiles", () => {
    const files = getDockerfiles(
      composeFile(repoRoot, [
        { name: "git", ports: [], sourcePath: src, build: { context: "https://github.com/x/y.git#main" } },
        { name: "ssh", ports: [], sourcePath: src, build: { context: "git@github.com:x/y.git" } },
        { name: "inline", ports: [], sourcePath: src, build: { context: ".", inline: true } },
      ]),
      repoRoot,
    );
    expect(files).toEqual([]);
  });
});

describe("syncWorktreeFiles never destroys or writes through worktree directories", () => {
  let base: string;
  let repoRoot: string;
  let wtPath: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-sync2-")));
    repoRoot = path.join(base, "repo");
    wtPath = path.join(base, "wt");
    fs.mkdirSync(wtPath, { recursive: true });
    write(repoRoot, "compose.yaml", "services: {}\n");
    write(base, "datasets/big.csv", "1,2\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps a real worktree directory where main has a symlink (top-level entry)", () => {
    fs.symlinkSync("../datasets", path.join(repoRoot, "data"));
    write(wtPath, "data/fixtures.json", "{}\n");

    const warnings = syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["data"]);

    expect(fs.lstatSync(path.join(wtPath, "data")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(wtPath, "data/fixtures.json"), "utf-8")).toBe("{}\n");
    expect(warnings.join("\n")).toMatch(/Skipping sync of data: it is a symlink in the main checkout but a directory/);
  });

  it("keeps a real worktree directory where main has a symlink (nested entry)", () => {
    write(repoRoot, "config/real/x.conf", "x\n");
    fs.symlinkSync("real", path.join(repoRoot, "config/local"));
    write(wtPath, "config/local/mine.conf", "mine\n");

    const warnings = syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["config"]);

    expect(fs.readFileSync(path.join(wtPath, "config/local/mine.conf"), "utf-8")).toBe("mine\n");
    expect(warnings.join("\n")).toMatch(/Skipping sync of config\/local/);
  });

  it("replaces a symlink that points elsewhere, and leaves an identical one alone", () => {
    fs.symlinkSync("../datasets", path.join(repoRoot, "data"));
    fs.symlinkSync("../old", path.join(wtPath, "data"));
    syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["data"]);
    expect(fs.readlinkSync(path.join(wtPath, "data"))).toBe("../datasets");
    expect(syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["data"])).toEqual([]);
  });

  it("does not write through a symlinked directory in the worktree", () => {
    write(repoRoot, "infra/db.yml", "services: {}\n");
    const file = composeFile(repoRoot);
    file.sourceFiles.push(path.join(repoRoot, "infra/db.yml"));
    fs.mkdirSync(path.join(base, "outside"));
    fs.symlinkSync("../outside", path.join(wtPath, "infra"));

    const warnings = syncWorktreeFiles(repoRoot, wtPath, file);

    expect(fs.readdirSync(path.join(base, "outside"))).toEqual([]);
    expect(warnings.join("\n")).toMatch(/Skipped sync of infra\/db\.yml: it resolves outside the worktree/);
  });

  it("replaces a regular file with main's symlink (unlink, never recursive)", () => {
    fs.symlinkSync("../datasets", path.join(repoRoot, "data"));
    write(wtPath, "data", "a file\n");
    expect(syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["data"])).toEqual([]);
    expect(fs.readlinkSync(path.join(wtPath, "data"))).toBe("../datasets");
  });

  it("never creates a synced symlink through a symlinked worktree directory", () => {
    write(repoRoot, "config/real.conf", "x\n");
    fs.symlinkSync("real.conf", path.join(repoRoot, "config/link.conf"));
    fs.mkdirSync(path.join(base, "outside"));
    fs.symlinkSync("../outside", path.join(wtPath, "config"));

    const warnings = syncWorktreeFiles(repoRoot, wtPath, composeFile(repoRoot), ["config"]);

    expect(fs.readdirSync(path.join(base, "outside"))).toEqual([]);
    // The worktree's own link is replaced by a real directory, not followed.
    expect(fs.lstatSync(path.join(wtPath, "config")).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(wtPath, "config/link.conf"))).toBe("real.conf");
    expect(warnings.join("\n")).toMatch(/config in the worktree was a symlink; replaced it/);
  });

  it("refuses Dockerfile copies through a symlinked directory, allows one that stays inside", () => {
    write(repoRoot, "api/Dockerfile", "FROM node\n");
    write(repoRoot, "web/Dockerfile", "FROM nginx\n");
    const file = composeFile(repoRoot, [
      { name: "api", ports: [], sourcePath: path.join(repoRoot, "compose.yaml"), build: { context: "./api" } },
      { name: "web", ports: [], sourcePath: path.join(repoRoot, "compose.yaml"), build: { context: "./web" } },
    ]);
    fs.mkdirSync(path.join(base, "outside"));
    fs.symlinkSync(path.join(base, "outside"), path.join(wtPath, "api"));
    fs.mkdirSync(path.join(wtPath, "packages/web"), { recursive: true });
    fs.symlinkSync("packages/web", path.join(wtPath, "web"));

    const warnings = syncWorktreeFiles(repoRoot, wtPath, file);

    expect(fs.readdirSync(path.join(base, "outside"))).toEqual([]);
    expect(warnings.join("\n")).toMatch(/Skipped sync of api\/Dockerfile: it resolves outside the worktree/);
    expect(fs.readFileSync(path.join(wtPath, "packages/web/Dockerfile"), "utf-8")).toBe("FROM nginx\n");
  });

  it("refuses writes behind a dangling directory symlink", () => {
    write(repoRoot, "infra/db.yml", "services: {}\n");
    const file = composeFile(repoRoot);
    file.sourceFiles.push(path.join(repoRoot, "infra/db.yml"));
    fs.symlinkSync(path.join(base, "later"), path.join(wtPath, "infra"));

    const warnings = syncWorktreeFiles(repoRoot, wtPath, file);

    expect(fs.existsSync(path.join(base, "later"))).toBe(false);
    expect(warnings.join("\n")).toMatch(/Skipped sync of infra\/db\.yml/);
  });

  it("never copies the main checkout onto itself", () => {
    write(repoRoot, "config/app.json", "{}\n");
    const before = fs.readdirSync(repoRoot).sort();
    const warnings = syncWorktreeFiles(repoRoot, repoRoot, composeFile(repoRoot), ["config"]);
    expect(warnings.join("\n")).toMatch(/is the main checkout itself/);
    expect(fs.readdirSync(repoRoot).sort()).toEqual(before);
  });
});
