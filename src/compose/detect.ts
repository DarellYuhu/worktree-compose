import fs from "node:fs";
import path from "node:path";

export const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export function detectComposeFile(repoRoot: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    const full = path.join(repoRoot, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
