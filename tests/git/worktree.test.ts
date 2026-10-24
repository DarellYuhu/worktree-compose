import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  adminDirByPath,
  getNonMainWorktrees,
  getWorktrees,
  parseWorktreePorcelain,
  worktreeAdminDir,
} from "../../src/git/worktree.js";
import { addWorktree, git, makeRepo } from "../helpers/git.js";

describe("parseWorktreePorcelain", () => {
  it("parses branch, HEAD and every flag", () => {
    const output = [
      "worktree /repo/main",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/locked",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feat/locked",
      "locked reason with spaces",
      "",
      "worktree /repo/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
      "worktree /repo/gone",
      "HEAD 4444444444444444444444444444444444444444",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const wts = parseWorktreePorcelain(output);
    expect(wts).toHaveLength(4);
    expect(wts[0]).toMatchObject({ path: "/repo/main", branch: "main", isMain: true, head: "1".repeat(40) });
    expect(wts[1]).toMatchObject({ branch: "feat/locked", locked: true, prunable: false, isMain: false });
    expect(wts[2]).toMatchObject({ branch: "detached", detached: true });
    expect(wts[3]).toMatchObject({ branch: "gone", prunable: true });
  });

  it("parses a bare main entry", () => {
    const wts = parseWorktreePorcelain(
      "worktree /repo/bare.git\nbare\n\nworktree /repo/wt\nHEAD abc\nbranch refs/heads/x\n",
    );
    expect(wts[0]).toMatchObject({ bare: true, isMain: true });
    expect(wts[1]).toMatchObject({ bare: false, isMain: false, branch: "x" });
  });
});

describe("worktree listing against git", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("excludes main and prunable worktrees from candidates", () => {
    const keep = addWorktree(root, base, "keep", "keep");
    const gone = addWorktree(root, base, "gone", "gone");
    const locked = addWorktree(root, base, "locked", "locked");
    git(root, "worktree", "lock", locked);
    fs.rmSync(gone, { recursive: true, force: true });

    const all = getWorktrees(root);
    expect(all.find((w) => w.path === gone)?.prunable).toBe(true);
    expect(all.find((w) => w.path === locked)?.locked).toBe(true);

    expect(getNonMainWorktrees(root).map((w) => path.basename(w.path))).toEqual([
      path.basename(keep),
      path.basename(locked),
    ]);
  });

  it("treats a deleted worktree as missing even without git's prunable line (git < 2.31)", () => {
    const gone = addWorktree(root, base, "gone", "gone");
    const locked = addWorktree(root, base, "unmounted", "unmounted");
    git(root, "worktree", "lock", locked);
    fs.rmSync(gone, { recursive: true, force: true });
    fs.rmSync(locked, { recursive: true, force: true });

    const all = getWorktrees(root);
    // Git 2.31+ already reports `gone` as prunable; a locked worktree never is.
    expect(all.find((w) => w.path === gone)?.prunable).toBe(true);
    expect(all.find((w) => w.path === locked)).toMatchObject({ locked: true, prunable: false, missing: true });
    expect(getNonMainWorktrees(root)).toEqual([]);
  });

  it("records each linked worktree's admin dir", () => {
    const wt = addWorktree(root, base, "keep", "keep");
    const entry = getWorktrees(root).find((w) => w.path === wt);
    expect(entry?.adminDir).toBe(path.join(root, ".git", "worktrees", "keep"));
  });

  it("asks git for the admin dir when the .git file cannot be parsed", () => {
    const wt = addWorktree(root, base, "relative", "relative");
    const admin = path.join(root, ".git", "worktrees", "relative");
    // A relative gitdir (git worktree add --relative-paths) resolves against the worktree.
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.relative(wt, admin)}\n`);
    expect(worktreeAdminDir(wt)).toBe(admin);
    // Not a gitdir file at all (a full .git directory): git answers.
    expect(worktreeAdminDir(root)).toBe(path.join(root, ".git"));
    expect(worktreeAdminDir(path.join(base, "nowhere"))).toBeUndefined();
  });
});

describe("worktree listing on git without prunable lines", () => {
  let base: string;
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
    // A git wrapper that strips prunable/locked lines, like git 2.30 prints.
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\n"${realGit}" "$@" | grep -v -e '^prunable' -e '^locked'\nexit 0\n`,
    );
    fs.chmodSync(path.join(bin, "git"), 0o755);
    saved = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = saved;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("still excludes a worktree whose directory is gone", () => {
    const gone = path.join(base, "gone");
    execFileSync(realGitPath(), ["-C", root, "worktree", "add", "-q", gone, "-b", "gone"]);
    fs.rmSync(gone, { recursive: true, force: true });
    const all = getWorktrees(root);
    expect(all.find((w) => w.path === gone)?.prunable).toBe(true);
    expect(getNonMainWorktrees(root)).toEqual([]);
  });

  it("reads the lock from the admin dir: a locked worktree missing on disk is missing, not removed", () => {
    const unmounted = path.join(base, "unmounted");
    execFileSync(realGitPath(), ["-C", root, "worktree", "add", "-q", unmounted, "-b", "unmounted"]);
    execFileSync(realGitPath(), ["-C", root, "worktree", "lock", unmounted]);
    fs.rmSync(unmounted, { recursive: true, force: true });
    const entry = getWorktrees(root).find((w) => w.path === unmounted);
    expect(entry).toMatchObject({
      locked: true,
      missing: true,
      prunable: false,
      adminDir: path.join(root, ".git", "worktrees", "unmounted"),
    });
    expect(adminDirByPath(path.join(root, ".git"), unmounted)).toBe(entry?.adminDir);
    expect(adminDirByPath(path.join(root, ".git"), path.join(base, "elsewhere"))).toBeUndefined();
  });
});

function realGitPath(): string {
  return execFileSync("/usr/bin/env", ["-i", "PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "which", "git"], {
    encoding: "utf-8",
  }).trim();
}
