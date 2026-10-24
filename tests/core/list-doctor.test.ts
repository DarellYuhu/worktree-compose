import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { listWorktrees } from "../../src/core/list.js";
import { doctor, isPortBusy } from "../../src/core/doctor.js";
import { startWorktrees } from "../../src/core/start.js";
import { prune } from "../../src/core/prune.js";
import { buildContext } from "../../src/context.js";
import { stateFile } from "../../src/state/registry.js";
import { silentReporter } from "../../src/utils/log.js";
import { addWorktree, commitAll, git, makeRepo, write } from "../helpers/git.js";
import { installFakeEngine, podmanContainer } from "../helpers/fake-engine.js";

function listen(host: string, port = 0): Promise<net.Server> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("list and doctor (fake engine)", () => {
  let base: string;
  let root: string;
  let engine: ReturnType<typeof installFakeEngine>;

  beforeEach(() => {
    ({ base, root } = makeRepo("listrepo"));
    write(
      root,
      "compose.yaml",
      'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-8080}:80"\n  cache:\n    image: redis\n    ports:\n      - "6379:6379"\n',
    );
    commitAll(root, "compose");
    engine = installFakeEngine(base);
  });

  afterEach(() => {
    engine.restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reports status per stack and orphans, never releasing records (read-only)", () => {
    const a = addWorktree(root, base, "listrepo-a", "a");
    addWorktree(root, base, "listrepo-b", "b");
    addWorktree(root, base, "listrepo-c", "c");
    buildContext({}, { cwd: root, probeStacks: true }); // records all three
    git(root, "worktree", "remove", "--force", a);

    engine.setContainers([
      podmanContainer("listrepo-wt-1-a", "running"),
      podmanContainer("listrepo-wt-2-b", "running"),
      podmanContainer("listrepo-wt-2-b", "exited"),
      podmanContainer("other-project", "running"),
    ]);

    const result = listWorktrees({ live: false, cwd: root });
    expect(result.rows.map((r) => [r.index, r.branch, r.status, r.running, r.total, r.orphan])).toEqual([
      [1, "a", "up", 1, 1, true],
      [2, "b", "partial", 1, 2, false],
      [3, "c", "down", 0, 0, false],
    ]);
    expect(result.rows[1]).toMatchObject({ project: "listrepo-wt-2-b", ports: { WEB_PORT: 28082 }, url: "http://localhost:28082" });
    expect(result.isolationWarnings.some((w) => w.includes("raw port mapping (6379:6379)"))).toBe(true);

    // The orphan's stack is gone, but list (and MCP wtc_list) only reports it.
    engine.setContainers([podmanContainer("listrepo-wt-2-b", "running")]);
    const before = fs.readFileSync(stateFile(path.join(root, ".git")), "utf-8");
    const after = listWorktrees({ live: false, cwd: root });
    expect(after.rows.map((r) => [r.index, r.status, r.orphan])).toEqual([
      [1, "down", true],
      [2, "up", false],
      [3, "down", false],
    ]);
    expect(fs.readFileSync(stateFile(path.join(root, ".git")), "utf-8")).toBe(before);
  });

  it("start never releases an orphan: the new worktree skips its index until prune frees it", async () => {
    const a = addWorktree(root, base, "listrepo-a", "a");
    addWorktree(root, base, "listrepo-b", "b");
    await startWorktrees({ worktrees: ["a"], build: false }, silentReporter, { live: false, cwd: root });
    const state = JSON.parse(fs.readFileSync(stateFile(path.join(root, ".git")), "utf-8"));
    expect(state.worktrees.find((r: { index: number }) => r.index === 1).envFiles).toEqual([".env"]);
    git(root, "worktree", "remove", "--force", a);
    addWorktree(root, base, "listrepo-d", "d");

    // No containers anywhere for listrepo-wt-1-a — still not released: its
    // stack may live on a daemon this process cannot see.
    const result = await startWorktrees({ worktrees: ["d"], build: false }, silentReporter, { live: false, cwd: root });
    expect(result.started.map((s) => [s.branch, s.index])).toEqual([["d", 3]]);
    expect(buildContext({}, { cwd: root }).orphans.map((o) => o.project)).toEqual(["listrepo-wt-1-a"]);

    await prune({}, silentReporter, { live: false, cwd: root });
    expect(buildContext({}, { cwd: root }).orphans).toEqual([]);
    addWorktree(root, base, "listrepo-e", "e");
    expect(buildContext({}, { cwd: root }).worktrees.map((w) => [w.branch, w.index])).toEqual([
      ["b", 2],
      ["d", 3],
      ["e", 1],
    ]);
  });

  it("doctor reports engine, isolation, orphans and busy ports", async () => {
    const server = await listen("0.0.0.0");
    const port = (server.address() as net.AddressInfo).port;
    // Default chosen so worktree 1's allocation (20000 + default + 1) is that port.
    write(
      root,
      "compose.yaml",
      `services:\n  web:\n    image: nginx\n    ports:\n      - "\${WEB_PORT:-${port - 20001}}:80"\n  cache:\n    image: redis\n    ports:\n      - "6379:6379"\n`,
    );
    commitAll(root, "busy port fixture");
    addWorktree(root, base, "listrepo-a", "a");
    try {
      expect(await isPortBusy(port)).toBe(true);
      const result = await doctor({ live: false, cwd: root });
      const titles = result.checks.map((c) => `${c.status} ${c.title}`);
      expect(result.ok).toBe(true);
      expect(titles).toContain("ok Compose engine: podman compose");
      expect(titles).toContain("ok podman daemon reachable");
      expect(titles).toContain("warn Raw port mapping (not isolated)");
      expect(titles).toContain("warn 1 allocated port(s) already in use");
      expect(result.checks.find((c) => c.title.includes("already in use"))?.detail).toBe(
        `worktree 1 (a) WEB_PORT=${port}`,
      );
    } finally {
      await close(server);
    }
    expect(await isPortBusy(port)).toBe(false);
  });

  it("doctor is read-only: no new identity written, no worktree id created, a corrupt registry left in place", async () => {
    addWorktree(root, base, "listrepo-a", "a");
    buildContext({}, { cwd: root, probeStacks: true }); // records a
    const file = stateFile(path.join(root, ".git"));
    const before = fs.readFileSync(file, "utf-8");
    addWorktree(root, base, "listrepo-b", "b");

    const result = await doctor({ live: false, cwd: root });
    expect(result.checks.find((c) => c.title === "2 worktree(s)")?.detail).toBe("1:a (down), 2:b (down)");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(root, ".git", "worktrees", "listrepo-b", "wtc-id"))).toBe(false);

    fs.writeFileSync(file, "{ not json");
    const corrupt = await doctor({ live: false, cwd: root });
    expect(corrupt.checks.some((c) => c.status === "warn" && /state file is unreadable/.test(c.title))).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("isPortBusy sees listeners bound to loopback only", async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      let server: net.Server;
      try {
        server = await listen(host);
      } catch {
        continue; // no IPv6 on this machine
      }
      const port = (server.address() as net.AddressInfo).port;
      try {
        expect(await isPortBusy(port)).toBe(true);
      } finally {
        await close(server);
      }
    }
  });

  it("doctor fails when the configured compose command does not work", async () => {
    addWorktree(root, base, "listrepo-a", "a");
    process.env.WTC_COMPOSE_COMMAND = "wtcrev-no-such-compose";
    const result = await doctor({ live: false, cwd: root });
    expect(result.ok).toBe(false);
    const failed = result.checks.find((c) => c.status === "fail");
    expect(failed?.title).toBe("Compose engine not working: wtcrev-no-such-compose");
    expect(failed?.detail).toBe("'wtcrev-no-such-compose version' failed (set by WTC_COMPOSE_COMMAND).");
    expect(failed?.hint).toMatch(/WTC_COMPOSE_COMMAND/);
    // Stack states are only read through a working engine: unknown, not "down".
    expect(result.checks.find((c) => c.title === "1 worktree(s)")?.detail).toBe("1:a (?)");
  });

  it("doctor refuses an arbitrary composeCommand from the repository without running it", async () => {
    delete process.env.WTC_COMPOSE_COMMAND;
    const marker = path.join(base, "MARKER");
    write(root, ".wtcrc.json", JSON.stringify({ composeCommand: ["touch", marker] }));
    const result = await doctor({ live: false, cwd: root });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.title === "No compose engine")?.detail).toMatch(/not a known compose tool/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("doctor fails on invalid config JSON, naming the file", async () => {
    write(root, ".wtcrc.json", "{ nope");
    const result = await doctor({ live: false, cwd: root });
    expect(result.ok).toBe(false);
    const failed = result.checks.find((c) => c.status === "fail");
    expect(failed?.detail).toMatch(/Invalid JSON in .*\.wtcrc\.json/);
  });
});
