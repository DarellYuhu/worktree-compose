import fs from "node:fs";
import path from "node:path";
import { startWorktrees } from "../../src/core/start.js";
import { peekState } from "../../src/state/registry.js";
import { CollectingReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine } from "../helpers/fake-engine.js";

describe("startWorktrees writes only inside the worktree and records what it wrote", () => {
  let base: string;
  let root: string;
  let wt: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    ({ base, root } = makeRepo("startrepo"));
    write(root, "compose.yaml", "services:\n  api:\n    image: node\n    ports:\n      - \"${API_PORT:-3000}:3000\"\n");
    write(root, ".gitignore", ".env\n");
    write(root, ".wtcrc.json", JSON.stringify({ sync: ["data"] }));
    commitAll(root, "infra");
    write(root, ".env", "SECRET=main-secret\n");
    write(base, "datasets/big.csv", "1,2\n");
    fs.symlinkSync("../datasets", path.join(root, "data"));
    wt = addWorktree(root, base, "startrepo-feat", "feat");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("replaces a planted .env symlink, keeps the worktree's own data, reports why, and records the env file", async () => {
    const victim = write(base, "victim.txt", "precious\n");
    fs.symlinkSync("../victim.txt", path.join(wt, ".env"));
    write(wt, "data/fixtures.json", "{}\n");
    const reporter = new CollectingReporter();

    const result = await startWorktrees({ worktrees: ["feat"], build: false }, reporter, {
      live: false,
      cwd: root,
    });

    expect(result.started.map((s) => s.project)).toEqual(["startrepo-wt-1-feat"]);
    expect(engine.composeLog()).toEqual(["-p startrepo-wt-1-feat up -d"]);

    // 3.1: nothing written through the symlink; main's .env untouched.
    expect(fs.readFileSync(victim, "utf-8")).toBe("precious\n");
    expect(fs.readFileSync(path.join(root, ".env"), "utf-8")).toBe("SECRET=main-secret\n");
    const env = path.join(wt, ".env");
    expect(fs.lstatSync(env).isFile()).toBe(true);
    expect(fs.readFileSync(env, "utf-8")).toContain("COMPOSE_PROJECT_NAME=startrepo-wt-1-feat");

    // 3.3: the worktree's real data directory survives, and start says why.
    expect(fs.readFileSync(path.join(wt, "data/fixtures.json"), "utf-8")).toBe("{}\n");
    const lines = reporter.lines.join("\n");
    expect(lines).toMatch(/⚠ Skipping sync of data: it is a symlink in the main checkout but a directory/);
    expect(lines).toMatch(/⚠ \.env in the worktree was a symlink; replaced it/);

    // 3.6: clean will know exactly which env files wtc wrote.
    const record = peekState(path.join(root, ".git"))?.worktrees.find((r) => r.path === wt);
    expect(record?.envFiles).toEqual([".env"]);
  });

  it("never rewrites main's .env through a hard-linked worktree .env (self-copy guard)", async () => {
    fs.linkSync(path.join(root, ".env"), path.join(wt, ".env"));
    const reporter = new CollectingReporter();

    await startWorktrees({ worktrees: ["feat"], build: false }, reporter, { live: false, cwd: root });

    expect(fs.readFileSync(path.join(root, ".env"), "utf-8")).toBe("SECRET=main-secret\n");
    expect(reporter.lines.join("\n")).toMatch(/main checkout's own env file/);
    const record = peekState(path.join(root, ".git"))?.worktrees.find((r) => r.path === wt);
    expect(record?.envFiles ?? []).toEqual([]);
  });
});
