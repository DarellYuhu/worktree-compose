import fs from "node:fs";
import path from "node:path";
import { jest } from "@jest/globals";
import { clean, managedPathMatcher, unmanagedChanges } from "../../src/core/clean.js";
import { prune } from "../../src/core/prune.js";
import { stopWorktrees } from "../../src/core/stop.js";
import { startWorktrees } from "../../src/core/start.js";
import { sweepStaleResources } from "../../src/core/teardown.js";
import { buildContext, getEnvTargets } from "../../src/context.js";
import { getStatusPaths } from "../../src/git/status.js";
import { prepareEnvFile, injectPortOverrides } from "../../src/sync/env.js";
import { syncWorktreeFiles } from "../../src/sync/files.js";
import { stateFile } from "../../src/state/registry.js";
import { worktreeResourcePattern } from "../../src/utils/sanitize.js";
import { CollectingReporter, silentReporter } from "../../src/utils/log.js";
import type { SweepRunner } from "../../src/core/teardown.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine } from "../helpers/fake-engine.js";

describe("worktreeResourcePattern", () => {
  const re = worktreeResourcePattern("myapp");

  it("matches only this repo's worktree resources", () => {
    expect(re.test("myapp-wt-1-x")).toBe(true);
    expect(re.test("myapp-wt-12-feat-web-1")).toBe(true);
    expect(re.test("myapp-wt-3-feat_default")).toBe(true);
    expect(re.test("othermyapp-wt-1-x")).toBe(false);
    expect(re.test("foo-wt-1-x")).toBe(false);
    expect(re.test("myapp-wt-x")).toBe(false);
    expect(re.test("myapp-web-1")).toBe(false);
  });

  it("escapes regex characters and sanitizes the repo name", () => {
    const dotted = worktreeResourcePattern("My.App");
    expect(dotted.test("my-app-wt-1-x")).toBe(true);
    expect(dotted.test("myXapp-wt-1-x")).toBe(false);
  });
});

