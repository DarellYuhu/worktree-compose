import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEnvFile, promoteFiles } from "../../src/git/promote.js";
import {
  PromoteConflictError,
  PromoteDivergedError,
  promoteWorktree,
} from "../../src/core/promote.js";
import { silentReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";

describe("isEnvFile", () => {
  it("excludes local env files at any depth", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile(".env.development")).toBe(true);
    expect(isEnvFile("apps/server/.env.local")).toBe(true);
  });

  it("keeps committed env templates promotable", () => {
    for (const f of [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      "apps/web/.env.defaults",
    ]) {
      expect(isEnvFile(f)).toBe(false);
    }
  });

  it("ignores files that merely contain .env", () => {
    expect(isEnvFile("src/env.ts")).toBe(false);
    expect(isEnvFile("docs/.envrc")).toBe(false);
  });
});

describe("promoteWorktree", () => {
  let base: string;
  let root: string;
  let wt: string;
  const io = () => ({ live: false, cwd: root });

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
    write(root, "compose.yaml", "include:\n  - ./infra/db.yml\nservices:\n  web:\n    image: nginx\n");
    write(root, "infra/db.yml", "services:\n  db:\n    image: postgres\n");
    commitAll(root, "compose");
    wt = addWorktree(root, base, "myapp-feat", "feat");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("promotes non-ASCII names, renames (as delete + add), and untracked files", async () => {
    git(wt, "mv", "README.md", "docs.md");
    write(wt, "café.txt", "crème\n");
    commitAll(wt, "rename + unicode");
    write(wt, "notes/untracked.txt", "fresh\n");
    write(wt, "docs.md", "edited, unstaged\n");

    const result = await promoteWorktree({ worktree: "feat" }, silentReporter, io());

    expect(result.files.sort()).toEqual(["README.md", "café.txt", "docs.md", "notes/untracked.txt"].sort());
    expect(fs.existsSync(path.join(root, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "café.txt"), "utf-8")).toBe("crème\n");
    expect(fs.readFileSync(path.join(root, "docs.md"), "utf-8")).toBe("edited, unstaged\n");
    expect(fs.readFileSync(path.join(root, "notes/untracked.txt"), "utf-8")).toBe("fresh\n");
  });

  it("excludes compose files (including included ones) and env files", async () => {
    write(wt, "compose.yaml", "services: {}\n");
    write(wt, "infra/db.yml", "services: {}\n");
    write(wt, ".env", "PORT=1\n");
    write(wt, ".env.example", "PORT=\n");
    write(wt, "src/app.ts", "export {};\n");

    const result = await promoteWorktree({ worktree: 1 }, silentReporter, io());
    expect(result.files.sort()).toEqual([".env.example", "src/app.ts"]);
  });

  it("aborts when the target has an untracked file at a promoted path", async () => {
    write(wt, "new.txt", "from worktree\n");
    write(root, "new.txt", "unsaved local work\n");

    await expect(promoteWorktree({ worktree: "feat" }, silentReporter, io())).rejects.toBeInstanceOf(
      PromoteConflictError,
    );
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf-8")).toBe("unsaved local work\n");
  });

  it("aborts when the target has a tracked change at a promoted path", async () => {
    write(wt, "README.md", "theirs\n");
    write(root, "README.md", "mine\n");
    await expect(promoteWorktree({ worktree: "feat" }, silentReporter, io())).rejects.toThrow(
      /README\.md/,
    );
  });

  it("refuses to promote a worktree into itself", async () => {
    write(wt, "x.txt", "x\n");
    await expect(
      promoteWorktree({ worktree: "." }, silentReporter, { live: false, cwd: wt }),
    ).rejects.toThrow(/is the current checkout/);
  });
});

describe("promoteFiles containment", () => {
  it("rejects paths that escape either root", () => {
    expect(() => promoteFiles("/tmp/a", "/tmp/b", ["../etc/passwd"])).toThrow(/escapes/);
    expect(() => promoteFiles("/tmp/a", "/tmp/b", ["/etc/passwd"])).toThrow(/escapes/);
  });
});

