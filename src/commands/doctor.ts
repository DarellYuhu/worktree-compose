import chalk from "chalk";
import { doctor } from "../core/doctor.js";
import type { CheckStatus } from "../core/doctor.js";
import { print } from "../utils/log.js";

const ICONS: Record<CheckStatus, string> = {
  ok: chalk.green("✔"),
  warn: chalk.yellow("⚠"),
  fail: chalk.red("✖"),
};

export async function doctorCommand(options: { json?: boolean } = {}): Promise<void> {
  const result = await doctor({ live: true });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      print(`${ICONS[check.status]} ${check.title}`);
      if (check.detail) print(chalk.dim(`    ${check.detail}`));
      if (check.hint) print(chalk.cyan(`    → ${check.hint}`));
    }
    const fails = result.checks.filter((c) => c.status === "fail").length;
    const warns = result.checks.filter((c) => c.status === "warn").length;
    print(
      `\n${fails > 0 ? chalk.red(`${fails} problem(s)`) : chalk.green("No problems")}` +
        (warns > 0 ? `, ${chalk.yellow(`${warns} warning(s)`)}` : "") +
        ".",
    );
  }

  if (!result.ok) process.exitCode = 1;
}
