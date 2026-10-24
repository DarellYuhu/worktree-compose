import { fnv1a } from "../utils/sanitize.js";
import type { PortMapping, PortAllocation } from "./types.js";

const BASE_OFFSET = 20000;

/** Slot space for hash-based port isolation (512 parallel worktree stacks). */
export const PORT_SLOT_SPACE = 512;

export function allocatePort(
  defaultPort: number,
  slot: number,
  portStride: number = 1,
): number {
  let port = BASE_OFFSET + defaultPort + slot * portStride;

  if (port > 65535) {
    port = defaultPort + 100 * slot;
  }

  if (port > 65535 || port < 1024) {
    throw new Error(
      `Cannot allocate port for default ${defaultPort} at slot ${slot}. ` +
        `Computed port ${port} is out of valid range (1024-65535).`,
    );
  }

  return port;
}

/**
 * Deterministic slot per label: FNV-1a hash modulo the slot space, with
 * linear probing in sorted label order so two worktrees never share a slot.
 * Slots are independent of the worktree list order, so adding or removing a
 * worktree never moves another worktree's ports (probing only ever affects
 * labels that actually collided in the hash space).
 */
export function assignPortSlots(labels: string[]): Map<string, number> {
  const sorted = [...new Set(labels)].sort();
  if (sorted.length > PORT_SLOT_SPACE) {
    throw new Error(
      `Too many worktree stacks (${sorted.length}) for ` +
        `${PORT_SLOT_SPACE} port slots.`,
    );
  }

  const taken = new Set<number>();
  const slots = new Map<string, number>();
  for (const label of sorted) {
    let slot = fnv1a(label) % PORT_SLOT_SPACE;
    while (taken.has(slot)) {
      slot = (slot + 1) % PORT_SLOT_SPACE;
    }
    taken.add(slot);
    slots.set(label, slot);
  }
  return slots;
}

export function allocateWorktreePorts(
  mappings: PortMapping[],
  slot: number,
  portStride: number = 1,
): PortAllocation[] {
  const overridable = mappings.filter((m) => m.envVar !== null);

  const allocations: PortAllocation[] = overridable.map((m) => ({
    serviceName: m.serviceName,
    envVar: m.envVar!,
    port: allocatePort(m.defaultPort, slot, portStride),
    containerPort: m.containerPort,
  }));

  const seen = new Set<number>();
  for (const a of allocations) {
    if (seen.has(a.port)) {
      throw new Error(
        `Port collision: ${a.port} is assigned to multiple services at slot ${slot}.`,
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
  label: string;
  serviceName: string;
}

export interface PortCollision {
  port: number;
  a: PortCollisionParty;
  b: PortCollisionParty;
}

/**
 * Cross-worktree collisions across the assigned slots. Probing keeps slots
 * distinct, but a stride that divides a default-port difference can still
 * align two services from different slots onto the same port.
 */
export function detectCrossWorktreeCollisions(
  mappings: PortMapping[],
  slotByLabel: Map<string, number>,
  portStride: number,
): PortCollision[] {
  const overridable = mappings.filter((m) => m.envVar !== null);
  const seen = new Map<number, PortCollisionParty>();
  const collisions: PortCollision[] = [];

  for (const [label, slot] of slotByLabel) {
    for (const m of overridable) {
      const port = allocatePort(m.defaultPort, slot, portStride);
      const prev = seen.get(port);
      if (prev) {
        collisions.push({
          port,
          a: prev,
          b: { label, serviceName: m.serviceName },
        });
      } else {
        seen.set(port, { label, serviceName: m.serviceName });
      }
    }
  }

  return collisions;
}

const STRIDE_SEARCH_CAP = 4096;
const STRIDE_HORIZON = 100;

/**
 * Smallest portStride that is collision-free across a generous horizon of
 * labels (the actual ones plus synthetic future stacks, so the suggestion
 * survives adding worktrees). Returns -1 if no stride within the search cap
 * works — which signals duplicate default ports within a worktree, a case the
 * per-worktree dedup guard already rejects.
 */
export function recommendPortStride(
  mappings: PortMapping[],
  labels: string[],
): number {
  const horizon = [...new Set(labels)];
  for (let i = 0; horizon.length < STRIDE_HORIZON; i++) {
    horizon.push(`wtc-future-${i}`);
  }
  const slots = assignPortSlots(horizon);

  for (let s = 1; s <= STRIDE_SEARCH_CAP; s++) {
    try {
      if (detectCrossWorktreeCollisions(mappings, slots, s).length === 0) {
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
