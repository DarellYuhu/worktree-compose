import { installSkill, readSkill } from "../skill.js";
import * as log from "../utils/log.js";

export async function skillCommand(options: { install?: boolean; dir?: string } = {}): Promise<void> {
  if (options.install || options.dir) {
    const dest = installSkill(options.dir);
    log.success(`Installed the worktree-compose skill at ${dest}`);
    return;
  }
  process.stdout.write(readSkill());
}
