import {
  PORT_SLOT_SPACE,
  allocatePort,
  allocateWorktreePorts,
  allocationEnv,
  assignPortSlots,
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "../../src/ports/allocate.js";
import type { PortMapping } from "../../src/ports/types.js";

describe("allocatePort", () => {
  it("computes 20000 + default + slot * stride", () => {
    expect(allocatePort(8000, 1)).toBe(28001);
    expect(allocatePort(5173, 2)).toBe(25175);
    expect(allocatePort(5434, 1)).toBe(25435);
    expect(allocatePort(6380, 3)).toBe(26383);
  });

  it("falls back for high default ports", () => {
    expect(allocatePort(50000, 1)).toBe(50100);
  });

  it("throws for impossible ports", () => {
    expect(() => allocatePort(60000, 100)).toThrow(/out of valid range/);
  });

  it("honours a custom portStride", () => {
    expect(allocatePort(8000, 2, 100)).toBe(28200);
    expect(allocatePort(8081, 1, 100)).toBe(28181);
    expect(allocatePort(8081, 2, 100)).toBe(28281);
    // stride defaults to 1 (current behaviour)
    expect(allocatePort(8000, 2)).toBe(28002);
  });
});

describe("assignPortSlots", () => {
  it("assigns distinct slots within the slot space", () => {
    const labels = ["a", "b", "c", "feature/x", "release-1.2", "chore-things"];
    const slots = assignPortSlots(labels);

    expect(slots.size).toBe(labels.length);
    const values = [...slots.values()];
    expect(new Set(values).size).toBe(values.length);
    for (const slot of values) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PORT_SLOT_SPACE);
    }
  });

  it("is deterministic and independent of input order", () => {
    const first = assignPortSlots(["alpha", "beta", "gamma"]);
    const second = assignPortSlots(["gamma", "alpha", "beta"]);
    expect(new Map(first)).toEqual(new Map(second));
  });

  it("keeps a label's slot when unrelated labels are added or removed", () => {
    const alone = assignPortSlots(["alpha"]).get("alpha");
    const withSiblings = assignPortSlots(["alpha", "beta", "gamma"]).get("alpha");
    const afterRemoval = assignPortSlots(["alpha", "beta"]).get("alpha");

    expect(withSiblings).toBe(alone);
    expect(afterRemoval).toBe(alone);
  });

  it("dedupes repeated labels", () => {
    const slots = assignPortSlots(["alpha", "alpha"]);
    expect(slots.size).toBe(1);
  });

  it("throws when the label set exceeds the slot space", () => {
    const tooMany = Array.from({ length: PORT_SLOT_SPACE + 1 }, (_, i) => `wt-${i}`);
    expect(() => assignPortSlots(tooMany)).toThrow(/Too many worktree stacks/);
  });
});

describe("allocateWorktreePorts", () => {
  const mappings: PortMapping[] = [
    {
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      defaultPort: 5434,
      containerPort: 5432,
      raw: "${POSTGRES_PORT:-5434}:5432",
    },
    {
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      defaultPort: 8000,
      containerPort: 8000,
      raw: "${BACKEND_PORT:-8000}:8000",
    },
    {
      serviceName: "nginx",
      envVar: null,
      defaultPort: 8080,
      containerPort: 80,
      raw: "8080:80",
    },
  ];

  it("allocates ports for overridable services only", () => {
    const result = allocateWorktreePorts(mappings, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      port: 25435,
      containerPort: 5432,
    });
    expect(result[1]).toEqual({
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      port: 28001,
      containerPort: 8000,
    });
  });

  it("skips raw port mappings (no envVar)", () => {
    const result = allocateWorktreePorts(mappings, 1);
    const names = result.map((a) => a.serviceName);
    expect(names).not.toContain("nginx");
  });

  it("produces different ports for different slots", () => {
    const r1 = allocateWorktreePorts(mappings, 1);
    const r2 = allocateWorktreePorts(mappings, 2);

    expect(r1[0].port).not.toBe(r2[0].port);
    expect(r1[1].port).not.toBe(r2[1].port);
  });

  it("applies the portStride to each slot", () => {
    const r1 = allocateWorktreePorts(mappings, 1, 100);
    const r2 = allocateWorktreePorts(mappings, 2, 100);

    // postgres default 5434, backend default 8000
    expect(r1.map((a) => a.port)).toEqual([25534, 28100]);
    expect(r2.map((a) => a.port)).toEqual([25634, 28200]);
  });
});

