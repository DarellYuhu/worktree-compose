import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectWorktrees } from "../src/selectors.js";
import type { ResolvedWorktree } from "../src/state/registry.js";

function rw(index: number, branch: string, p: string): ResolvedWorktree {
  return {
    path: p,
    branch,
    index,
    project: `myapp-wt-${index}-${branch}`,
    isMain: false,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
  };
}

describe("selectWorktrees", () => {
  const wts = [
    rw(2, "feat-a", "/work/myapp-feat-a"),
    rw(3, "feat-b", "/work/myapp-feat-b"),
    rw(7, "fix", "/work/nested/fix"),
  ];

  it("returns every worktree for an empty selection", () => {
    expect(selectWorktrees(wts, [])).toBe(wts);
    expect(selectWorktrees(wts, undefined)).toBe(wts);
  });

  it("selects by persistent index (number or numeric string)", () => {
    expect(selectWorktrees(wts, [7]).map((w) => w.branch)).toEqual(["fix"]);
    expect(selectWorktrees(wts, ["3"]).map((w) => w.branch)).toEqual(["feat-b"]);
  });

  it("selects by branch, directory basename, and path", () => {
    expect(selectWorktrees(wts, ["feat-a"])[0].index).toBe(2);
    expect(selectWorktrees(wts, ["myapp-feat-b"])[0].index).toBe(3);
    expect(selectWorktrees(wts, ["../nested/fix"], "/work/myapp-feat-a")[0].index).toBe(7);
    expect(selectWorktrees(wts, ["/work/myapp-feat-a"])[0].index).toBe(2);
  });

  it('resolves "." to the worktree containing the cwd', () => {
    expect(selectWorktrees(wts, ["."], "/work/nested/fix/src/lib")[0].index).toBe(7);
  });

  it('rejects "." outside any linked worktree', () => {
    expect(() => selectWorktrees(wts, ["."], "/work/main")).toThrow(/does not refer to a linked worktree/);
  });

  it("preserves request order and drops duplicates", () => {
    expect(selectWorktrees(wts, ["fix", 2, "feat-a"]).map((w) => w.index)).toEqual([7, 2]);
  });

  it("rejects unknown tokens, listing what is available", () => {
    expect(() => selectWorktrees(wts, ["nope"])).toThrow(
      'Worktree "nope" not found. Available worktrees: 2:feat-a, 3:feat-b, 7:fix.',
    );
    expect(() => selectWorktrees(wts, [1])).toThrow(/Worktree "1" not found/);
  });

  it("rejects ambiguous tokens", () => {
    const clash = [rw(1, "shared", "/w/a"), rw(2, "other", "/w/shared")];
    expect(() => selectWorktrees(clash, ["shared"])).toThrow(/ambiguous/);
  });

  it("rejects a numeric string that is an index and also another worktree's name", () => {
    const numeric = [rw(1, "feat-a", "/w/feat-a"), rw(2, "2", "/w/two"), rw(3, "1", "/w/one")];
    expect(() => selectWorktrees(numeric, ["1"], "/w")).toThrow(
      /"1" is ambiguous: index 1 is 1:feat-a \(\/w\/feat-a\), but "1" also names 3:1 \(\/w\/one\)\. Pass the branch, the directory name, or a path such as \.\/one /,
    );
    // The suggested path is one that resolves from the cwd (here a sibling checkout).
    expect(() => selectWorktrees(numeric, ["1"], "/w/main")).toThrow(/a path such as \.\.\/one of the worktree/);
    // A directory called "1" is reachable by a path.
    const dirNamed = [rw(1, "feat-a", "/w/feat-a"), rw(2, "feat-b", "/w/1")];
    expect(() => selectWorktrees(dirNamed, ["1"], "/w")).toThrow(/ambiguous/);
    expect(selectWorktrees(dirNamed, ["./1"], "/w")[0].index).toBe(2);
    expect(selectWorktrees(dirNamed, ["feat-a"], "/w")[0].index).toBe(1);
    // A JSON number is always an index; names and paths still work.
    expect(selectWorktrees(numeric, [1])[0].branch).toBe("feat-a");
    expect(selectWorktrees(numeric, ["one"])[0].index).toBe(3);
    expect(selectWorktrees(numeric, ["/w/one"])[0].index).toBe(3);
    // Index 2 is the worktree on branch "2" itself: not ambiguous.
    expect(selectWorktrees(numeric, ["2"])[0].path).toBe("/w/two");
    // A numeric branch that is no index resolves by name.
    expect(selectWorktrees([rw(1, "1234", "/w/issue")], ["1234"])[0].index).toBe(1);
  });

  it("matches paths through symlinks (git records the resolved path)", () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-sel-")));
    try {
      fs.mkdirSync(path.join(tmp, "real", "x"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "main"));
      fs.symlinkSync(path.join(tmp, "real"), path.join(tmp, "link"));
      const linked = [rw(1, "feat", path.join(tmp, "real", "x")), rw(2, "other", path.join(tmp, "real", "y"))];
      expect(selectWorktrees(linked, [path.join(tmp, "link", "x")])[0].index).toBe(1);
      expect(selectWorktrees(linked, ["../link/x"], path.join(tmp, "main"))[0].index).toBe(1);
      // "." from a cwd reached through the symlink.
      expect(selectWorktrees(linked, ["."], path.join(tmp, "link", "x"))[0].index).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
