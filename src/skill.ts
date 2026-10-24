import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent skill shipped with the package. Resolved relative to this module:
 * `dist/skill.js` → `<package>/SKILL.md` (and `src/skill.ts` → repo root in
 * development), so it works from any install location.
 */
export const SKILL_PATH = fileURLToPath(new URL("../SKILL.md", import.meta.url));

export const SKILL_DIR_NAME = "worktree-compose";

export function readSkill(): string {
  if (!fs.existsSync(SKILL_PATH)) {
    throw new Error(`Bundled SKILL.md not found at ${SKILL_PATH}.`);
  }
  return fs.readFileSync(SKILL_PATH, "utf-8");
}

/**
 * Write SKILL.md to `<dir>/worktree-compose/SKILL.md` (default dir:
 * `~/.claude/skills`), creating directories. Returns the written path.
 */
export function installSkill(dir?: string): string {
  const base = dir ? path.resolve(dir) : path.join(os.homedir(), ".claude", "skills");
  const dest = path.join(base, SKILL_DIR_NAME, "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, readSkill(), "utf-8");
  return dest;
}
