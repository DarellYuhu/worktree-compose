import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run git with a fixed identity and no user/global config influence. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.name=wtc-test",
      "-c", "user.email=wtc-test@example.com",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      "-c", "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();
}

export function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** A temp base dir (realpath'd: macOS tmpdir is a symlink) holding a repo at `<base>/<name>`. */
export function makeRepo(name = "myapp"): { base: string; root: string } {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-git-")));
  const root = path.join(base, name);
  fs.mkdirSync(root);
  git(root, "init", "-q");
  write(root, "README.md", "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { base, root };
}

/** `git worktree add <base>/<dir> -b <branch>`; returns the worktree path. */
export function addWorktree(root: string, base: string, dir: string, branch: string): string {
  const wt = path.join(base, dir);
  git(root, "worktree", "add", "-q", wt, "-b", branch);
  return wt;
}

export function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}
