import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptableStacks, buildContext } from "../../src/context.js";
import { clean } from "../../src/core/clean.js";
import { startWorktrees } from "../../src/core/start.js";
import { peekState, stateFile } from "../../src/state/registry.js";
import { silentReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine, podmanContainer } from "../helpers/fake-engine.js";
import type { PsContainer } from "../../src/compose/status.js";

describe("buildContext", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
    write(root, "compose.yaml", 'services:\n  web:\n    image: nginx\n    container_name: web\n    ports:\n      - "${WEB_PORT:-8080}:80"\n');
    commitAll(root, "compose");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("uses the main worktree and stable projects when run from a linked worktree", () => {
    const a = addWorktree(root, base, "myapp-a", "feat-a");
    const b = addWorktree(root, base, "myapp-b", "feat-b");

    const fromMain = buildContext({}, { cwd: root });
    const fromWorktree = buildContext({}, { cwd: path.join(b) });

    expect(fromWorktree.repoRoot).toBe(root);
    expect(fromWorktree.repoName).toBe("myapp");
    expect(fromWorktree.worktrees.map((w) => [w.path, w.index, w.project])).toEqual(
      fromMain.worktrees.map((w) => [w.path, w.index, w.project]),
    );
    expect(fromMain.worktrees.map((w) => w.project)).toEqual(["myapp-wt-1-feat-a", "myapp-wt-2-feat-b"]);
    expect(a).toBeTruthy();
  });

  it("reports missing worktrees, orphans and isolation problems", () => {
    const a = addWorktree(root, base, "myapp-a", "feat-a");
    addWorktree(root, base, "myapp-b", "feat-b");
    buildContext({}, { cwd: root, probeStacks: true }); // records both
    fs.rmSync(a, { recursive: true, force: true });

    const ctx = buildContext({}, { cwd: root });
    expect(ctx.warnings).toContain(`Worktree ${a} is missing on disk — run 'git worktree prune'.`);
    expect(ctx.orphans.map((o) => o.project)).toEqual(["myapp-wt-1-feat-a"]);
    expect(ctx.worktrees.map((w) => w.index)).toEqual([2]);
    expect(ctx.isolationWarnings.some((w) => w.includes('container_name "web"'))).toBe(true);

    git(root, "worktree", "prune");
    expect(buildContext({}, { cwd: root }).prunable).toEqual([]);
  });

  it("does not persist a fresh registry without a stack probe; an engine-aware build does", () => {
    addWorktree(root, base, "myapp-a", "feat-a");
    const blind = buildContext({}, { cwd: root });
    expect(blind.worktrees.map((w) => w.project)).toEqual(["myapp-wt-1-feat-a"]);
    expect(fs.existsSync(stateFile(path.join(root, ".git")))).toBe(false);

    buildContext({}, { cwd: root, probeStacks: true });
    expect(peekState(path.join(root, ".git"))?.worktrees.map((r) => r.project)).toEqual(["myapp-wt-1-feat-a"]);
  });

  it("readOnly computes identities but writes nothing (no registry, no wtc-id)", () => {
    const a = addWorktree(root, base, "myapp-a", "feat-a");
    const commonDir = path.join(root, ".git");
    const ctx = buildContext({}, { cwd: root, readOnly: true });
    expect(ctx.worktrees.map((w) => [w.path, w.index])).toEqual([[a, 1]]);
    expect(fs.existsSync(path.join(commonDir, "wtc"))).toBe(false);
    expect(fs.existsSync(path.join(commonDir, "worktrees", "myapp-a", "wtc-id"))).toBe(false);

    fs.mkdirSync(path.join(commonDir, "wtc"));
    fs.writeFileSync(stateFile(commonDir), "{ truncated");
    const corrupt = buildContext({}, { cwd: root, readOnly: true });
    expect(corrupt.warnings.join("\n")).toMatch(/unreadable/);
    expect(fs.readdirSync(path.join(commonDir, "wtc"))).toEqual(["state.json"]);
  });

  it("adopts running stacks by their compose working_dir instead of renumbering (lost registry)", () => {
    const a = addWorktree(root, base, "myapp-a", "feat-a");
    const b = addWorktree(root, base, "myapp-b", "feat-b");
    const c = addWorktree(root, base, "myapp-c", "feat-c");
    engine.setContainers([
      podmanContainer("myapp-wt-3-feat-a", "running", a),
      podmanContainer("myapp-wt-1-feat-b", "running", b),
      // Another repo's stack that happens to run from here is not adopted.
      podmanContainer("other-wt-2-feat-c", "running", c),
    ]);
    const ctx = buildContext({}, { cwd: root, probeStacks: true });
    expect(ctx.worktrees.map((w) => [w.branch, w.index, w.project])).toEqual([
      ["feat-a", 3, "myapp-wt-3-feat-a"],
      ["feat-b", 1, "myapp-wt-1-feat-b"],
      ["feat-c", 2, "myapp-wt-2-feat-c"],
    ]);
    expect(peekState(path.join(root, ".git"))?.worktrees).toHaveLength(3);
  });
});

