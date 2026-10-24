import { suggestEnvVar } from "../ports/extract.js";
import {
  detectCrossWorktreeCollisions,
  recommendPortStride,
} from "../ports/allocate.js";
import { isProjectScopedName } from "./parse.js";
import type { PortCollision } from "../ports/allocate.js";
import type { PortMapping } from "../ports/types.js";
import type { ComposeFile } from "./types.js";

/**
 * Compose settings that defeat per-worktree isolation: a fixed
 * `container_name` (the second stack cannot start), and volumes/networks with
 * a fixed `name:` or `external` (every stack shares them).
 */
export function composeIsolationWarnings(composeFile: ComposeFile): string[] {
  const warnings: string[] = [];
  for (const svc of composeFile.services) {
    if (svc.containerName && !isProjectScopedName(svc.containerName)) {
      warnings.push(
        `Service "${svc.name}" sets container_name "${svc.containerName}" — every worktree stack would use the same name and the second one fails to start. Remove container_name.`,
      );
    }
  }
  for (const v of composeFile.sharedVolumes) {
    warnings.push(
      `Volume "${v.key}" has a fixed name/external — it is shared by every worktree stack (not isolated).`,
    );
  }
  for (const n of composeFile.sharedNetworks) {
    warnings.push(
      `Network "${n.key}" has a fixed name/external — it is shared by every worktree stack (not isolated).`,
    );
  }
  return warnings;
}

/** Raw `host:container` port mappings that cannot be remapped per worktree. */
export function rawPortWarnings(portMappings: PortMapping[]): string[] {
  return portMappings
    .filter((m) => m.envVar === null)
    .map(
      (p) =>
        `Service "${p.serviceName}" uses a raw port mapping (${p.raw}). ` +
        `To enable port isolation, change it to: "\${${suggestEnvVar(p.serviceName)}:-${p.defaultPort}}:${p.containerPort}"`,
    );
}

/**
 * Advisory cross-worktree collision warning over the indices actually in use
 * (live worktrees plus orphans that still reserve theirs).
 */
export function portCollisionWarnings(
  portMappings: PortMapping[],
  portStride: number,
  indices: number[],
): string[] {
  const inUse = [...new Set(indices)];
  if (inUse.length < 2) return [];

  // Collision detection is advisory; an allocation failure here must never
  // abort the command that triggered the warning.
  let collisions: PortCollision[];
  try {
    collisions = detectCrossWorktreeCollisions(portMappings, portStride, inUse);
  } catch {
    return [];
  }
  if (collisions.length === 0) return [];

  const examples = collisions
    .slice(0, 3)
    .map(
      (c) =>
        `${c.port} (wt${c.a.worktreeIndex}/${c.a.serviceName} ↔ wt${c.b.worktreeIndex}/${c.b.serviceName})`,
    )
    .join(", ");
  const recommended = recommendPortStride(portMappings, Math.max(...inUse));
  const fix =
    recommended > 0
      ? `Set "portStride": ${recommended} in .wtcrc.json (or package.json#wtc) to resolve.`
      : `No single portStride resolves this — check for services sharing the same default port.`;

  return [
    `Cross-worktree port collisions detected with portStride=${portStride} ` +
      `across worktrees ${inUse.sort((a, b) => a - b).join(", ")}: ${collisions.length} collision(s), e.g. ${examples}. ${fix}`,
  ];
}
