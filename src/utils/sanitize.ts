export function sanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

export function composeProjectName(
  repoName: string,
  index: number,
  branch: string,
): string {
  return sanitize(`${repoName}-wt-${index}-${branch}`);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anchored pattern for resource names (containers, networks, volumes) that
 * belong to this repo's worktree stacks: `<repo>-wt-<n>-…`. Anchoring matters:
 * an unanchored `-wt-` match also hits other repos' stacks (`othermyapp-wt-1-x`).
 */
export function worktreeResourcePattern(repoName: string): RegExp {
  const prefix = sanitize(repoName);
  return new RegExp(`^${prefix ? `${escapeRegExp(prefix)}-` : ""}wt-\\d+-`);
}
