import { buildWorktreePlans } from "../../src/plan.js";
import type { WorktreeInfo } from "../../src/git/worktree.js";

function wt(
  path: string,
  branch: string,
  head = "0123456789abcdef",
): WorktreeInfo {
  return { path, branch, head, isMain: false };
}

describe("buildWorktreePlans", () => {
  it("names projects after the branch, not the list position", () => {
    const plans = buildWorktreePlans("ruker", [
      wt("/r-a", "feature/login"),
      wt("/r-b", "fix/api"),
    ]);

    expect(plans.map((p) => p.project)).toEqual([
      "ruker-wt-feature-login",
      "ruker-wt-fix-api",
    ]);
  });

  it("aligns plans with the input worktrees positionally", () => {
    const worktrees = [wt("/r-a", "one"), wt("/r-b", "two")];
    const plans = buildWorktreePlans("ruker", worktrees);

    expect(plans.map((p) => p.wt.path)).toEqual(["/r-a", "/r-b"]);
    expect(plans.map((p) => p.label)).toEqual(["one", "two"]);
  });

  it("uses the short HEAD sha as label for detached worktrees", () => {
    const plans = buildWorktreePlans("ruker", [wt("/r-a", "detached")]);

    expect(plans[0].label).toBe("0123456");
    expect(plans[0].project).toBe("ruker-wt-0123456");
  });

  it("assigns stable slots regardless of worktree order", () => {
    const forward = buildWorktreePlans("ruker", [
      wt("/r-a", "one"),
      wt("/r-b", "two"),
    ]);
    const reversed = buildWorktreePlans("ruker", [
      wt("/r-b", "two"),
      wt("/r-a", "one"),
    ]);

    const slotOf = (plans: ReturnType<typeof buildWorktreePlans>) =>
      new Map(plans.map((p) => [p.label, p.slot]));

    expect(slotOf(forward)).toEqual(slotOf(reversed));
    expect(new Set(slotOf(forward).values()).size).toBe(2);
  });

  it("disambiguates branches that sanitize to the same project name", () => {
    const plans = buildWorktreePlans("repo", [
      wt("/r-a", "feature/v2"),
      wt("/r-b", "feature-v2"),
    ]);

    const names = plans.map((p) => p.project);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("repo-wt-feature-v2");
  });

  it("disambiguates detached worktrees at the same commit", () => {
    const plans = buildWorktreePlans("ruker", [
      wt("/r-a", "detached", "0123456789abcdef"),
      wt("/r-b", "detached", "0123456789abcdef"),
    ]);

    expect(plans[0].project).not.toBe(plans[1].project);
    expect(plans[0].slot).not.toBe(plans[1].slot);
    expect(plans[0].project).toMatch(/^ruker-wt-0123456-/);
    expect(plans[1].project).toMatch(/^ruker-wt-0123456-/);
  });
});
