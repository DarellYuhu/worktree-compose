import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSameFile,
  parentPlacement,
  prepareWritablePath,
  symlinkAncestor,
} from "../../src/utils/paths.js";

describe("prepareWritablePath", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-paths-")));
    root = path.join(base, "wt");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(base, "outside"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("returns the path for a missing or regular file", () => {
    const warnings: string[] = [];
    expect(prepareWritablePath(root, "a/b/c.txt", warnings)).toBe(path.join(root, "a/b/c.txt"));
    fs.writeFileSync(path.join(root, "x.txt"), "x");
    expect(prepareWritablePath(root, "x.txt", warnings)).toBe(path.join(root, "x.txt"));
    expect(fs.readFileSync(path.join(root, "x.txt"), "utf-8")).toBe("x");
    expect(warnings).toEqual([]);
  });

  it("refuses lexical escapes", () => {
    const warnings: string[] = [];
    expect(prepareWritablePath(root, "../outside/x", warnings)).toBeNull();
    expect(prepareWritablePath(root, path.join(base, "outside/x"), warnings)).toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it("refuses a parent directory that resolves outside the root, even deep below it", () => {
    fs.symlinkSync("../outside", path.join(root, "infra"));
    const warnings: string[] = [];
    expect(prepareWritablePath(root, "infra/db.yml", warnings)).toBeNull();
    expect(prepareWritablePath(root, "infra/new/dir/db.yml", warnings)).toBeNull();
    expect(warnings[0]).toMatch(/resolves outside the worktree/);
    expect(fs.readdirSync(path.join(base, "outside"))).toEqual([]);
  });

  it("refuses a dangling directory symlink (its target could be created later)", () => {
    fs.symlinkSync(path.join(base, "later"), path.join(root, "infra"));
    expect(prepareWritablePath(root, "infra/db.yml", [])).toBeNull();
  });

  it("allows a symlinked directory that stays inside the root", () => {
    fs.mkdirSync(path.join(root, "packages/api"), { recursive: true });
    fs.symlinkSync("packages/api", path.join(root, "api"));
    expect(prepareWritablePath(root, "api/.env", [])).toBe(path.join(root, "api/.env"));
  });

  it("refuses a path whose parent is a file", () => {
    fs.writeFileSync(path.join(root, "conf"), "file");
    const warnings: string[] = [];
    expect(prepareWritablePath(root, "conf/x/y.txt", warnings)).toBeNull();
    expect(warnings[0]).toMatch(/is a file, not a directory/);
  });

  it("unlinks a final-component symlink (never following it) and warns", () => {
    const victim = path.join(base, "outside/victim");
    fs.writeFileSync(victim, "precious");
    fs.symlinkSync(victim, path.join(root, ".env"));
    const warnings: string[] = [];
    expect(prepareWritablePath(root, ".env", warnings)).toBe(path.join(root, ".env"));
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
    expect(fs.readFileSync(victim, "utf-8")).toBe("precious");
    expect(warnings[0]).toMatch(/\.env in the worktree was a symlink/);
    expect(prepareWritablePath(root, "missing", [], { warnReplace: false })).not.toBeNull();
  });

  it("leaves a directory in place (never removes recursively)", () => {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data/keep"), "k");
    const warnings: string[] = [];
    expect(prepareWritablePath(root, "data", warnings, { label: "sync of data" })).toBeNull();
    expect(warnings[0]).toBe("Skipped sync of data: it is a directory in the worktree.");
    expect(fs.existsSync(path.join(root, "data/keep"))).toBe(true);
  });

  it("works for a root that does not exist yet", () => {
    const fresh = path.join(base, "fresh/wt");
    expect(prepareWritablePath(fresh, "compose.yml", [])).toBe(path.join(fresh, "compose.yml"));
  });
});

describe("parentPlacement / symlinkAncestor / isSameFile", () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-paths2-")));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("classifies where the parent directory physically is", () => {
    fs.mkdirSync(path.join(base, "root/real"), { recursive: true });
    fs.mkdirSync(path.join(base, "elsewhere"));
    fs.symlinkSync("../elsewhere", path.join(base, "root/out"));
    fs.writeFileSync(path.join(base, "root/file"), "");
    const root = path.join(base, "root");
    expect(parentPlacement(root, "real/x")).toBe("inside");
    expect(parentPlacement(root, "x")).toBe("inside");
    expect(parentPlacement(root, "out/x")).toBe("outside");
    expect(parentPlacement(root, "file/x")).toBe("not-dir");
    expect(symlinkAncestor(root, "out/x")).toBe("out");
    expect(symlinkAncestor(root, "real/x")).toBeNull();
  });

  it("detects the same file by realpath and by inode", () => {
    const a = path.join(base, "a");
    fs.writeFileSync(a, "x");
    fs.symlinkSync(a, path.join(base, "link"));
    fs.linkSync(a, path.join(base, "hard"));
    fs.writeFileSync(path.join(base, "other"), "x");
    expect(isSameFile(a, path.join(base, "link"))).toBe(true);
    expect(isSameFile(a, path.join(base, "hard"))).toBe(true);
    expect(isSameFile(a, path.join(base, "other"))).toBe(false);
    expect(isSameFile(a, path.join(base, "missing"))).toBe(false);
  });
});
