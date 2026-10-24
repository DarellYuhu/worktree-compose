import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NewerStateError,
  forgetRecords,
  peekState,
  reconcileWorktrees,
  recordEnvFiles,
  recordIsLive,
  stateFile,
  withStateLock,
} from "../../src/state/registry.js";
import type { AdoptableStack } from "../../src/state/registry.js";
import type { WorktreeInfo } from "../../src/git/worktree.js";

/** A PID that is certainly not running: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf-8",
  });
  return Number(child.stdout);
}

function wt(p: string, branch: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: p,
    branch,
    isMain: false,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    ...extra,
  };
}

describe("worktree registry", () => {
  let commonDir: string;
  const main = wt("/repo/myapp", "main", { isMain: true });
  const a = wt("/repo/wt-a", "feat-a");
  const b = wt("/repo/wt-b", "feat-b");
  const c = wt("/repo/wt-c", "feat-c");
  const d = wt("/repo/wt-d", "feat-d");

  /**
   * Reconcile as an engine-aware command would: a stack probe answered and
   * reported nothing to adopt (unless `adoptable` says otherwise).
   * "no-probe" = no stack probe was available (adoptable undefined).
   */
  function reconcile(
    worktrees: WorktreeInfo[],
    adoptable: Map<string, AdoptableStack> | "no-probe" = new Map(),
    extra: { readOnly?: boolean } = {},
  ) {
    return reconcileWorktrees({
      commonDir,
      repoName: "myapp",
      listWorktrees: () => worktrees,
      adoptable: adoptable === "no-probe" ? undefined : adoptable,
      ...extra,
    });
  }

  function indices(result: ReturnType<typeof reconcile>): Record<string, number> {
    return Object.fromEntries(result.worktrees.map((w) => [w.branch, w.index]));
  }

  beforeEach(() => {
    commonDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-state-")));
  });

  afterEach(() => {
    fs.rmSync(commonDir, { recursive: true, force: true });
  });

  it("adopts ≤0.2 positional indices and project names on first run", () => {
    const result = reconcile([main, a, b, c]);
    expect(indices(result)).toEqual({ "feat-a": 1, "feat-b": 2, "feat-c": 3 });
    expect(result.worktrees.map((w) => w.project)).toEqual([
      "myapp-wt-1-feat-a",
      "myapp-wt-2-feat-b",
      "myapp-wt-3-feat-c",
    ]);
  });

  it("counts prunable entries for legacy positions, like ≤0.2 did", () => {
    const gone = wt("/repo/wt-gone", "old", { prunable: true });
    const result = reconcile([main, gone, a]);
    expect(indices(result)).toEqual({ "feat-a": 2 });
  });

  it("keeps indices stable when an earlier worktree is removed (#9)", () => {
    reconcile([main, a, b, c]);

    const afterRemoval = reconcile([main, b, c]);
    expect(indices(afterRemoval)).toEqual({ "feat-b": 2, "feat-c": 3 });
    expect(afterRemoval.worktrees.map((w) => w.project)).toEqual([
      "myapp-wt-2-feat-b",
      "myapp-wt-3-feat-c",
    ]);
    // The removed worktree's stack may still hold its ports: index 1 stays reserved.
    expect(afterRemoval.orphans.map((o) => o.index)).toEqual([1]);
    expect(indices(reconcile([main, b, c, d]))).toEqual({
      "feat-b": 2,
      "feat-c": 3,
      "feat-d": 4,
    });
  });

  it("never releases an orphan on its own: new worktrees skip its index until it is forgotten", () => {
    reconcile([main, a, b, c]);
    const result = reconcile([main, b, c, d]);
    expect(indices(result)).toEqual({ "feat-b": 2, "feat-c": 3, "feat-d": 4 });
    expect(result.orphans.map((o) => o.project)).toEqual(["myapp-wt-1-feat-a"]);
    // Its directory is long gone and nothing runs — still kept until prune/clean.
    expect(reconcile([main, b, c, d]).orphans.map((o) => o.index)).toEqual([1]);

    forgetRecords(commonDir, ["myapp-wt-1-feat-a"]);
    expect(peekState(commonDir)?.retired).toEqual(["myapp-wt-1-feat-a"]);
    const e = wt("/repo/wt-e", "feat-e");
    expect(indices(reconcile([main, b, c, d, e]))).toEqual({ "feat-b": 2, "feat-c": 3, "feat-d": 4, "feat-e": 1 });
  });

  it("lists worktrees inside the lock", () => {
    reconcile([main, a]);
    const lock = path.join(commonDir, "wtc", "state.lock");
    let lockedWhileListing = false;
    reconcileWorktrees({
      commonDir,
      repoName: "myapp",
      listWorktrees: () => {
        lockedWhileListing = fs.existsSync(lock);
        return [main, a, b];
      },
    });
    expect(lockedWhileListing).toBe(true);
  });

  it("reuses the lowest free index after a record is forgotten", () => {
    reconcile([main, a, b, c]);
    forgetRecords(commonDir, ["myapp-wt-2-feat-b"]);
    expect(peekState(commonDir)?.retired).toEqual(["myapp-wt-2-feat-b"]);
    expect(indices(reconcile([main, a, c, d]))).toEqual({
      "feat-a": 1,
      "feat-c": 3,
      "feat-d": 2,
    });
  });

  it("keeps the project name when the branch is renamed", () => {
    reconcile([main, a]);
    const renamed = reconcile([main, wt(a.path, "renamed")]);
    expect(renamed.worktrees[0]).toMatchObject({
      branch: "renamed",
      index: 1,
      project: "myapp-wt-1-feat-a",
    });
  });

  it("does not create the state directory when there is nothing to record", () => {
    reconcile([main]);
    expect(fs.existsSync(path.join(commonDir, "wtc"))).toBe(false);
  });

  it("backs up a corrupt state file and starts fresh", () => {
    fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
    fs.writeFileSync(stateFile(commonDir), "{ not json");

    const result = reconcile([main, a]);
    expect(result.warnings.join("\n")).toMatch(/unreadable/);
    expect(indices(result)).toEqual({ "feat-a": 1 });
    const backups = fs.readdirSync(path.join(commonDir, "wtc")).filter((f) => f.startsWith("state.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(commonDir, "wtc", backups[0]), "utf-8")).toBe("{ not json");
  });

  it("recovers a corrupt registry from running stacks before falling back to positions", () => {
    fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
    fs.writeFileSync(stateFile(commonDir), JSON.stringify({ version: 1, worktrees: "oops" }));
    // Non-positional identities from before the corruption: b=3, c=1.
    const adoptable = new Map([
      [b.path, { index: 3, project: "myapp-wt-3-feat-b" }],
      [c.path, { index: 1, project: "myapp-wt-1-feat-c" }],
    ]);
    const result = reconcile([main, a, b, c], adoptable);
    expect(result.warnings.join("\n")).toMatch(/"worktrees" is not an array.*moved it to/);
    expect(indices(result)).toEqual({ "feat-a": 2, "feat-b": 3, "feat-c": 1 });
    expect(peekState(commonDir)?.worktrees.map((r) => r.project).sort()).toEqual([
      "myapp-wt-1-feat-c",
      "myapp-wt-2-feat-a",
      "myapp-wt-3-feat-b",
    ]);
  });

  it("does not persist an empty registry when no stack probe was available", () => {
    const blind = reconcile([main, a, b], "no-probe");
    expect(indices(blind)).toEqual({ "feat-a": 1, "feat-b": 2 });
    expect(fs.existsSync(path.join(commonDir, "wtc"))).toBe(false);

    // The next engine-aware command adopts what runs and persists it.
    const seen = reconcile([main, a, b], new Map([[b.path, { index: 5, project: "myapp-wt-5-feat-b" }]]));
    expect(indices(seen)).toEqual({ "feat-a": 1, "feat-b": 5 });
    expect(peekState(commonDir)?.worktrees).toHaveLength(2);

    // Once records exist, a probe-less command still records new worktrees.
    expect(indices(reconcile([main, a, b, c], "no-probe"))).toEqual({ "feat-a": 1, "feat-b": 5, "feat-c": 2 });
    expect(peekState(commonDir)?.worktrees).toHaveLength(3);
  });

  describe("read-only reconcile", () => {
    it("computes identities without writing the registry or creating ids", () => {
      const admin = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-admin-ro-"));
      try {
        const withAdmin = wt("/repo/wt-x", "feat-x", { adminDir: admin });
        const result = reconcile([main, a, withAdmin], new Map(), { readOnly: true });
        expect(indices(result)).toEqual({ "feat-a": 1, "feat-x": 2 });
        expect(fs.existsSync(path.join(commonDir, "wtc"))).toBe(false);
        expect(fs.readdirSync(admin)).toEqual([]);

        reconcile([main, a]);
        const before = fs.readFileSync(stateFile(commonDir), "utf-8");
        const next = reconcile([main, a, b], new Map(), { readOnly: true });
        expect(indices(next)).toEqual({ "feat-a": 1, "feat-b": 2 });
        expect(fs.readFileSync(stateFile(commonDir), "utf-8")).toBe(before);
        expect(fs.readdirSync(path.join(commonDir, "wtc"))).toEqual(["state.json"]);
      } finally {
        fs.rmSync(admin, { recursive: true, force: true });
      }
    });

    it("reports a corrupt registry but leaves it in place", () => {
      fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
      fs.writeFileSync(stateFile(commonDir), "{ not json");
      const result = reconcile([main, a], new Map(), { readOnly: true });
      expect(result.warnings.join("\n")).toMatch(/unreadable .*Left in place/);
      expect(fs.readdirSync(path.join(commonDir, "wtc"))).toEqual(["state.json"]);
      expect(fs.readFileSync(stateFile(commonDir), "utf-8")).toBe("{ not json");
    });

    it("still refuses a registry from a newer wtc", () => {
      fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
      fs.writeFileSync(stateFile(commonDir), JSON.stringify({ version: 3, worktrees: [] }));
      expect(() => reconcile([main, a], new Map(), { readOnly: true })).toThrow(NewerStateError);
    });
  });

  it("refuses a state file written by a newer wtc and leaves it untouched", () => {
    fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
    const newer = JSON.stringify({ version: 2, worktrees: [{ path: "/x", index: 7 }] });
    fs.writeFileSync(stateFile(commonDir), newer);
    expect(() => reconcile([main, a])).toThrow(NewerStateError);
    expect(() => reconcile([main, a])).toThrow(/newer wtc \(state version 2\); upgrade wtc/);
    expect(fs.readFileSync(stateFile(commonDir), "utf-8")).toBe(newer);
    expect(fs.readdirSync(path.join(commonDir, "wtc"))).toEqual(["state.json"]);
  });

  it("backs up a state file with an invalid version", () => {
    fs.mkdirSync(path.join(commonDir, "wtc"), { recursive: true });
    fs.writeFileSync(stateFile(commonDir), JSON.stringify({ version: "1", worktrees: [] }));
    const result = reconcile([main, a]);
    expect(result.warnings.join("\n")).toMatch(/unsupported state version "1"/);
  });

  it("seeds an empty registry from running stacks instead of renumbering them", () => {
    // feat-d reused index 1 after feat-a was removed; the registry was lost.
    const adoptable = new Map([
      [d.path, { index: 1, project: "myapp-wt-1-feat-d" }],
      [b.path, { index: 2, project: "myapp-wt-2-feat-b" }],
      [c.path, { index: 3, project: "myapp-wt-3-feat-c" }],
    ]);
    const e = wt("/repo/wt-e", "feat-e");
    const result = reconcile([main, b, c, d, e], adoptable);
    expect(indices(result)).toEqual({ "feat-b": 2, "feat-c": 3, "feat-d": 1, "feat-e": 4 });
    expect(result.worktrees.find((w) => w.branch === "feat-d")?.project).toBe("myapp-wt-1-feat-d");
  });

  it("lets a new worktree adopt its running stack when that index is free", () => {
    reconcile([main, a]);
    const adoptable = new Map([[b.path, { index: 9, project: "myapp-wt-9-feat-b" }]]);
    const result = reconcile([main, a, b], adoptable);
    expect(indices(result)).toEqual({ "feat-a": 1, "feat-b": 9 });
    expect(result.worktrees[1].project).toBe("myapp-wt-9-feat-b");
  });

  it("never adopts an index an orphan still holds", () => {
    reconcile([main, a, b]);
    // wt-a was removed; a new worktree at wt-c ran a stack that claims index 1.
    const adoptable = new Map([[c.path, { index: 1, project: "myapp-wt-1-feat-c" }]]);
    const result = reconcile([main, b, c], adoptable);
    expect(indices(result)).toEqual({ "feat-b": 2, "feat-c": 3 });
    expect(result.orphans.map((o) => o.index)).toEqual([1]);
  });

  it("writes atomically: valid JSON and no temp files left behind", () => {
    reconcile([main, a, b]);
    const dir = path.join(commonDir, "wtc");
    expect(fs.readdirSync(dir).sort()).toEqual(["state.json"]);
    const doc = JSON.parse(fs.readFileSync(stateFile(commonDir), "utf-8"));
    expect(doc.version).toBe(1);
    expect(doc.worktrees.map((r: { index: number }) => r.index)).toEqual([1, 2]);
  });

  it("breaks a lock whose holder is dead", () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${deadPid()}:dead-holder-token`);

    const start = Date.now();
    expect(withStateLock(commonDir, () => "ran")).toBe("ran");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("holds <pid>:<token> while locked and removes it afterwards", () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    const seen = withStateLock(commonDir, () => fs.readFileSync(lock, "utf-8"));
    expect(seen).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("breaks any lock older than 10 minutes, even with a live or unreadable holder", () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const old = new Date(Date.now() - 11 * 60_000);
    for (const content of [`${process.ppid}:wedged-holder`, ""]) {
      fs.writeFileSync(lock, content);
      fs.utimesSync(lock, old, old);
      expect(withStateLock(commonDir, () => "ran")).toBe("ran");
      expect(fs.existsSync(lock)).toBe(false);
    }
  });

  it("does not break an unreadable lock younger than 10 minutes", () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(() => withStateLock(commonDir, () => "stolen", { timeoutMs: 200 })).toThrow(/Timed out/);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("never breaks an old lock whose holder is still running", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      const lock = path.join(commonDir, "wtc", "state.lock");
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const content = `${holder.pid}:live-holder-token`;
      fs.writeFileSync(lock, content);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      expect(() => withStateLock(commonDir, () => "stolen", { timeoutMs: 300 })).toThrow(
        new RegExp(`Timed out waiting for the wtc state lock .*held by process ${holder.pid}`),
      );
      expect(fs.readFileSync(lock, "utf-8")).toBe(content);
    } finally {
      holder.kill();
    }
  });

  it("does not delete a lock it no longer owns", () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    withStateLock(commonDir, () => {
      // A waiter broke our lock and took a fresh one meanwhile.
      fs.rmSync(lock);
      fs.writeFileSync(lock, "999999:someone-else");
    });
    expect(fs.readFileSync(lock, "utf-8")).toBe("999999:someone-else");
  });

  it("waits for a held lock to be released", async () => {
    const lock = path.join(commonDir, "wtc", "state.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "other");

    // Another process releases the lock after ~300 ms.
    const child = spawn(process.execPath, [
      "-e",
      `setTimeout(() => require("fs").rmSync(${JSON.stringify(lock)}), 300)`,
    ]);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    // Give the child time to boot before blocking this thread.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    expect(withStateLock(commonDir, () => "acquired")).toBe("acquired");
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    await exited;
  });

  describe("stable worktree ids", () => {
    let admin: string;

    beforeEach(() => {
      admin = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-admin-"));
    });

    afterEach(() => {
      fs.rmSync(admin, { recursive: true, force: true });
    });

    function adminDir(name: string): string {
      const dir = path.join(admin, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("follows a moved worktree (same admin dir) instead of orphaning its stack", () => {
      const dir = adminDir("wt-a");
      reconcile([main, wt("/repo/wt-a", "feat-a", { adminDir: dir }), b]);
      expect(fs.readFileSync(path.join(dir, "wtc-id"), "utf-8").trim()).toMatch(/^[0-9a-f-]{36}$/);

      const moved = reconcile([main, wt("/repo/wt-a-moved", "feat-a", { adminDir: dir }), b]);
      expect(moved.orphans).toEqual([]);
      expect(moved.worktrees[0]).toMatchObject({ path: "/repo/wt-a-moved", index: 1, project: "myapp-wt-1-feat-a" });
      expect(peekState(commonDir)?.worktrees.find((r) => r.index === 1)?.path).toBe("/repo/wt-a-moved");
    });

    it("treats a new worktree at a reused path as a new worktree", () => {
      const first = adminDir("slot1");
      reconcile([main, wt("/repo/slot1", "feat-a", { adminDir: first })]);
      // git worktree remove + add at the same path: a fresh admin dir, no id yet.
      fs.rmSync(first, { recursive: true, force: true });
      const second = adminDir("slot1-new");

      const result = reconcile([main, wt("/repo/slot1", "feat-x", { adminDir: second })]);
      expect(result.worktrees[0]).toMatchObject({ branch: "feat-x", index: 2, project: "myapp-wt-2-feat-x" });
      expect(result.orphans.map((o) => o.project)).toEqual(["myapp-wt-1-feat-a"]);

      // Forgetting the orphan (by project) keeps the new worktree's record.
      forgetRecords(commonDir, ["myapp-wt-1-feat-a"]);
      expect(peekState(commonDir)?.worktrees.map((r) => r.project)).toEqual(["myapp-wt-2-feat-x"]);
    });

    it("adopts a record without an id by path and stamps it", () => {
      reconcile([main, a]);
      expect(peekState(commonDir)?.worktrees[0].id).toBeUndefined();
      const dir = adminDir("wt-a");
      const result = reconcile([main, wt(a.path, "feat-a", { adminDir: dir })]);
      expect(result.worktrees[0]).toMatchObject({ index: 1, project: "myapp-wt-1-feat-a" });
      const id = fs.readFileSync(path.join(dir, "wtc-id"), "utf-8").trim();
      expect(peekState(commonDir)?.worktrees[0].id).toBe(id);
    });

    it("recordEnvFiles merges worktree-relative paths into the live worktree's record", () => {
      const wtDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-envfiles-")));
      try {
        const pointAt = (dir: string) => fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${dir}\n`);
        const firstAdmin = adminDir("env-1");
        pointAt(firstAdmin);
        reconcile([main, wt(wtDir, "feat-e", { adminDir: firstAdmin })]);

        recordEnvFiles(commonDir, wtDir, [path.join(wtDir, ".env"), "api/.env", ".env", "../outside/.env"]);
        recordEnvFiles(commonDir, wtDir, [path.join("api", ".env"), "web/.env.local"]);
        expect(peekState(commonDir)?.worktrees[0].envFiles).toEqual([".env", "api/.env", "web/.env.local"]);
        expect(reconcile([main, wt(wtDir, "feat-e", { adminDir: firstAdmin })]).worktrees[0].envFiles).toEqual([
          ".env",
          "api/.env",
          "web/.env.local",
        ]);

        // Removed and re-added at the same path: the orphan keeps its list,
        // the new worktree's record gets the new one.
        fs.rmSync(firstAdmin, { recursive: true, force: true });
        const secondAdmin = adminDir("env-2");
        pointAt(secondAdmin);
        reconcile([main, wt(wtDir, "feat-f", { adminDir: secondAdmin })]);
        recordEnvFiles(commonDir, wtDir, [".env.dev"]);
        const byProject = Object.fromEntries(
          peekState(commonDir)!.worktrees.map((r) => [r.project, r.envFiles]),
        );
        expect(byProject).toEqual({
          "myapp-wt-1-feat-e": [".env", "api/.env", "web/.env.local"],
          "myapp-wt-2-feat-f": [".env.dev"],
        });
      } finally {
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
    });

    it("keeps the record of a locked worktree missing on disk: unavailable, never an orphan", () => {
      const dir = adminDir("wt-a");
      reconcile([main, wt(a.path, "feat-a", { adminDir: dir }), b]);
      const record = peekState(commonDir)!.worktrees.find((r) => r.index === 1)!;
      const unmounted = wt(a.path, "feat-a", { locked: true, missing: true, adminDir: dir });

      const result = reconcile([main, unmounted, b, c]);
      expect(result.orphans).toEqual([]);
      expect(result.unavailable).toEqual([{ ...record, reason: "missing" }]);
      expect(indices(result)).toEqual({ "feat-b": 2, "feat-c": 3 });
      expect(recordIsLive(record, [main, unmounted])).toBe(true);
      // Without its admin dir (not found), the path still identifies it.
      const noAdmin = wt(a.path, "feat-a", { locked: true, missing: true });
      expect(reconcile([main, noAdmin, b, c]).orphans).toEqual([]);
      expect(recordIsLive(record, [main, noAdmin])).toBe(true);
      // Gone for real (git reports it prunable): an orphan.
      expect(recordIsLive(record, [main, wt(a.path, "feat-a", { prunable: true })])).toBe(false);

      const back = reconcile([main, wt(a.path, "feat-a", { adminDir: dir }), b, c]);
      expect(back.worktrees.find((w) => w.path === a.path)).toMatchObject({ index: 1, id: record.id });
      expect(peekState(commonDir)!.worktrees.find((r) => r.index === 1)).toEqual(record);
    });

    it("keeps the record of a worktree that became the main checkout (bare layouts)", () => {
      const bareRepo = wt("/repo/proj.git", "main", { isMain: true, bare: true });
      const dir = adminDir("primary");
      reconcile([bareRepo, wt("/repo/primary", "detached", { adminDir: dir }), b]);
      const record = peekState(commonDir)!.worktrees.find((r) => r.path === "/repo/primary")!;
      const nowMain = wt("/repo/primary", "main", { isMain: true, markedMain: true, adminDir: dir });

      const result = reconcile([bareRepo, nowMain, b]);
      expect(result.orphans).toEqual([]);
      expect(result.unavailable).toEqual([{ ...record, reason: "main" }]);
      expect(result.worktrees.map((w) => w.branch)).toEqual(["feat-b"]);
      expect(recordIsLive(record, [bareRepo, nowMain])).toBe(true);
      // The first entry itself (main checkout / bare repo / git dir) holds no record.
      expect(recordIsLive({ ...record, id: undefined, path: main.path }, [main])).toBe(false);
    });

    it("records the main checkout it is given, and keeps it across forgetRecords", () => {
      reconcileWorktrees({
        commonDir,
        repoName: "myapp",
        listWorktrees: () => [main, a],
        adoptable: new Map(),
        mainCheckout: "/repo/myapp",
      });
      expect(peekState(commonDir)?.mainCheckout).toBe("/repo/myapp");
      forgetRecords(commonDir, ["myapp-wt-1-feat-a"]);
      expect(peekState(commonDir)).toMatchObject({ worktrees: [], mainCheckout: "/repo/myapp" });
    });

    it("recordIsLive matches by id, and by path only for records without one", () => {
      const dir = adminDir("wt-a");
      const live = wt("/repo/elsewhere", "feat-a", { adminDir: dir });
      reconcile([main, live]);
      const record = peekState(commonDir)!.worktrees[0];
      expect(recordIsLive(record, [main, live])).toBe(true);
      expect(recordIsLive(record, [main, wt(record.path, "feat-z", { adminDir: adminDir("fresh") })])).toBe(false);
      expect(recordIsLive({ ...record, id: undefined }, [main, wt(record.path, "x")])).toBe(true);
    });
  });

  it("releases the lock when the callback throws", () => {
    expect(() =>
      withStateLock(commonDir, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(path.join(commonDir, "wtc", "state.lock"))).toBe(false);
  });
});