describe("promoteWorktree re-runs", () => {
  it("does not treat identical, already-promoted files as conflicts", async () => {
    const { base, root } = makeRepo("myapp");
    try {
      const wt = addWorktree(root, base, "myapp-feat", "feat");
      write(wt, "same.txt", "v1\n");
      await promoteWorktree({ worktree: "feat" }, silentReporter, { live: false, cwd: root });
      // Second promote: same.txt is untracked in main but identical.
      write(wt, "more.txt", "v2\n");
      const result = await promoteWorktree({ worktree: "feat" }, silentReporter, { live: false, cwd: root });
      expect(result.files.sort()).toEqual(["more.txt", "same.txt"]);
      // A differing local edit is still protected.
      write(root, "same.txt", "local edit\n");
      await expect(
        promoteWorktree({ worktree: "feat" }, silentReporter, { live: false, cwd: root }),
      ).rejects.toThrow(/same\.txt/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("promoteWorktree against a target that moved on", () => {
  let base: string;
  let root: string;
  let wt: string;
  const io = () => ({ live: false, cwd: root });

  beforeEach(() => {
    ({ base, root } = makeRepo("myapp"));
    write(root, "app.txt", "line1\nline2\nline3\n");
    write(root, "util.txt", "util v1\n");
    commitAll(root, "base");
    wt = addWorktree(root, base, "myapp-feat", "feat");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("refuses to revert files the target committed since the worktree branched", async () => {
    write(root, "app.txt", "line1 SECURITY FIX ON MAIN\nline2\nline3\n");
    write(root, "util.txt", "util v2 main edit\n");
    commitAll(root, "main moves on");
    write(wt, "app.txt", "line1\nline2\nline3 feature\n");
    git(wt, "rm", "-q", "util.txt");
    write(wt, "new.txt", "new\n");
    commitAll(wt, "feature");

    const err = await promoteWorktree({ worktree: "feat" }, silentReporter, io()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromoteDivergedError);
    expect((err as PromoteDivergedError).files.sort()).toEqual(["app.txt", "util.txt"]);
    expect((err as Error).message).toMatch(/git -C .* merge main/);
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf-8")).toContain("SECURITY FIX");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);

    // After merging main into the worktree (resolving by hand), promote goes through.
    git(wt, "merge", "-q", "-s", "ours", "--no-edit", "main");
    write(wt, "app.txt", "line1 SECURITY FIX ON MAIN\nline2\nline3 feature\n");
    commitAll(wt, "resolve");
    const result = await promoteWorktree({ worktree: "feat" }, silentReporter, io());
    expect(result.files).toContain("app.txt");
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf-8")).toBe("line1 SECURITY FIX ON MAIN\nline2\nline3 feature\n");
  });

  it("--force overwrites them anyway", async () => {
    write(root, "app.txt", "main\n");
    commitAll(root, "main moves on");
    write(wt, "app.txt", "feature\n");
    commitAll(wt, "feature");

    await promoteWorktree({ worktree: "feat", force: true }, silentReporter, io());
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf-8")).toBe("feature\n");
  });

  it("does not flag files where the target already has the worktree's content", async () => {
    write(wt, "app.txt", "same\n");
    commitAll(wt, "feature");
    write(root, "app.txt", "same\n");
    commitAll(root, "already promoted and committed");
    write(wt, "more.txt", "more\n");
    const result = await promoteWorktree({ worktree: "feat" }, silentReporter, io());
    expect(result.files.sort()).toEqual(["app.txt", "more.txt"]);
  });

  it("refuses paths under an untracked symlinked directory in the target", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "data"));
    write(wt, "data/config.json", "{}\n");
    commitAll(wt, "feature");

    await expect(promoteWorktree({ worktree: "feat" }, silentReporter, io())).rejects.toThrow(
      /Refusing to promote "data\/config\.json": data in the target is a symlink/,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses paths under a committed symlinked directory in the target, touching nothing outside", async () => {
    write(root, "vendor/lib/a.js", "a v1\n");
    write(root, "vendor/lib/b.js", "b v1\n");
    commitAll(root, "vendor");
    git(wt, "merge", "-q", "main");
    write(wt, "vendor/lib/a.js", "a v2 from feature\n");
    git(wt, "rm", "-q", "vendor/lib/b.js");
    commitAll(wt, "feature");

    const shared = path.join(base, "shared-lib");
    write(shared, "a.js", "shared a\n");
    write(shared, "b.js", "shared b\n");
    git(root, "rm", "-q", "-r", "vendor/lib");
    fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
    write(root, "vendor/README", "vendored\n");
    fs.symlinkSync("../../shared-lib", path.join(root, "vendor/lib"));
    commitAll(root, "vendor/lib is now a symlink");

    await expect(
      promoteWorktree({ worktree: "feat", force: true }, silentReporter, io()),
    ).rejects.toThrow(/vendor\/lib in the target is a symlink/);
    expect(fs.readFileSync(path.join(shared, "a.js"), "utf-8")).toBe("shared a\n");
    expect(fs.readFileSync(path.join(shared, "b.js"), "utf-8")).toBe("shared b\n");
  });

  it("refuses paths under a directory the worktree's branch turned into a symlink", async () => {
    write(root, "conf/x.txt", "x\n");
    commitAll(root, "conf dir");
    git(wt, "merge", "-q", "main");
    git(wt, "rm", "-q", "-r", "conf");
    fs.symlinkSync("elsewhere", path.join(wt, "conf"));
    commitAll(wt, "conf is a symlink now");

    await expect(promoteWorktree({ worktree: "feat" }, silentReporter, io())).rejects.toThrow(
      /Refusing to promote "conf\/x\.txt": conf in the worktree is a symlink/,
    );
    // Validation runs before any write: the target is untouched.
    expect(fs.readFileSync(path.join(root, "conf/x.txt"), "utf-8")).toBe("x\n");
    expect(fs.lstatSync(path.join(root, "conf")).isDirectory()).toBe(true);
  });

  it("does not flag a file both sides deleted", async () => {
    git(root, "rm", "-q", "util.txt");
    commitAll(root, "main drops util");
    git(wt, "rm", "-q", "util.txt");
    write(wt, "new.txt", "new\n");
    commitAll(wt, "feature drops util too");

    const result = await promoteWorktree({ worktree: "feat" }, silentReporter, io());
    expect(result.files.sort()).toEqual(["new.txt", "util.txt"]);
    expect(fs.existsSync(path.join(root, "util.txt"))).toBe(false);
  });

  it("names the target branch, the worktree branch and the merge to run", async () => {
    write(root, "app.txt", "main\n");
    commitAll(root, "main moves on");
    write(wt, "app.txt", "feature\n");
    commitAll(wt, "feature");

    await expect(promoteWorktree({ worktree: "feat" }, silentReporter, io())).rejects.toThrow(
      /also changed on main since feat branched; promoting would revert those commits — merge main into the worktree first/,
    );
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf-8")).toBe("main\n");
  });
});

describe("promoteFiles and symlinks", () => {
  let base: string;
  let target: string;
  let wt: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-promote-")));
    target = path.join(base, "main");
    wt = path.join(base, "wt");
    outside = path.join(base, "outside");
    for (const d of [target, wt, outside]) fs.mkdirSync(d);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("replaces a final-component symlink in the target on write", () => {
    write(outside, "victim.txt", "precious\n");
    fs.symlinkSync(path.join(outside, "victim.txt"), path.join(target, "a.txt"));
    write(wt, "a.txt", "promoted\n");

    expect(promoteFiles(target, wt, ["a.txt"])).toEqual([]);

    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf-8")).toBe("precious\n");
    expect(fs.lstatSync(path.join(target, "a.txt")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(target, "a.txt"), "utf-8")).toBe("promoted\n");
  });

  it("removes a final-component symlink in the target on delete, without following it", () => {
    write(outside, "victim.txt", "precious\n");
    fs.symlinkSync(path.join(outside, "victim.txt"), path.join(target, "gone.txt"));

    promoteFiles(target, wt, ["gone.txt"]);

    expect(fs.lstatSync(path.join(target, "gone.txt"), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf-8")).toBe("precious\n");
  });

  it("validates every path before writing anything (all-or-nothing)", () => {
    write(wt, "a.txt", "a\n");
    write(wt, "data/x.json", "{}\n");
    fs.symlinkSync(outside, path.join(target, "data"));

    expect(() => promoteFiles(target, wt, ["a.txt", "data/x.json"])).toThrow(/data in the target is a symlink/);
    expect(fs.existsSync(path.join(target, "a.txt"))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("never reads through a symlinked directory in the worktree", () => {
    write(outside, "id_rsa", "secret\n");
    fs.symlinkSync(outside, path.join(wt, "keys"));

    expect(() => promoteFiles(target, wt, ["keys/id_rsa"])).toThrow(/keys in the worktree is a symlink/);
    expect(fs.existsSync(path.join(target, "keys"))).toBe(false);
  });

  it("refuses a path whose target parent is a file", () => {
    write(target, "conf", "file\n");
    write(wt, "conf/x.txt", "x\n");
    expect(() => promoteFiles(target, wt, ["conf/x.txt"])).toThrow(/conf in the target is a symlink \(or not a directory\)/);
    expect(fs.readFileSync(path.join(target, "conf"), "utf-8")).toBe("file\n");
  });
});
