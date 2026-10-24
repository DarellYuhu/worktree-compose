import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { detectComposeFile, getMainWorktreeRoot } from "../../src/compose/detect.js";

describe("detectComposeFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("finds compose.yaml first (highest precedence)", () => {
    fs.writeFileSync(path.join(tmpDir, "compose.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "");

    const result = detectComposeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "compose.yaml"));
  });

  it("finds compose.yml when compose.yaml is absent", () => {
    fs.writeFileSync(path.join(tmpDir, "compose.yml"), "");
    fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "");

    const result = detectComposeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "compose.yml"));
  });

  it("finds docker-compose.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "docker-compose.yaml"), "");

    const result = detectComposeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "docker-compose.yaml"));
  });

  it("finds docker-compose.yml", () => {
    fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "");

    const result = detectComposeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "docker-compose.yml"));
  });

  it("returns null when no compose file exists", () => {
    const result = detectComposeFile(tmpDir);
    expect(result).toBeNull();
  });
});

describe("getMainWorktreeRoot", () => {
  let tmpBase: string;
  let repoDir: string;
  let linkedDir: string;

  beforeEach(() => {
    tmpBase = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-root-")),
    );
    repoDir = path.join(tmpBase, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    run("git init -q", repoDir);
    run(
      "git config user.email test@example.com && git config user.name test",
      repoDir,
    );
    run("git commit -q --allow-empty -m init", repoDir);
    linkedDir = path.join(tmpBase, "linked");
    run(`git worktree add "${linkedDir}" -b feature`, repoDir);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("resolves the main worktree root from inside a linked worktree", () => {
    expect(getMainWorktreeRoot(linkedDir)).toBe(repoDir);
  });

  it("resolves the main worktree root from the main worktree itself", () => {
    expect(getMainWorktreeRoot(repoDir)).toBe(repoDir);
  });

  it("falls back to the current toplevel for a repo without worktrees", () => {
    const plainDir = path.join(tmpBase, "plain");
    fs.mkdirSync(plainDir, { recursive: true });
    run("git init -q", plainDir);
    run(
      "git config user.email test@example.com && git config user.name test",
      plainDir,
    );
    run("git commit -q --allow-empty -m init", plainDir);

    expect(getMainWorktreeRoot(plainDir)).toBe(plainDir);
  });
});

function run(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: "pipe" });
}