describe("adoptableStacks", () => {
  const worktrees = [
    { path: "/w/app-a", branch: "a", isMain: false, bare: false, detached: false, locked: false, prunable: false },
    { path: "/w/app-b", branch: "b", isMain: false, bare: false, detached: false, locked: false, prunable: false },
  ];
  const c = (project: string, workingDir: string | null, state = "running", oneoff = false): PsContainer => ({
    id: Math.random().toString(16).slice(2),
    name: `${project}-svc-1`,
    project,
    workingDir,
    state,
    running: state === "running",
    oneoff,
  });

  it("keys this repository's worktree stacks by the worktree they ran from", () => {
    const map = adoptableStacks(
      [
        c("my-app-wt-4-a", "/w/app-a"),
        c("my-app-wt-4-a", "/w/app-a", "exited"),
        c("my-app-wt-2-a", "/w/app-a", "exited"),
        c("my-app-wt-7-b", "/w/app-b/infra"), // compose ran in a subdirectory: not this worktree
        c("my-app-wt-9-b", "/w/app-b", "running", true), // one-off only
        c("myapp-wt-5-b", "/w/app-b"), // another repo's prefix
        c("my-app-web", "/w/app-b"),
      ],
      "My.App",
      worktrees,
    );
    expect([...map]).toEqual([["/w/app-a", { index: 4, project: "my-app-wt-4-a" }]]);
  });

  it("never adopts a project name compose would reject (a label that did not parse cleanly)", () => {
    const map = adoptableStacks(
      [c("my-app-wt-3-a,desktop.docker.io/binds/0/SourceKind=hostFile", "/w/app-a"), c("my-app-wt-2-b", "/w/app-b")],
      "My.App",
      worktrees,
    );
    expect([...map]).toEqual([["/w/app-b", { index: 2, project: "my-app-wt-2-b" }]]);
  });
});

describe("worktree identity across git operations", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
    write(root, "compose.yaml", 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-8080}:80"\n');
    commitAll(root, "compose");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("git worktree move keeps the index and project (no orphan to prune)", () => {
    const a = addWorktree(root, base, "myapp-a", "feat-a");
    addWorktree(root, base, "myapp-b", "feat-b");
    expect(buildContext({}, { cwd: root, probeStacks: true }).worktrees.map((w) => w.project)).toEqual([
      "myapp-wt-1-feat-a",
      "myapp-wt-2-feat-b",
    ]);
    const moved = path.join(base, "zz-myapp-a-moved"); // now listed after feat-b
    git(root, "worktree", "move", a, moved);

    const ctx = buildContext({}, { cwd: root });
    expect(ctx.orphans).toEqual([]);
    expect(ctx.worktrees.map((w) => [w.path, w.index, w.project])).toEqual([
      [path.join(base, "myapp-b"), 2, "myapp-wt-2-feat-b"],
      [moved, 1, "myapp-wt-1-feat-a"],
    ]);
  });

  it("a new worktree at a reused path does not inherit the old one's stack", () => {
    const slot = addWorktree(root, base, "slot1", "feat-a");
    buildContext({}, { cwd: root, probeStacks: true });
    git(root, "worktree", "remove", "--force", slot);
    git(root, "worktree", "add", "-q", slot, "-b", "feat-x");

    const ctx = buildContext({}, { cwd: root });
    expect(ctx.worktrees.map((w) => [w.branch, w.index, w.project])).toEqual([["feat-x", 2, "myapp-wt-2-feat-x"]]);
    expect(ctx.orphans.map((o) => o.project)).toEqual(["myapp-wt-1-feat-a"]);
  });
});

describe("bare repo + worktrees (fake engine)", () => {
  let base: string;
  let mainWt: string;
  let featWt: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    const seed = makeRepo("seed");
    write(seed.root, "compose.yaml", 'services:\n  cache:\n    image: redis\n    ports:\n      - "${REDIS_PORT:-6391}:6379"\n');
    write(seed.root, ".gitignore", ".env\n");
    commitAll(seed.root, "compose");
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-bare-")));
    git(base, "clone", "-q", "--bare", seed.root, path.join(base, "proj.git"));
    fs.rmSync(seed.base, { recursive: true, force: true });
    mainWt = path.join(base, "proj-main");
    featWt = path.join(base, "proj-feat");
    git(path.join(base, "proj.git"), "worktree", "add", "-q", mainWt, "main");
    git(path.join(base, "proj.git"), "worktree", "add", "-q", featWt, "-b", "feat");
    write(mainWt, ".env", "SECRET=only-copy-here\nREDIS_PORT=6391\n");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("never starts or rewrites the main checkout, whichever worktree wtc runs from", async () => {
    for (const from of [mainWt, featWt]) {
      const result = await startWorktrees({ build: false }, silentReporter, { live: false, cwd: from });
      expect(result.started.map((s) => [s.path, s.project])).toEqual([[featWt, "proj-wt-1-feat"]]);
    }
    expect(fs.readFileSync(path.join(mainWt, ".env"), "utf-8")).toBe("SECRET=only-copy-here\nREDIS_PORT=6391\n");
    expect(fs.readFileSync(path.join(featWt, ".env"), "utf-8")).toContain("REDIS_PORT=26392");
  });

  it("clean from a linked worktree never removes the main checkout", async () => {
    const other = path.join(base, "proj-other");
    git(path.join(base, "proj.git"), "worktree", "add", "-q", other, "-b", "other");
    const result = await clean({ sweepRunner: () => "" }, silentReporter, { live: false, cwd: featWt });
    expect(result.removed).toEqual([other]);
    expect(fs.existsSync(path.join(mainWt, ".env"))).toBe(true);
  });
});
