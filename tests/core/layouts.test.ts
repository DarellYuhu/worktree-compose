import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContext } from "../../src/context.js";
import { clean } from "../../src/core/clean.js";
import { listWorktrees } from "../../src/core/list.js";
import { prune } from "../../src/core/prune.js";
import { restartWorktrees } from "../../src/core/restart.js";
import { startWorktrees } from "../../src/core/start.js";
import { stopWorktrees } from "../../src/core/stop.js";
import { listRepoWorktrees } from "../../src/git/repo.js";
import { peekState, recordIsLive, stateFile, writeState } from "../../src/state/registry.js";
import { CollectingReporter, silentReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine, podmanContainer } from "../helpers/fake-engine.js";

const COMPOSE = 'services:\n  cache:\n    image: redis\n    ports:\n      - "${REDIS_PORT:-6391}:6379"\n';
const io = (cwd: string) => ({ live: false, cwd });
const downs = (log: string[]) => log.filter((l) => / down /.test(` ${l} `));

describe("bare repo whose main worktree is not on the default branch (mid-rebase)", () => {
  let base: string;
  let bareDir: string;
  let mainWt: string;
  let aWt: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    const seed = makeRepo("seed");
    write(seed.root, "compose.yaml", COMPOSE);
    write(seed.root, ".gitignore", ".env\n");
    commitAll(seed.root, "compose");
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-midrebase-")));
    bareDir = path.join(base, "proj.git");
    git(base, "clone", "-q", "--bare", seed.root, bareDir);
    fs.rmSync(seed.base, { recursive: true, force: true });
    mainWt = path.join(base, "proj-main");
    aWt = path.join(base, "proj-a");
    git(bareDir, "worktree", "add", "-q", mainWt, "main");
    git(bareDir, "worktree", "add", "-q", aWt, "-b", "a");
    write(mainWt, ".env", "SECRET=only-copy-in-primary\n");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("finds the recorded main worktree while it is detached: nothing is pruned or written into it", async () => {
    await startWorktrees({ build: false }, silentReporter, io(aWt));
    expect(peekState(bareDir)?.mainCheckout).toBe(mainWt);
    git(mainWt, "checkout", "-q", "--detach");

    const pruned = await prune({}, silentReporter, io(aWt));
    expect(pruned.orphans).toEqual([]);
    expect(downs(engine.composeLog())).toEqual([]);

    const started = await startWorktrees({ build: false }, silentReporter, io(aWt));
    expect(started.started.map((s) => [s.path, s.project])).toEqual([[aWt, "proj-wt-1-a"]]);
    expect(fs.readFileSync(path.join(mainWt, ".env"), "utf-8")).toBe("SECRET=only-copy-in-primary\n");
  });

  it("without a known main checkout, the current worktree's stack is never pruned and start/restart/clean refuse", async () => {
    await startWorktrees({ build: false }, silentReporter, io(aWt));
    const recorded = peekState(bareDir)!;
    writeState(bareDir, { ...recorded, mainCheckout: undefined });
    const before = fs.readFileSync(stateFile(bareDir), "utf-8");
    git(mainWt, "checkout", "-q", "--detach");

    // Listed as a live worktree, never as removed; the primary is not registered.
    const listed = listWorktrees(io(aWt));
    expect(listed.rows.map((r) => [r.index, r.branch, r.orphan])).toEqual([
      [1, "a", false],
      [2, "detached", false],
    ]);
    expect(listed.warnings.join("\n")).toMatch(/Cannot locate the main checkout/);

    const ctx = buildContext({}, { cwd: aWt });
    expect(ctx.orphans).toEqual([]);
    expect(recordIsLive(recorded.worktrees[0], listRepoWorktrees(ctx.repo))).toBe(true);

    const pruned = await prune({}, silentReporter, io(aWt));
    expect(pruned.orphans).toEqual([]);
    expect(downs(engine.composeLog())).toEqual([]);

    const refused = /Refusing to .*cannot locate the main checkout.*default branch \(main\) checked out/;
    await expect(startWorktrees({ build: false }, silentReporter, io(aWt))).rejects.toThrow(refused);
    await expect(restartWorktrees({ build: false }, silentReporter, io(aWt))).rejects.toThrow(refused);
    await expect(clean({ sweepRunner: () => "" }, silentReporter, io(aWt))).rejects.toThrow(refused);
    await expect(clean({ dryRun: true, sweepRunner: () => "" }, silentReporter, io(aWt))).rejects.toThrow(refused);

    // Nothing was stopped, written into the primary, removed, or recorded.
    expect(engine.composeLog().filter((l) => !l.endsWith(" up -d"))).toEqual([]);
    expect(fs.readFileSync(path.join(mainWt, ".env"), "utf-8")).toBe("SECRET=only-copy-in-primary\n");
    expect(fs.existsSync(mainWt)).toBe(true);
    expect(fs.readFileSync(stateFile(bareDir), "utf-8")).toBe(before);
  });

  it("a record held by the worktree that is now the main checkout is not an orphan; prune and clean leave it", async () => {
    // The pre-fix fallback registered the primary as a worktree.
    const startedAt = new Date().toISOString();
    writeState(bareDir, {
      version: 1,
      worktrees: [{ path: mainWt, index: 2, project: "proj-wt-2-detached", branch: "detached", createdAt: startedAt }],
    });

    const ctx = buildContext({}, { cwd: aWt });
    expect(ctx.orphans).toEqual([]);
    expect(ctx.unavailable).toMatchObject([{ index: 2, project: "proj-wt-2-detached", reason: "main" }]);
    expect(ctx.worktrees.map((w) => [w.path, w.index])).toEqual([[aWt, 1]]);

    const pruned = await prune({}, silentReporter, io(aWt));
    expect(pruned.orphans).toEqual([]);
    const reporter = new CollectingReporter();
    const cleaned = await clean({ keepWorktrees: true, sweepRunner: () => "" }, reporter, io(aWt));
    expect(cleaned.stacks.map((s) => s.project)).toEqual(["proj-wt-1-a"]);
    expect(cleaned.skipped).toContainEqual({ path: mainWt, reason: "its worktree is now the main checkout" });
    expect(downs(engine.composeLog()).every((l) => !l.includes("proj-wt-2-"))).toBe(true);
    expect(peekState(bareDir)?.worktrees.map((r) => r.project)).toContain("proj-wt-2-detached");
  });
});

