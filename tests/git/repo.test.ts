import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bareRepoName, getRepoInfo, listRepoWorktrees } from "../../src/git/repo.js";
import { getWorktrees, isCandidate } from "../../src/git/worktree.js";
import { readState, stateFile, writeState } from "../../src/state/registry.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";

describe("getRepoInfo", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolves the main checkout from the main checkout", () => {
    const info = getRepoInfo(root);
    expect(info).toEqual({
      mainRoot: root,
      currentRoot: root,
      commonDir: path.join(root, ".git"),
      repoName: "myapp",
      bare: false,
      mainRootIsFallback: false,
      recordMain: false,
      warnings: [],
    });
  });

  it("resolves the MAIN worktree from inside a linked worktree", () => {
    const wt = addWorktree(root, base, "myapp-feat", "feat");
    fs.mkdirSync(path.join(wt, "sub", "dir"), { recursive: true });

    const info = getRepoInfo(path.join(wt, "sub", "dir"));
    expect(info.mainRoot).toBe(root);
    expect(info.currentRoot).toBe(wt);
    expect(info.repoName).toBe("myapp");
    expect(info.commonDir).toBe(path.join(root, ".git"));
  });

  it("fails clearly outside a git repository", () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-nogit-")));
    try {
      expect(() => getRepoInfo(outside)).toThrow(
        "Not inside a git repository (run wtc from your project).",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("bareRepoName", () => {
  it("names the repository, not the worktree", () => {
    expect(bareRepoName("/w/proj.git")).toBe("proj");
    expect(bareRepoName("/w/proj/.bare")).toBe("proj");
    expect(bareRepoName("/w/proj/.git")).toBe("proj");
    expect(bareRepoName("/w/proj")).toBe("proj");
    expect(bareRepoName("/w/proj/.bare.git")).toBe("proj");
  });
});

describe("getRepoInfo in other layouts", () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-layout-")));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("bare repo + worktrees: same name and main checkout from every worktree", () => {
    const { root } = makeRepo("seed");
    try {
      git(base, "clone", "-q", "--bare", root, path.join(base, "proj.git"));
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
    const bareDir = path.join(base, "proj.git");
    const mainWt = path.join(base, "proj-main");
    const featWt = path.join(base, "proj-feat");
    git(bareDir, "worktree", "add", "-q", mainWt, "main");
    git(bareDir, "worktree", "add", "-q", featWt, "-b", "feat");

    const fromFeat = getRepoInfo(featWt);
    const fromMain = getRepoInfo(mainWt);
    for (const info of [fromFeat, fromMain]) {
      expect(info).toMatchObject({
        mainRoot: mainWt,
        repoName: "proj",
        bare: true,
        mainRootIsFallback: false,
        recordMain: true,
        warnings: [],
      });
    }

    // The default-branch checkout is the main one: never a managed worktree.
    const candidates = getWorktrees(featWt, fromFeat.mainRoot).filter(isCandidate);
    expect(candidates.map((w) => w.path)).toEqual([featWt]);
  });

  it("bare repo without a default-branch worktree falls back to the current checkout, with a warning", () => {
    const { root } = makeRepo("seed");
    try {
      git(base, "clone", "-q", "--bare", root, path.join(base, "proj", ".bare"));
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
    const bareDir = path.join(base, "proj", ".bare");
    const featWt = path.join(base, "proj", "feat");
    git(bareDir, "worktree", "add", "-q", featWt, "-b", "feat");

    const info = getRepoInfo(featWt);
    expect(info).toMatchObject({ mainRoot: featWt, repoName: "proj", bare: true, mainRootIsFallback: true });
    expect(info.fallbackReason).toMatch(/has its default branch \(main\) checked out/);
    expect(info.warnings.join("\n")).toMatch(/Cannot locate the main checkout.*start, restart and clean refuse to run/);
    // A stand-in main is never marked main: the current worktree stays a worktree.
    expect(listRepoWorktrees(info).filter(isCandidate).map((w) => w.path)).toEqual([featWt]);
  });

  it("submodule: the main checkout is the submodule's working tree, not its git dir", () => {
    const { root: lib } = makeRepo("lib");
    write(lib, "compose.yaml", "services: {}\n");
    commitAll(lib, "compose");
    const { root: sup } = makeRepo("super");
    git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "app");
    commitAll(sup, "add submodule");
    const app = path.join(sup, "app");

    const info = getRepoInfo(app);
    expect(info.mainRoot).toBe(app);
    expect(info.repoName).toBe("app");
    expect(info.commonDir).toBe(path.join(sup, ".git", "modules", "app"));

    // …also from a linked worktree of the submodule.
    const wt = path.join(path.dirname(sup), "app-feat");
    git(app, "worktree", "add", "-q", wt, "-b", "feat");
    expect(getRepoInfo(wt).mainRoot).toBe(app);
    fs.rmSync(path.dirname(lib), { recursive: true, force: true });
    fs.rmSync(path.dirname(sup), { recursive: true, force: true });
  });

  it("--separate-git-dir: the main checkout is the current toplevel", () => {
    const work = path.join(base, "work");
    const gitDir = path.join(base, "sep.git");
    fs.mkdirSync(work);
    git(work, "init", "-q", "--separate-git-dir", gitDir);
    write(work, "README.md", "x\n");
    commitAll(work, "init");

    expect(getRepoInfo(work)).toMatchObject({ mainRoot: work, repoName: "work", bare: false });

    const wt = path.join(base, "work-feat");
    git(work, "worktree", "add", "-q", wt, "-b", "feat");
    expect(getRepoInfo(work).warnings).toEqual([]);

    // From a linked worktree git records no main checkout: the current one
    // stands in, flagged as a fallback, and it stays a managed worktree.
    const fromLinked = getRepoInfo(wt);
    expect(fromLinked).toMatchObject({ mainRoot: wt, currentRoot: wt, bare: false, mainRootIsFallback: true });
    expect(fromLinked.fallbackReason).toMatch(/--separate-git-dir.*Run this command from the main checkout/);
    expect(fromLinked.warnings.join("\n")).toMatch(/Cannot locate the main checkout/);
    expect(listRepoWorktrees(fromLinked).filter(isCandidate).map((w) => w.path)).toEqual([wt]);

    // Once a run from the main checkout recorded it, linked worktrees find it.
    expect(getRepoInfo(work).recordMain).toBe(true);
    writeState(gitDir, { ...readState(gitDir), mainCheckout: work });
    expect(getRepoInfo(wt)).toMatchObject({
      mainRoot: work,
      repoName: "work",
      mainRootIsFallback: false,
      warnings: [],
    });
    // A recorded path that is not this repository's main checkout is ignored.
    writeState(gitDir, { ...readState(gitDir), mainCheckout: wt });
    expect(getRepoInfo(wt).mainRootIsFallback).toBe(true);
    fs.rmSync(stateFile(gitDir));
  });

  it("bare repo: a main worktree that is mid-rebase (detached) is still found once recorded", () => {
    const { root } = makeRepo("seed");
    try {
      git(base, "clone", "-q", "--bare", root, path.join(base, "proj.git"));
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
    const bareDir = path.join(base, "proj.git");
    const mainWt = path.join(base, "proj-main");
    const featWt = path.join(base, "proj-feat");
    git(bareDir, "worktree", "add", "-q", mainWt, "main");
    git(bareDir, "worktree", "add", "-q", featWt, "-b", "feat");
    writeState(bareDir, { ...readState(bareDir), mainCheckout: mainWt });
    git(mainWt, "checkout", "-q", "--detach");

    const info = getRepoInfo(featWt);
    expect(info).toMatchObject({ mainRoot: mainWt, mainRootIsFallback: false, warnings: [] });
    expect(listRepoWorktrees(info).filter(isCandidate).map((w) => w.path)).toEqual([featWt]);

    // Without the record, the detached main worktree cannot be told apart.
    fs.rmSync(stateFile(bareDir));
    expect(getRepoInfo(featWt)).toMatchObject({ mainRoot: featWt, mainRootIsFallback: true });
  });
});