describe("cross-worktree collision detection", () => {
  // Clustered defaults: six mock ports (8081-8086) bunched together, plus
  // spread-out api/web/temporal/mtls. Adjacent slots collide at stride 1.
  const clustered: PortMapping[] = [
    { serviceName: "api", defaultPort: 3000 },
    { serviceName: "web", defaultPort: 5173 },
    { serviceName: "temporal", defaultPort: 8233 },
    { serviceName: "mtls", defaultPort: 8444 },
    { serviceName: "mock-api", defaultPort: 8081 },
    { serviceName: "mock-oauth2-auth", defaultPort: 8082 },
    { serviceName: "mock-oauth2-res", defaultPort: 8083 },
    { serviceName: "mock-jwt", defaultPort: 8085 },
    { serviceName: "mock-sentinel", defaultPort: 8086 },
  ].map((s) => ({
    ...s,
    envVar: s.serviceName.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_PORT",
    containerPort: s.defaultPort,
    raw: `\${X:-${s.defaultPort}}:${s.defaultPort}`,
  }));

  it("finds the three known collisions for adjacent slots 1 & 2 at stride 1", () => {
    const slots = new Map([
      ["one", 1],
      ["two", 2],
    ]);
    const collisions = detectCrossWorktreeCollisions(clustered, slots, 1);
    const ports = collisions.map((c) => c.port).sort((a, b) => a - b);
    expect(ports).toEqual([28083, 28084, 28087]);
  });

  it("is collision-free at stride 100", () => {
    const adjacent = new Map(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((label, i) => [
        label,
        i,
      ]),
    );
    expect(detectCrossWorktreeCollisions(clustered, adjacent, 100)).toEqual([]);

    const hashed = assignPortSlots(["alpha", "beta"]);
    expect(detectCrossWorktreeCollisions(clustered, hashed, 100)).toEqual([]);
  });

  it("reports the colliding labels and services", () => {
    const slots = new Map([
      ["one", 1],
      ["two", 2],
    ]);
    const collisions = detectCrossWorktreeCollisions(clustered, slots, 1);
    const on28083 = collisions.find((c) => c.port === 28083);
    expect(on28083).toMatchObject({
      a: { label: "one", serviceName: "mock-oauth2-auth" },
      b: { label: "two", serviceName: "mock-api" },
    });
  });

  it("recommends a stride that is collision-free over the horizon", () => {
    const stride = recommendPortStride(clustered, ["one", "two"]);
    expect(stride).toBeGreaterThan(1);

    // The recommendation must hold for the labels it was computed from.
    const slots = assignPortSlots(["one", "two"]);
    expect(detectCrossWorktreeCollisions(clustered, slots, stride)).toEqual([]);
  });

  it("does not throw when allocations overflow during the search", () => {
    // A very high default port forces allocatePort out of range deep in the
    // horizon; recommendPortStride must stay non-fatal and report -1.
    const highPort: PortMapping[] = [
      {
        serviceName: "huge",
        envVar: "HUGE_PORT",
        defaultPort: 60000,
        containerPort: 60000,
        raw: "${HUGE_PORT:-60000}:60000",
      },
    ];
    expect(() => recommendPortStride(highPort, ["one", "two"])).not.toThrow();
    expect(recommendPortStride(highPort, ["one", "two"])).toBe(-1);
  });
});

describe("allocationEnv", () => {
  it("maps allocated ports to string environment values", () => {
    const env = allocationEnv([
      {
        serviceName: "postgres",
        envVar: "POSTGRES_PORT",
        port: 25434,
        containerPort: 5432,
      },
      {
        serviceName: "backend",
        envVar: "BACKEND_PORT",
        port: 28001,
        containerPort: 8000,
      },
    ]);

    expect(env).toEqual({ POSTGRES_PORT: "25434", BACKEND_PORT: "28001" });
  });

  it("returns an empty object when nothing is allocatable", () => {
    expect(allocationEnv([])).toEqual({});
  });
});