describe("sweepStaleResources", () => {
  const ndjson = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n");
  const container = (id: string, name: string, project?: string, workingDir?: string) => ({
    ID: id,
    Names: name,
    State: "running",
    Labels: [
      project ? `com.docker.compose.project=${project}` : "",
      workingDir ? `com.docker.compose.project.working_dir=${workingDir}` : "",
    ]
      .filter(Boolean)
      .join(","),
  });
  const labeled = (name: string, project?: string, id?: string) => ({
    ...(id ? { ID: id } : {}),
    Name: name,
    Labels: project ? `com.docker.compose.project=${project}` : "",
  });

  function fakeEngine(listings: Record<string, string>, failing: Set<string>) {
    const calls: string[] = [];
    const runner: SweepRunner = (_file, args) => {
      const key = args.join(" ");
      calls.push(key);
      if (args[1] === "ls" || args[0] === "ps") {
        const kind = args[0] === "ps" ? "containers" : args[0] === "network" ? "networks" : "volumes";
        return listings[kind] ?? "";
      }
      const target = args[args.length - 1];
      if (failing.has(target)) throw new Error(`Error: ${target} is in use`);
      return target;
    };
    return { runner, calls };
  }
  const removals = (calls: string[]) => calls.filter((c) => / rm /.test(` ${c} `));

  // This checkout: myapp at /w/myapp (main) with a worktree at /w/myapp-a,
  // recorded as myapp-wt-1-a. Another checkout also named myapp lives in
  // /other; /gone/… no longer exists.
  const base = {
    registryProjects: ["myapp-wt-1-a"],
    mainRoot: "/w/myapp",
    checkouts: ["/w/myapp-a"],
    dirExists: (dir: string) => !dir.startsWith("/gone/"),
  };
  const listings = {
    containers: ndjson([
      container("c1", "myapp-wt-1-a-web-1", "myapp-wt-1-a", "/w/myapp-a"),
      // ≤0.2 positional leftover that ran from a current worktree: ours.
      container("c2", "myapp-wt-2-b-db-1", "myapp-wt-2-b", "/w/myapp-a"),
      // Ran from inside the main checkout (nested worktree dir): ours.
      container("c3", "myapp-wt-3-c-db-1", "myapp-wt-3-c", "/w/myapp/.worktrees/c"),
      // Same basename, another checkout whose directory exists: never ours.
      container("c4", "myapp-wt-1-feat-web-1", "myapp-wt-1-feat", "/other/myapp-feat"),
      // Its worktree directory is gone: stale.
      container("c5", "myapp-wt-4-gone-web-1", "myapp-wt-4-gone", "/gone/myapp-gone"),
      container("c6", "othermyapp-wt-1-a-web-1", "othermyapp-wt-1-a", "/x"),
      container("c7", "postgres"),
      // Named like a worktree stack, but no labels: nothing to attribute it by.
      container("c8", "myapp-wt-5-x-web-1"),
      // The main checkout's own stack (no -wt-): never swept, though it ran from main.
      container("c9", "myapp-web-1", "myapp", "/w/myapp"),
    ]),
    networks: ndjson([
      labeled("myapp-wt-1-a_default", "myapp-wt-1-a", "n1"),
      labeled("myapp-wt-1-feat_default", "myapp-wt-1-feat", "n2"),
      labeled("myapp-wt-4-gone_default", "myapp-wt-4-gone", "n4"),
      labeled("myapp_default", "myapp", "n5"),
      labeled("bridge", undefined, "n3"),
    ]),
    volumes: ndjson([
      labeled("myapp-wt-1-a_data", "myapp-wt-1-a"),
      labeled("myapp-wt-2-b_data", "myapp-wt-2-b"),
      labeled("myapp-wt-1-feat_data", "myapp-wt-1-feat"),
      labeled("myapp-wt-4-gone_data", "myapp-wt-4-gone"),
      // No containers left to tell whose it is.
      labeled("myapp-wt-7-old_data", "myapp-wt-7-old"),
      labeled("myapp_data", "myapp"),
    ]),
  };

  it("removes only resources whose project this checkout owns, one at a time, continuing after a failure", () => {
    const { runner, calls } = fakeEngine(listings, new Set(["c1", "myapp-wt-1-a_data"]));
    const result = sweepStaleResources(["docker"], "myapp", { ...base, runner });

    expect(result.containers).toEqual({
      removed: ["myapp-wt-2-b-db-1", "myapp-wt-3-c-db-1"],
      failed: ["myapp-wt-1-a-web-1"],
    });
    expect(result.networks).toEqual({ removed: ["myapp-wt-1-a_default"], failed: [] });
    expect(result.volumes).toEqual({ removed: ["myapp-wt-2-b_data"], failed: ["myapp-wt-1-a_data"] });
    expect(removals(calls)).toEqual([
      "rm -f c1",
      "rm -f c2",
      "rm -f c3",
      "network rm n1",
      "volume rm myapp-wt-1-a_data",
      "volume rm myapp-wt-2-b_data",
    ]);
    // Stale ones are kept without --sweep; not-owned ones always.
    expect(result.stale).toEqual([
      "container myapp-wt-4-gone-web-1",
      "network myapp-wt-4-gone_default",
      "volume myapp-wt-4-gone_data",
    ]);
    expect(result.notOwned).toEqual([
      "container myapp-wt-1-feat-web-1",
      "container myapp-wt-5-x-web-1",
      "network myapp-wt-1-feat_default",
      "volume myapp-wt-1-feat_data",
      "volume myapp-wt-7-old_data",
    ]);
  });

  it("with sweep, also removes stacks whose working directory is gone — never ones whose directory exists", () => {
    const { runner, calls } = fakeEngine(listings, new Set());
    const result = sweepStaleResources(["docker"], "myapp", { ...base, runner, sweep: true });
    expect(removals(calls)).toEqual([
      "rm -f c1",
      "rm -f c2",
      "rm -f c3",
      "rm -f c5",
      "network rm n1",
      "network rm n4",
      "volume rm myapp-wt-1-a_data",
      "volume rm myapp-wt-2-b_data",
      "volume rm myapp-wt-4-gone_data",
    ]);
    expect(result.notOwned).toHaveLength(5);
    expect(removals(calls).some((c) => /feat|wt-5-|wt-7-|myapp_|myapp-web|n5/.test(c))).toBe(false);
  });

  it("a dry run only lists, showing owned, stale and not-owned groups", () => {
    const { runner, calls } = fakeEngine(listings, new Set());
    const reporter = new CollectingReporter();
    const result = sweepStaleResources(["docker"], "myapp", { ...base, runner, reporter, dryRun: true });
    expect(removals(calls)).toEqual([]);
    expect(result.containers.removed).toEqual(["myapp-wt-1-a-web-1", "myapp-wt-2-b-db-1", "myapp-wt-3-c-db-1"]);
    const text = reporter.lines.join("\n");
    expect(text).toContain("Would remove leftover volume myapp-wt-2-b_data");
    expect(text).toMatch(/Kept 3 leftover resource\(s\) of worktree stacks whose directory no longer exists.*wtc clean --sweep/);
    expect(text).toMatch(/Kept 5 resource\(s\) .* does not own .*myapp-wt-1-feat_data/);

    const swept = new CollectingReporter();
    sweepStaleResources(["docker"], "myapp", { ...base, runner, reporter: swept, dryRun: true, sweep: true });
    expect(swept.lines).toContain("Would remove leftover volume myapp-wt-4-gone_data (its worktree directory is gone)");
  });

  it("leaves skipped projects alone (torn down in the same dry run, or live again)", () => {
    const { runner, calls } = fakeEngine(listings, new Set());
    const result = sweepStaleResources(["docker"], "myapp", {
      ...base,
      runner,
      skipProjects: ["myapp-wt-1-a", "myapp-wt-4-gone"],
      sweep: true,
    });
    expect(removals(calls)).toEqual(["rm -f c2", "rm -f c3", "volume rm myapp-wt-2-b_data"]);
    expect(result.stale).toEqual([]);
  });

  it("does no name-based matching for a repo name that sanitizes to nothing", () => {
    const { runner } = fakeEngine(
      {
        volumes: ndjson([labeled("wt-1-x_data", "wt-1-x")]),
        containers: ndjson([container("c1", "wt-1-x-web-1", "wt-1-x", "/gone/x")]),
        networks: "",
      },
      new Set(),
    );
    const result = sweepStaleResources(["docker"], "日本", { runner, sweep: true, dirExists: () => false });
    expect(result.volumes.removed).toEqual([]);
    expect(result.containers.removed).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.notOwned).toEqual([]);
  });

  it("passes global CLI flags through (docker --context x)", () => {
    const { runner, calls } = fakeEngine({}, new Set());
    sweepStaleResources(["docker", "--context", "x"], "myapp", { runner });
    expect(calls[0]).toBe("--context x ps -a --format json");
  });
});

