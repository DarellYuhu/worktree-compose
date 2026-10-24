import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseComposeFile } from "../../src/compose/parse.js";
import { composeIsolationWarnings, portCollisionWarnings } from "../../src/compose/isolation.js";
import type { PortMapping } from "../../src/ports/types.js";

function write(dir: string, rel: string, contents: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

describe("compose isolation warnings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-isolation-")));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("flags container_name and fixed-name/external volumes and networks", () => {
    write(
      tmpDir,
      "shared.yml",
      "volumes:\n  cache:\n    external: true\nnetworks:\n  legacy:\n    external:\n      name: old-net\n",
    );
    const file = write(
      tmpDir,
      "compose.yaml",
      [
        "include:",
        "  - ./shared.yml",
        "services:",
        "  db:",
        "    image: postgres",
        "    container_name: my-db",
        "  web:",
        "    image: nginx",
        "volumes:",
        "  data:",
        "  pinned:",
        "    name: pinned-data",
        "networks:",
        "  default:",
        "  proxy:",
        "    name: traefik",
        "",
      ].join("\n"),
    );

    const parsed = parseComposeFile(file);
    expect(parsed.services.find((s) => s.name === "db")?.containerName).toBe("my-db");
    expect(parsed.sharedVolumes.map((v) => v.key).sort()).toEqual(["cache", "pinned"]);
    expect(parsed.sharedNetworks.map((n) => n.key).sort()).toEqual(["legacy", "proxy"]);

    const warnings = composeIsolationWarnings(parsed);
    expect(warnings).toContain(
      'Service "db" sets container_name "my-db" — every worktree stack would use the same name and the second one fails to start. Remove container_name.',
    );
    expect(warnings).toContain(
      'Volume "pinned" has a fixed name/external — it is shared by every worktree stack (not isolated).',
    );
    expect(warnings).toContain(
      'Network "proxy" has a fixed name/external — it is shared by every worktree stack (not isolated).',
    );
    expect(warnings.some((w) => w.includes('"data"') || w.includes('"default"'))).toBe(false);
  });

  it("reports nothing for a project-scoped compose file", () => {
    const file = write(
      tmpDir,
      "compose.yaml",
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    container_name: ${COMPOSE_PROJECT_NAME}-web",
        "volumes:",
        "  data: {}",
        "  named:",
        "    name: ${COMPOSE_PROJECT_NAME}_named",
        "",
      ].join("\n"),
    );
    expect(composeIsolationWarnings(parseComposeFile(file))).toEqual([]);
  });
});

describe("portCollisionWarnings", () => {
  const mappings: PortMapping[] = [
    { serviceName: "a", envVar: "A_PORT", defaultPort: 8081, containerPort: 80, raw: "" },
    { serviceName: "b", envVar: "B_PORT", defaultPort: 8082, containerPort: 80, raw: "" },
  ];

  it("checks only the indices in use", () => {
    // Indices 1 and 3 never collide at stride 1 (8081+3 != 8082+1)...
    expect(portCollisionWarnings(mappings, 1, [1, 3])).toEqual([]);
    // ...but 1 and 2 do: 8082+1 == 8081+2.
    expect(portCollisionWarnings(mappings, 1, [1, 2])[0]).toMatch(/collision/);
  });

  it("is silent for fewer than two worktrees", () => {
    expect(portCollisionWarnings(mappings, 1, [5])).toEqual([]);
  });
});
