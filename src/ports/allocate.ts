import type { PortMapping, PortAllocation } from "./types.js";

const BASE_OFFSET = 20000;

export function allocatePort(
  defaultPort: number,
  worktreeIndex: number,
  portStride: number = 1,
): number {
  let port = BASE_OFFSET + defaultPort + worktreeIndex * portStride;

  if (port > 65535) {
    port = defaultPort + 100 * worktreeIndex;
  }

  if (port > 65535 || port < 1024) {
    throw new Error(
      `Cannot allocate port for default ${defaultPort} at worktree index ${worktreeIndex}. ` +
        `Computed port ${port} is out of valid range (1024-65535).`,
    );
  }

  return port;
}

export function allocateWorktreePorts(
  mappings: PortMapping[],
  worktreeIndex: number,
  portStride: number = 1,
): PortAllocation[] {
  const overridable = mappings.filter((m) => m.envVar !== null);

  const allocations: PortAllocation[] = overridable.map((m) => ({
    serviceName: m.serviceName,
    envVar: m.envVar!,
    port: allocatePort(m.defaultPort, worktreeIndex, portStride),
    containerPort: m.containerPort,
  }));

  const seen = new Set<number>();
  for (const a of allocations) {
    if (seen.has(a.port)) {
      throw new Error(
        `Port collision: ${a.port} is assigned to multiple services in worktree ${worktreeIndex}.`,
      );
    }
    seen.add(a.port);
  }

  return allocations;
}

/**
 * Environment variables for a `docker compose` invocation so `${VAR}`
 * interpolation resolves to the allocated ports. Shell environment values take
 * precedence over `.env` files, which makes this independent of the configured
 * env filename — Compose never reads `.env.development` (or any custom name)
 * for interpolation, only the project `.env`, `--env-file`, and the process
 * environment.
 */
export function allocationEnv(
  allocations: PortAllocation[],
): Record<string, string> {
  return Object.fromEntries(
    allocations.map((a) => [a.envVar, String(a.port)]),
  );
}

export interface PortCollisionParty {
  worktreeIndex: number;
  serviceName: string;
}

export interface PortCollision {
  port: number;
  a: PortCollisionParty;
  b: PortCollisionParty;
}

/**
 * Detect cross-worktree port collisions for a given stride. `worktrees` is
 * either a count (indices 1..n) or the exact indices in use — persistent
 * indices can have gaps (e.g. 2, 3, 7), and only the ones actually assigned
 * can collide. Returns one entry per colliding allocation.
 */
export function detectCrossWorktreeCollisions(
  mappings: PortMapping[],
  portStride: number,
  worktrees: number | number[],
): PortCollision[] {
  const overridable = mappings.filter((m) => m.envVar !== null);
  const seen = new Map<number, PortCollisionParty>();
  const collisions: PortCollision[] = [];
  const indices = Array.isArray(worktrees)
    ? [...new Set(worktrees)].sort((a, b) => a - b)
    : Array.from({ length: worktrees }, (_, i) => i + 1);

  for (const w of indices) {
    for (const m of overridable) {
      const port = allocatePort(m.defaultPort, w, portStride);
      const prev = seen.get(port);
      if (prev) {
        collisions.push({
          port,
          a: prev,
          b: { worktreeIndex: w, serviceName: m.serviceName },
        });
      } else {
        seen.set(port, { worktreeIndex: w, serviceName: m.serviceName });
      }
    }
  }

  return collisions;
}

const STRIDE_SEARCH_CAP = 4096;

/**
 * Smallest portStride that is collision-free across a generous worktree
 * horizon (so the suggestion survives adding more worktrees). Returns -1 if
 * no stride within the search cap works — which signals duplicate default
 * ports within a worktree, a case the per-worktree dedup guard already rejects.
 */
export function recommendPortStride(
  mappings: PortMapping[],
  worktreeCount: number,
): number {
  const horizon = Math.max(worktreeCount, 100);
  for (let s = 1; s <= STRIDE_SEARCH_CAP; s++) {
    try {
      if (detectCrossWorktreeCollisions(mappings, s, horizon).length === 0) {
        return s;
      }
    } catch {
      // This stride overflows the valid range at the chosen horizon; it could
      // not be used safely anyway, so skip it and try the next one.
      continue;
    }
  }
  return -1;
}