describe("clean", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;
  const sweepRunner = jest.fn<SweepRunner>(() => "");
  const composeLog = () => engine.composeLog();

  /** What `wtc start` writes into a worktree, minus compose up. */
  function simulateStart(wtPath: string): void {
    const ctx = buildContext({}, { cwd: root, probeStacks: true });
    syncWorktreeFiles(ctx.repoRoot, wtPath, ctx.composeFile, ctx.config.sync);
    for (const target of getEnvTargets(ctx)) {
      const envPath = prepareEnvFile(ctx.repoRoot, wtPath, target);
      if (envPath) injectPortOverrides(envPath, [], target.overrides, { projectName: "p", writeProjectName: true });
    }
  }

  beforeEach(() => {
    ({ base, root } = makeRepo("cleanrepo"));
    write(root, "compose.yaml", "include:\n  - ./infra/db.yml\nservices:\n  api:\n    build: ./api\n    ports:\n      - \"${API_PORT:-3000}:3000\"\n");
    write(root, "infra/db.yml", "services:\n  db:\n    image: postgres\n");
    write(root, "api/Dockerfile", "FROM node\n");
    write(root, ".wtcrc.json", JSON.stringify({ sync: ["nginx"] }));
    write(root, "nginx/nginx.conf", "events {}\n");
    commitAll(root, "infra");
    // Main has local infra edits that wtc copies over the worktrees' versions.
    write(root, "compose.yaml", fs.readFileSync(path.join(root, "compose.yaml"), "utf-8") + "# local\n");
    write(root, "infra/db.yml", "services:\n  db:\n    image: postgres:16\n");
    write(root, "api/Dockerfile", "FROM node:22\n");
    write(root, "nginx/extra.conf", "# untracked\n");
    write(root, ".env", "SECRET=1\n");

    engine = installFakeEngine(base);
    sweepRunner.mockClear();
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("ignores wtc-managed files when deciding whether a worktree is dirty", () => {
    const wt = addWorktree(root, base, "wt-clean", "clean");
    simulateStart(wt);
    const ctx = buildContext({}, { cwd: root });
    const isManaged = managedPathMatcher(ctx, wt);

    const status = getStatusPaths(wt);
    expect(status.length).toBeGreaterThan(0);
    expect(unmanagedChanges(status, isManaged)).toEqual([]);

    write(wt, "src/feature.ts", "export const x = 1;\n");
    write(wt, "README.md", "changed\n");
    expect(unmanagedChanges(getStatusPaths(wt), isManaged).sort()).toEqual(["README.md", "src/feature.ts"]);
  });

  it("counts edits to env files wtc does not write, and to synced files, as real work", () => {
    write(root, ".env.test", "TEST=1\n");
    write(root, "deploy/.env.production", "PROD=1\n");
    commitAll(root, "committed env files");
    const wt = addWorktree(root, base, "wt-env", "env");
    simulateStart(wt);
    const isManaged = () => managedPathMatcher(buildContext({}, { cwd: root }), wt);
    expect(unmanagedChanges(getStatusPaths(wt), isManaged())).toEqual([]);

    write(wt, ".env.test", "TEST=2\n");
    write(wt, "deploy/.env.production", "PROD=2\n");
    write(wt, "apps/web/.env.local", "LOCAL=1\n");
    write(wt, "nginx/sites/new-site.conf", "server {}\n");
    write(wt, "api/Dockerfile", "FROM node:20\n");
    expect(unmanagedChanges(getStatusPaths(wt), isManaged()).sort()).toEqual([
      ".env.test",
      "api/Dockerfile",
      "apps/web/.env.local",
      "deploy/.env.production",
      "nginx/sites/new-site.conf",
    ]);
  });

  it("treats env files recorded by the last start as wtc's own", () => {
    const wt = addWorktree(root, base, "wt-rec", "rec");
    write(wt, ".env.development", "PORT=1\n");
    const ctx = buildContext({}, { cwd: root });
    expect(unmanagedChanges(getStatusPaths(wt), managedPathMatcher(ctx, wt))).toEqual([".env.development"]);
    expect(unmanagedChanges(getStatusPaths(wt), managedPathMatcher(ctx, wt, [".env.development"]))).toEqual([]);
  });

  it("does not remove a detached worktree whose commits no branch reaches", async () => {
    const detached = path.join(base, "wt-detached");
    git(root, "worktree", "add", "-q", "--detach", detached);
    write(detached, "work.txt", "committed on a detached HEAD\n");
    commitAll(detached, "detached work");
    const plain = path.join(base, "wt-detached-plain");
    git(root, "worktree", "add", "-q", "--detach", plain);

    const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(result.removed).toEqual([plain]);
    expect(result.skipped.find((s) => s.path === detached)?.reason).toMatch(/detached HEAD has commits no branch/);
    expect(fs.existsSync(detached)).toBe(true);

    const forced = await clean({ force: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(forced.removed).toEqual([detached]);
  });

  it("does not remove a worktree whose submodule has unpushed commits", async () => {
    const { base: libBase, root: lib } = makeRepo("lib");
    try {
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
      commitAll(root, "add submodule");
      const wt = addWorktree(root, base, "wt-sub", "subwork");
      git(wt, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
      const sub = path.join(wt, "lib");
      git(sub, "checkout", "-q", "-b", "local");
      write(sub, "unpushed.txt", "only here\n");
      commitAll(sub, "unpushed submodule commit");
      commitAll(wt, "bump submodule");
      simulateStart(wt);

      const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd: root });
      expect(result.removed).toEqual([]);
      expect(result.skipped.find((s) => s.path === wt)?.reason).toMatch(/submodule has commits not on any remote/);
      expect(fs.existsSync(path.join(sub, "unpushed.txt"))).toBe(true);
    } finally {
      fs.rmSync(libBase, { recursive: true, force: true });
    }
  });

  it("reports teardown failures (exit code / isError) instead of success", async () => {
    addWorktree(root, base, "wt-a", "a");
    const gone = addWorktree(root, base, "wt-gone", "gone");
    buildContext({}, { cwd: root, probeStacks: true }); // records the worktrees
    fs.rmSync(gone, { recursive: true, force: true });
    engine.failCompose(true);
    const reporter = new CollectingReporter();

    const stopped = await stopWorktrees({}, reporter, { live: false, cwd: root });
    expect(stopped.failures).toBe(1);

    const pruned = await prune({}, reporter, { live: false, cwd: root });
    expect(pruned.failures).toBe(1);

    const cleaned = await clean({ keepWorktrees: true, sweepRunner }, reporter, { live: false, cwd: root });
    expect(cleaned.failures).toBe(2);
    expect(reporter.lines.some((l) => l.startsWith("✔ Cleanup complete"))).toBe(false);
    expect(reporter.lines).toContain(
      "⚠ Cleanup finished with failures: 0/2 stack(s) stopped, 0 worktree(s) removed, swept 0 container(s), 0 network(s), 0 volume(s).",
    );
    // The orphan's record is kept for a later prune.
    expect(buildContext({}, { cwd: root }).orphans.map((o) => o.project)).toEqual(["cleanrepo-wt-2-gone"]);

    const dry = await clean({ dryRun: true, sweepRunner }, reporter, { live: false, cwd: root });
    expect(dry.failures).toBe(0);
  });

  it("retries teardown without --remove-orphans (podman-compose < 1.0.6)", async () => {
    const gone = addWorktree(root, base, "wt-gone", "gone");
    buildContext({}, { cwd: root, probeStacks: true }); // records the worktrees
    fs.rmSync(gone, { recursive: true, force: true });
    // Fail only the first attempt.
    const failFlag = path.join(base, "compose.fail");
    fs.writeFileSync(failFlag, "");
    const timer = setInterval(() => {
      if (composeLog().length >= 1) fs.rmSync(failFlag, { force: true });
    }, 5);
    try {
      const result = await prune({}, silentReporter, { live: false, cwd: root });
      expect(result.orphans).toMatchObject([{ ok: true }]);
    } finally {
      clearInterval(timer);
    }
    expect(composeLog()).toEqual([
      "-p cleanrepo-wt-1-gone down -v --remove-orphans",
      "-p cleanrepo-wt-1-gone down -v",
    ]);
  });

  it("keeps another checkout's same-named stack out of a real clean (no data loss)", async () => {
    // A second clone with the same directory name, with its own running stack.
    const other = makeRepo("cleanrepo");
    try {
      const otherWt = addWorktree(other.root, other.base, "cleanrepo-feat-b", "feat-b");
      const ndjson = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n");
      const listings: Record<string, string> = {
        containers: ndjson([
          {
            ID: "f1",
            Names: "cleanrepo-wt-1-feat-b-cache-1",
            State: "running",
            Labels: `com.docker.compose.project=cleanrepo-wt-1-feat-b,com.docker.compose.project.working_dir=${otherWt}`,
          },
        ]),
        networks: ndjson([{ ID: "fn", Name: "cleanrepo-wt-1-feat-b_default", Labels: "com.docker.compose.project=cleanrepo-wt-1-feat-b" }]),
        volumes: ndjson([{ Name: "cleanrepo-wt-1-feat-b_data", Labels: "com.docker.compose.project=cleanrepo-wt-1-feat-b" }]),
      };
      const removals: string[] = [];
      const runner: SweepRunner = (_file, args) => {
        if (args[0] === "ps") return listings.containers;
        if (args[1] === "ls") return listings[args[0] === "network" ? "networks" : "volumes"];
        removals.push(args.join(" "));
        return "";
      };

      const result = await clean({ sweepRunner: runner, sweep: true }, silentReporter, { live: false, cwd: root });
      expect(removals).toEqual([]);
      expect(result.sweep?.notOwned).toHaveLength(3);
    } finally {
      fs.rmSync(other.base, { recursive: true, force: true });
    }
  });

  it("--sweep removes stale stacks (directory gone), never one whose directory exists or the main stack", async () => {
    const other = makeRepo("cleanrepo");
    try {
      const ndjson = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n");
      const c = (id: string, project: string, dir: string) => ({
        ID: id,
        Names: `${project}-web-1`,
        State: "exited",
        Labels: `com.docker.compose.project=${project},com.docker.compose.project.working_dir=${dir}`,
      });
      const listings: Record<string, string> = {
        containers: ndjson([
          c("s1", "cleanrepo-wt-9-old", path.join(base, "deleted-by-rm-rf")),
          c("f1", "cleanrepo-wt-1-theirs", other.root),
          c("m1", "cleanrepo", root),
        ]),
        networks: "",
        volumes: ndjson([
          { Name: "cleanrepo-wt-9-old_data", Labels: "com.docker.compose.project=cleanrepo-wt-9-old" },
          { Name: "cleanrepo-wt-1-theirs_data", Labels: "com.docker.compose.project=cleanrepo-wt-1-theirs" },
          { Name: "cleanrepo_data", Labels: "com.docker.compose.project=cleanrepo" },
        ]),
      };
      const removals: string[] = [];
      const runner: SweepRunner = (_file, args) => {
        if (args[0] === "ps") return listings.containers;
        if (args[1] === "ls") return listings[args[0] === "network" ? "networks" : "volumes"];
        removals.push(args.join(" "));
        return "";
      };

      const plain = await clean({ sweepRunner: runner }, silentReporter, { live: false, cwd: root });
      expect(removals).toEqual([]);
      expect(plain.sweep?.stale).toEqual(["container cleanrepo-wt-9-old-web-1", "volume cleanrepo-wt-9-old_data"]);

      const dry = await clean({ sweepRunner: runner, sweep: true, dryRun: true }, silentReporter, { live: false, cwd: root });
      expect(removals).toEqual([]);
      expect(dry.sweep?.volumes.removed).toEqual(["cleanrepo-wt-9-old_data"]);

      const swept = await clean({ sweepRunner: runner, sweep: true }, silentReporter, { live: false, cwd: root });
      expect(removals).toEqual(["rm -f s1", "volume rm cleanrepo-wt-9-old_data"]);
      expect(swept.sweep?.notOwned).toEqual(["container cleanrepo-wt-1-theirs-web-1", "volume cleanrepo-wt-1-theirs_data"]);
      expect(swept.failures).toBe(0);
    } finally {
      fs.rmSync(other.base, { recursive: true, force: true });
    }
  });

  it("dry runs are read-only: no registry write, no wtc-id, a corrupt registry is not moved aside", async () => {
    addWorktree(root, base, "wt-a", "a");
    buildContext({}, { cwd: root, probeStacks: true }); // records wt-a
    const gone = addWorktree(root, base, "wt-gone", "gone");
    buildContext({}, { cwd: root, probeStacks: true }); // records wt-gone
    fs.rmSync(gone, { recursive: true, force: true });
    const fresh = addWorktree(root, base, "wt-new", "new"); // not recorded yet
    const file = stateFile(path.join(root, ".git"));
    const before = fs.readFileSync(file, "utf-8");
    const freshId = path.join(root, ".git", "worktrees", "wt-new", "wtc-id");

    const cleaned = await clean({ dryRun: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(cleaned.removed).toContain(fresh);
    const pruned = await prune({ dryRun: true }, silentReporter, { live: false, cwd: root });
    expect(pruned.orphans.map((o) => o.project)).toEqual(["cleanrepo-wt-2-gone"]);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(fs.existsSync(freshId)).toBe(false);
    expect(composeLog()).toEqual([]);

    fs.writeFileSync(file, "{ not json");
    const reporter = new CollectingReporter();
    await clean({ dryRun: true, sweepRunner }, reporter, { live: false, cwd: root });
    await prune({ dryRun: true }, reporter, { live: false, cwd: root });
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak"))).toEqual([]);
  });

  it.each(["prune", "clean"] as const)(
    "%s re-checks each orphan right before tearing it down (a worktree that came back is skipped)",
    async (command) => {
      const a = addWorktree(root, base, "wt-a", "a");
      const b = addWorktree(root, base, "wt-b", "b");
      buildContext({}, { cwd: root, probeStacks: true }); // records both (with stable ids)
      // Both checkouts disappear (moved away): both are orphans now.
      fs.renameSync(a, `${a}-moved`);
      fs.renameSync(b, `${b}-moved`);
      // While a's stack is torn down, b's directory comes back.
      engine.setComposeHook(
        `const fs = require("fs");
module.exports = (args) => {
  if (args.includes("cleanrepo-wt-1-a") && fs.existsSync(${JSON.stringify(`${b}-moved`)})) {
    fs.renameSync(${JSON.stringify(`${b}-moved`)}, ${JSON.stringify(b)});
  }
};`,
      );
      const reporter = new CollectingReporter();
      if (command === "prune") {
        const result = await prune({}, reporter, { live: false, cwd: root });
        expect(result.orphans.map((o) => o.project)).toEqual(["cleanrepo-wt-1-a"]);
        expect(result.skipped.map((o) => o.project)).toEqual(["cleanrepo-wt-2-b"]);
        expect(result.failures).toBe(0);
      } else {
        const result = await clean({ keepWorktrees: true, sweepRunner }, reporter, { live: false, cwd: root });
        expect(result.stacks.map((st) => st.project)).toEqual(["cleanrepo-wt-1-a"]);
        expect(result.forgotten).toEqual([a]);
      }
      expect(composeLog()).toEqual(["-p cleanrepo-wt-1-a down -v --remove-orphans"]);
      expect(reporter.lines.join("\n")).toMatch(/Skipping cleanrepo-wt-2-b: its worktree .* exists again/);
      // b is live again with its identity; a is forgotten.
      const ctx = buildContext({}, { cwd: root });
      expect(ctx.worktrees.map((w) => [w.path, w.project])).toEqual([[b, "cleanrepo-wt-2-b"]]);
      expect(ctx.orphans).toEqual([]);
    },
  );

  it("never removes the main checkout of a bare-repo layout", async () => {
    const bare = path.join(base, "bare.git");
    git(base, "clone", "-q", "--bare", root, bare);
    const main = path.join(base, "bare-main");
    git(bare, "worktree", "add", "-q", main, "main");
    const feat = path.join(base, "bare-feat");
    git(bare, "worktree", "add", "-q", feat, "-b", "feat");
    const other = path.join(base, "bare-other");
    git(bare, "worktree", "add", "-q", other, "-b", "other");

    for (const cwd of [feat, main]) {
      const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd });
      expect(fs.existsSync(main)).toBe(true);
      expect(result.removed).not.toContain(main);
      expect(result.stacks.map((st) => st.project)).not.toContain("bare-wt-1-main");
    }
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.existsSync(feat)).toBe(false); // removed by the second run (from main)
  });

  it("tries down -v --remove-orphans, then down -v, then (plugin only) an empty directory; reports the first error", async () => {
    const gone = addWorktree(root, base, "wt-gone", "gone");
    buildContext({}, { cwd: root, probeStacks: true }); // records it
    fs.rmSync(gone, { recursive: true, force: true });
    engine.failCompose(true);
    const cwdLog = path.join(base, "cwd.log");
    engine.setComposeHook(
      `module.exports = () => require("fs").appendFileSync(${JSON.stringify(cwdLog)}, process.cwd() + "\\n");`,
    );

    const plugin = await prune({}, silentReporter, { live: false, cwd: root });
    expect(composeLog()).toEqual([
      "-p cleanrepo-wt-1-gone down -v --remove-orphans",
      "-p cleanrepo-wt-1-gone down -v",
      "-p cleanrepo-wt-1-gone down -v --remove-orphans",
    ]);
    const dirs = fs.readFileSync(cwdLog, "utf-8").trim().split("\n");
    expect(dirs.slice(0, 2)).toEqual([root, root]);
    expect(dirs[2]).not.toBe(root);
    expect(plugin.orphans[0].error).toMatch(/down -v --remove-orphans/);
    expect(plugin.failures).toBe(1);

    // Standalone podman-compose / docker-compose need a compose file: no empty-directory retry.
    fs.rmSync(path.join(base, "compose.log"));
    write(base, "bin/podman-compose", '#!/bin/sh\nexec podman compose "$@"\n');
    fs.chmodSync(path.join(base, "bin/podman-compose"), 0o755);
    process.env.WTC_COMPOSE_COMMAND = "podman-compose";
    const standalone = await prune({}, silentReporter, { live: false, cwd: root });
    expect(composeLog()).toEqual([
      "-p cleanrepo-wt-1-gone down -v --remove-orphans",
      "-p cleanrepo-wt-1-gone down -v",
    ]);
    expect(standalone.failures).toBe(1);
  });

  (process.getuid?.() === 0 ? it.skip : it)("counts a failed worktree removal as a failure, not a skip", async () => {
    const wt = addWorktree(root, base, "wt-ro", "ro");
    write(wt, "ro/file.txt", "x\n");
    commitAll(wt, "read-only dir");
    fs.chmodSync(path.join(wt, "ro"), 0o555);
    try {
      const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd: root });
      expect(result.removed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.removeFailed.map((f) => f.path)).toEqual([wt]);
      expect(result.failures).toBe(1);
    } finally {
      fs.chmodSync(path.join(wt, "ro"), 0o755);
    }
  });

  it("tears everything down but only removes worktrees without real work", async () => {
    const clean1 = addWorktree(root, base, "wt-clean", "clean");
    const dirty = addWorktree(root, base, "wt-dirty", "dirty");
    const locked = addWorktree(root, base, "wt-locked", "locked");
    for (const wt of [clean1, dirty, locked]) simulateStart(wt);
    write(dirty, "work.txt", "unsaved\n");
    git(root, "worktree", "lock", locked);

    const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd: root });

    expect(result.stacks.map((s) => s.project)).toEqual([
      "cleanrepo-wt-1-clean",
      "cleanrepo-wt-2-dirty",
      "cleanrepo-wt-3-locked",
    ]);
    expect(result.stacks.every((s) => s.ok)).toBe(true);
    expect(composeLog()).toEqual([
      "-p cleanrepo-wt-1-clean down -v --remove-orphans",
      "-p cleanrepo-wt-2-dirty down -v --remove-orphans",
      "-p cleanrepo-wt-3-locked down -v --remove-orphans",
    ]);

    expect(result.removed).toEqual([clean1]);
    expect(fs.existsSync(clean1)).toBe(false);
    expect(fs.existsSync(dirty)).toBe(true);
    expect(fs.existsSync(locked)).toBe(true);
    expect(result.skipped.find((s) => s.path === dirty)?.reason).toMatch(/work\.txt/);
    expect(result.skipped.find((s) => s.path === locked)?.reason).toBe("locked");

    // The removed worktree's record is forgotten; the others keep their indices.
    const state = JSON.parse(fs.readFileSync(stateFile(path.join(root, ".git")), "utf-8"));
    expect(state.worktrees.map((r: { index: number }) => r.index).sort()).toEqual([2, 3]);
    expect(sweepRunner).toHaveBeenCalled();
  });

  it("--force removes dirty and locked worktrees", async () => {
    const dirty = addWorktree(root, base, "wt-dirty", "dirty");
    const locked = addWorktree(root, base, "wt-locked", "locked");
    write(dirty, "work.txt", "unsaved\n");
    git(root, "worktree", "lock", locked);

    const result = await clean({ force: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(result.removed.sort()).toEqual([dirty, locked].sort());
    expect(fs.existsSync(dirty)).toBe(false);
    expect(fs.existsSync(locked)).toBe(false);
  });

  it("never removes the worktree it runs from", async () => {
    const here = addWorktree(root, base, "wt-here", "here");
    const result = await clean({ sweepRunner }, silentReporter, { live: false, cwd: here });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path: here, reason: "current worktree" }]);
    expect(fs.existsSync(here)).toBe(true);
  });

  it("--keep-worktrees tears down stacks but keeps worktrees and their records", async () => {
    const wt = addWorktree(root, base, "wt-keep", "keep");
    buildContext({}, { cwd: root, probeStacks: true }); // records it
    const result = await clean({ keepWorktrees: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(result.stacks).toHaveLength(1);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(wt)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile(path.join(root, ".git")), "utf-8"));
    expect(state.worktrees).toHaveLength(1);
  });

  it("--dry-run changes nothing", async () => {
    const wt = addWorktree(root, base, "wt-a", "a");
    const result = await clean({ dryRun: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(result.removed).toEqual([wt]);
    expect(fs.existsSync(wt)).toBe(true);
    expect(composeLog()).toEqual([]);
    // Not even the registry is created.
    expect(fs.existsSync(stateFile(path.join(root, ".git")))).toBe(false);
  });

  it("tears down and forgets orphans (worktrees deleted outside wtc)", async () => {
    const gone = addWorktree(root, base, "wt-gone", "gone");
    const keep = addWorktree(root, base, "wt-keep", "keep");
    buildContext({}, { cwd: root, probeStacks: true }); // records both
    git(root, "worktree", "remove", "--force", gone);

    const result = await clean({ keepWorktrees: true, sweepRunner }, silentReporter, { live: false, cwd: root });
    expect(result.stacks.map((s) => [s.project, s.orphan])).toEqual([
      ["cleanrepo-wt-2-keep", false],
      ["cleanrepo-wt-1-gone", true],
    ]);
    expect(result.forgotten).toEqual([gone]);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("prune tears down and forgets only orphans", async () => {
    const gone = addWorktree(root, base, "wt-gone", "gone");
    const keep = addWorktree(root, base, "wt-keep", "keep");
    buildContext({}, { cwd: root, probeStacks: true }); // records the worktrees
    fs.rmSync(gone, { recursive: true, force: true });

    const dry = await prune({ dryRun: true }, silentReporter, { live: false, cwd: root });
    expect(dry.orphans.map((o) => o.project)).toEqual(["cleanrepo-wt-1-gone"]);
    expect(composeLog()).toEqual([]);

    const result = await prune({}, silentReporter, { live: false, cwd: root });
    expect(result.orphans).toMatchObject([{ project: "cleanrepo-wt-1-gone", ok: true }]);
    expect(result.gitPruned).toEqual([gone]);
    expect(composeLog()).toEqual(["-p cleanrepo-wt-1-gone down -v --remove-orphans"]);
    expect(fs.existsSync(keep)).toBe(true);

    const ctx = buildContext({}, { cwd: root });
    expect(ctx.orphans).toEqual([]);
    expect(ctx.prunable).toEqual([]);
    expect(ctx.worktrees.map((w) => w.index)).toEqual([2]);
  });

  it("start syncs files, injects env and runs compose up with the stable project", async () => {
    const wt = addWorktree(root, base, "wt-a", "feat/a");
    const result = await startWorktrees(
      { worktrees: ["feat/a"], build: false },
      silentReporter,
      { live: false, cwd: root },
    );

    expect(result.started).toEqual([
      { index: 1, branch: "feat/a", path: wt, project: "cleanrepo-wt-1-feat-a", ports: { API_PORT: 23001 } },
    ]);
    expect(composeLog()).toEqual(["-p cleanrepo-wt-1-feat-a up -d"]);
    const env = fs.readFileSync(path.join(wt, ".env"), "utf-8");
    expect(env).toContain("SECRET=1");
    expect(env).toContain("COMPOSE_PROJECT_NAME=cleanrepo-wt-1-feat-a");
    expect(env).toContain("API_PORT=23001");
    expect(fs.readFileSync(path.join(wt, "api/Dockerfile"), "utf-8")).toBe("FROM node:22\n");
    expect(fs.existsSync(path.join(wt, "nginx/extra.conf"))).toBe(true);
  });
});
