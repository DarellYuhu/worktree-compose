import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnvTargets } from "../../src/context.js";
import type { WtcContext } from "../../src/context.js";
import type { WtcConfig } from "../../src/config.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function contextFor(repoRoot: string, config: WtcConfig): WtcContext {
  // getEnvTargets only reads repoRoot and config.
  return { repoRoot, config } as WtcContext;
}

describe("getEnvTargets", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "wtc-targets-")),
    );
    writeJson(path.join(repoRoot, "package.json"), {
      name: "ruker",
      private: true,
      workspaces: ["apps/*"],
    });
    writeJson(path.join(repoRoot, "apps/server/package.json"), {
      name: "server",
    });
    writeJson(path.join(repoRoot, "apps/homepage/package.json"), {
      name: "homepage",
    });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true });
  });

  it("defaults to a single root target", () => {
    const targets = getEnvTargets(contextFor(repoRoot, {}));

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      dir: "",
      label: "root",
      envFileName: ".env",
    });
  });

  it("uses the configured env filename for every target", () => {
    const targets = getEnvTargets(
      contextFor(repoRoot, {
        envFile: ".env.development",
        workspaces: ["server", "homepage"],
      }),
    );

    expect(targets.map((t) => t.dir)).toEqual(["", "apps/server", "apps/homepage"]);
    expect(targets.every((t) => t.envFileName === ".env.development")).toBe(true);
    expect(targets[1].label).toBe("workspace server (apps/server)");
  });

  it("applies envOverrides to the root and workspace overrides per workspace", () => {
    const rootOverrides = { DATABASE_URL: "root-url" };
    const serverOverrides = { DATABASE_URL: "server-url" };
    const targets = getEnvTargets(
      contextFor(repoRoot, {
        workspaces: ["server", "homepage"],
        envOverrides: rootOverrides,
        workspaceEnvOverrides: { server: serverOverrides },
      }),
    );

    expect(targets[0].overrides).toBe(rootOverrides);
    expect(targets[1].overrides).toBe(serverOverrides);
    expect(targets[2].overrides).toBeUndefined();
  });

  it("matches workspace override keys by path or directory basename", () => {
    const byPath = { A: "1" };
    const byBasename = { B: "2" };

    const targets = getEnvTargets(
      contextFor(repoRoot, {
        workspaces: ["server", "homepage"],
        workspaceEnvOverrides: {
          "apps/server": byPath,
          homepage: byBasename,
        },
      }),
    );

    expect(targets[1].overrides).toBe(byPath);
    expect(targets[2].overrides).toBe(byBasename);
  });

  it("throws for an unknown workspace before anything is synced", () => {
    expect(() =>
      getEnvTargets(contextFor(repoRoot, { workspaces: ["nope"] })),
    ).toThrow(/Workspace "nope" not found/);
  });

  describe("with two workspaces sharing a directory basename", () => {
    beforeEach(() => {
      writeJson(path.join(repoRoot, "package.json"), {
        name: "ruker",
        private: true,
        workspaces: ["apps/*", "packages/*"],
      });
      writeJson(path.join(repoRoot, "apps/server/package.json"), {
        name: "@ruker/server-a",
      });
      writeJson(path.join(repoRoot, "packages/server/package.json"), {
        name: "@ruker/server-b",
      });
    });

    it("does not apply a basename key shared by two selected workspaces", () => {
      const shared = { SHARED: "wrong" };
      const targets = getEnvTargets(
        contextFor(repoRoot, {
          workspaces: ["apps/server", "packages/server"],
          workspaceEnvOverrides: {
            // "server" matches both directory basenames here.
            server: shared,
          },
        }),
      );

      expect(targets[1].overrides).toBeUndefined();
      expect(targets[2].overrides).toBeUndefined();
    });

    it("still reaches ambiguous workspaces by full path or package name", () => {
      const byPath = { FROM: "path" };
      const byName = { FROM: "name" };
      const targets = getEnvTargets(
        contextFor(repoRoot, {
          workspaces: ["apps/server", "packages/server"],
          workspaceEnvOverrides: {
            "apps/server": byPath,
            "@ruker/server-b": byName,
          },
        }),
      );

      expect(targets[1].overrides).toBe(byPath);
      expect(targets[2].overrides).toBe(byName);
    });

    it("keeps basename keys working when the selection is unambiguous", () => {
      const selected = { ONLY: "one" };
      const targets = getEnvTargets(
        contextFor(repoRoot, {
          workspaces: ["apps/server"],
          workspaceEnvOverrides: { server: selected },
        }),
      );

      expect(targets[1].overrides).toBe(selected);
    });
  });
});