describe("--separate-git-dir repository used from a linked worktree", () => {
  let base: string;
  let work: string;
  let gitDir: string;
  let aWt: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-sepgit-")));
    work = path.join(base, "work");
    gitDir = path.join(base, "sep.git");
    fs.mkdirSync(work);
    git(work, "init", "-q", "--separate-git-dir", gitDir);
    write(work, "compose.yaml", COMPOSE);
    write(work, ".gitignore", ".env\n");
    commitAll(work, "init");
    aWt = addWorktree(work, base, "work-a", "a");
    addWorktree(work, base, "work-b", "b");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("finds the main checkout once a run from it recorded it: same names, no orphans", async () => {
    await startWorktrees({ build: false }, silentReporter, io(work));
    expect(peekState(gitDir)?.mainCheckout).toBe(work);

    const ctx = buildContext({}, { cwd: aWt });
    expect(ctx.repo).toMatchObject({ mainRoot: work, repoName: "work", mainRootIsFallback: false });
    expect(ctx.orphans).toEqual([]);

    // A worktree registered from a linked worktree gets the main checkout's prefix.
    addWorktree(work, base, "work-c", "c");
    const started = await startWorktrees({ worktrees: ["c"], build: false }, silentReporter, io(aWt));
    expect(started.started.map((s) => s.project)).toEqual(["work-wt-3-c"]);
  });

  it("without it, never treats the current worktree as removed; start refuses", async () => {
    await startWorktrees({ build: false }, silentReporter, io(work));
    writeState(gitDir, { ...peekState(gitDir)!, mainCheckout: undefined });
    const before = fs.readFileSync(stateFile(gitDir), "utf-8");

    const listed = listWorktrees(io(aWt));
    expect(listed.rows.map((r) => [r.index, r.branch, r.orphan])).toEqual([
      [1, "a", false],
      [2, "b", false],
    ]);
    const dry = await prune({ dryRun: true }, silentReporter, io(aWt));
    expect(dry.orphans).toEqual([]);
    const pruned = await prune({}, silentReporter, io(aWt));
    expect(pruned.orphans).toEqual([]);
    expect(downs(engine.composeLog())).toEqual([]);

    await expect(startWorktrees({ build: false }, silentReporter, io(aWt))).rejects.toThrow(
      /Refusing to start worktree stacks: cannot locate the main checkout.*--separate-git-dir/,
    );
    // A new worktree seen from here is not registered under a wrong prefix.
    addWorktree(work, base, "work-c", "c");
    await stopWorktrees({}, silentReporter, io(aWt));
    expect(fs.readFileSync(stateFile(gitDir), "utf-8")).toBe(before);
  });
});

