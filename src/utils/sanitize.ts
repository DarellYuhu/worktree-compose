const MAX_PROJECT_NAME_LENGTH = 63;

export function sanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

/** FNV-1a over Unicode code points — stable across runs, processes, machines. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (const ch of input) {
    hash ^= ch.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shortHash(input: string, length = 6): string {
  return fnv1a(input)
    .toString(16)
    .padStart(8, "0")
    .slice(-length);
}

/**
 * Compose project name for one worktree: `{repo}-wt-{label}`, where the label
 * is the branch (or the short HEAD sha for detached worktrees). Names longer
 * than Docker's 63-character project-name limit are truncated with a short
 * hash of the raw label so distinct long labels never collapse into one name.
 */
export function composeProjectName(repoName: string, label: string): string {
  const base = sanitize(`${repoName}-wt-${label}`);
  if (base.length <= MAX_PROJECT_NAME_LENGTH) return base;
  return withHashSuffix(base, shortHash(label));
}

/**
 * One compose project name per label. Labels that sanitize to the same name
 * (e.g. `feature/v2` and `feature-v2`) keep the lexicographically smallest
 * one clean; the rest get a short hash of their raw label appended, so the
 * result is deterministic for a given set of worktrees.
 */
export function resolveProjectNames(
  repoName: string,
  labels: string[],
): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const label of labels) {
    const base = composeProjectName(repoName, label);
    const group = groups.get(base) ?? [];
    group.push(label);
    groups.set(base, group);
  }

  const names = new Map<string, string>();
  for (const [base, group] of groups) {
    [...group].sort().forEach((label, position) => {
      if (position === 0) {
        names.set(label, base);
        return;
      }
      names.set(label, withHashSuffix(base, shortHash(label)));
    });
  }
  return names;
}

function withHashSuffix(name: string, hash: string): string {
  const trimmed = name.slice(0, MAX_PROJECT_NAME_LENGTH - hash.length - 1);
  return `${trimmed}-${hash}`;
}
