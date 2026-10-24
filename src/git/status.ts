import { run } from "../utils/exec.js";

/**
 * Parse `git status --porcelain -z` output into the affected paths. Each entry
 * is `XY <path>\0`; renames and copies (`R`/`C` in either column) are followed
 * by the original path as an extra NUL-terminated field, which is included.
 */
export function parseStatusZ(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(xy) && i + 1 < fields.length) {
      paths.push(fields[++i]);
    }
  }
  return paths;
}

/** Every path with uncommitted changes (including untracked files) in a checkout. */
export function getStatusPaths(cwd: string): string[] {
  return parseStatusZ(
    run(
      "git",
      ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"],
      { trim: false },
    ),
  );
}