describe("locked worktree whose checkout is missing (unmounted drive)", () => {
  let base: string;
  let root: string;
  let ext: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(async () => {
    ({ base, root } = makeRepo("lockrepo"));
    write(root, "compose.yaml", COMPOSE);
    write(root, ".gitignore", ".env\n");
    commitAll(root, "compose");
    fs.mkdirSync(path.join(base, "drive"));
    ext = addWorktree(root, base, path.join("drive", "ext"), "ext");
    git(root, "worktree", "lock", "--reason", "on external drive", ext);
    engine = installFakeEngine(base);
    await startWorktrees({ build: false }, silentReporter, io(root));
    fs.renameSync(path.join(base, "drive"), path.join(base, "drive-unmounted"));
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps its record, index and stack: not an orphan, never pruned or cleaned", async () => {
    const record = peekState(path.join(root, ".git"))!.worktrees[0];
    expect(record).toMatchObject({ index: 1, project: "lockrepo-wt-1-ext" });

    const ctx = buildContext({}, { cwd: root });
    expect(ctx.orphans).toEqual([]);
    expect(ctx.unavailable).toMatchObject([{ index: 1, project: "lockrepo-wt-1-ext", reason: "missing" }]);
    expect(ctx.warnings.join("\n")).toMatch(/locked but missing on disk.*index 1 and stack lockrepo-wt-1-ext are kept/);
    expect(recordIsLive(record, listRepoWorktrees(ctx.repo))).toBe(true);

    const listed = listWorktrees(io(root));
    expect(listed.rows).toMatchObject([{ index: 1, orphan: false, unavailable: "missing" }]);

    expect((await prune({ dryRun: true }, silentReporter, io(root))).orphans).toEqual([]);
    expect((await prune({}, silentReporter, io(root))).orphans).toEqual([]);
    const cleaned = await clean({ keepWorktrees: true, sweepRunner: () => "" }, silentReporter, io(root));
    expect(cleaned.stacks).toEqual([]);
    expect(cleaned.skipped).toContainEqual({
      path: ext,
      reason: "its worktree is locked and missing on disk (unmounted drive?)",
    });
    expect(downs(engine.composeLog())).toEqual([]);
    expect(peekState(path.join(root, ".git"))?.worktrees).toEqual([record]);

    // Its index stays reserved; once remounted it is the same worktree again.
    addWorktree(root, base, "lockrepo-b", "b");
    expect(buildContext({}, { cwd: root }).worktrees.map((w) => [w.branch, w.index])).toEqual([["b", 2]]);
    fs.renameSync(path.join(base, "drive-unmounted"), path.join(base, "drive"));
    const back = buildContext({}, { cwd: root });
    expect(back.worktrees.find((w) => w.path === ext)).toMatchObject({ index: 1, project: "lockrepo-wt-1-ext", id: record.id });
    expect(peekState(path.join(root, ".git"))?.worktrees.find((r) => r.index === 1)).toEqual(record);
  });
});

describe("stop with a lost or corrupt registry", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    ({ base, root } = makeRepo("stoprepo"));
    write(root, "compose.yaml", COMPOSE);
    commitAll(root, "compose");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("stops the running stacks (adopted by working_dir), not positional names that never existed", async () => {
    const a = addWorktree(root, base, "stoprepo-a", "alpha");
    const z = addWorktree(root, base, "stoprepo-z", "zeta");
    // zeta was created first: index 1, alpha index 2 — the reverse of git's order.
    engine.setContainers([
      podmanContainer("stoprepo-wt-1-zeta", "running", z),
      podmanContainer("stoprepo-wt-2-alpha", "running", a),
    ]);
    const state = stateFile(path.join(root, ".git"));
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, "{ truncated");

    const result = await stopWorktrees({ worktrees: ["1"] }, silentReporter, io(root));
    expect(result.stopped).toEqual([{ index: 1, branch: "zeta", project: "stoprepo-wt-1-zeta" }]);
    expect(engine.composeLog()).toEqual(["-p stoprepo-wt-1-zeta stop"]);
    await stopWorktrees({}, silentReporter, io(root));
    expect(engine.composeLog().slice(1).sort()).toEqual(["-p stoprepo-wt-1-zeta stop", "-p stoprepo-wt-2-alpha stop"]);
  });

  it("clean tears down the running stacks' real projects when no registry exists yet (≤0.2 upgrade)", async () => {
    const a = addWorktree(root, base, "stoprepo-a", "alpha");
    const z = addWorktree(root, base, "stoprepo-z", "zeta");
    // 0.2 numbered them before a worktree between them was removed.
    engine.setContainers([
      podmanContainer("stoprepo-wt-3-zeta", "running", z),
      podmanContainer("stoprepo-wt-2-alpha", "running", a),
    ]);

    await clean({ keepWorktrees: true }, silentReporter, io(root));
    expect(downs(engine.composeLog()).map((l) => l.split(" ")[1]).sort()).toEqual([
      "stoprepo-wt-2-alpha",
      "stoprepo-wt-3-zeta",
    ]);
  });
});
