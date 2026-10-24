import {
  composeProjectName,
  resolveProjectNames,
  sanitize,
  shortHash,
} from "../../src/utils/sanitize.js";

describe("sanitize", () => {
  it("lowercases and strips non-name characters", () => {
    expect(sanitize("Feature/Login_V2")).toBe("feature-login-v2");
    expect(sanitize("--weird--name--")).toBe("weird-name");
  });
});

describe("shortHash", () => {
  it("is stable for the same input", () => {
    expect(shortHash("feature/login")).toBe(shortHash("feature/login"));
  });

  it("differs for different inputs", () => {
    expect(shortHash("feature/login")).not.toBe(shortHash("feature/logout"));
  });
});

describe("composeProjectName", () => {
  it("is repo-prefixed, branch-based, and index-free", () => {
    expect(composeProjectName("ruker", "feature/login-v2")).toBe(
      "ruker-wt-feature-login-v2",
    );
  });

  it("never exceeds the 63-character project-name limit", () => {
    const name = composeProjectName(
      "a-very-long-repository-name",
      "feature/some-extremely-long-branch-name-that-keeps-going-and-going",
    );
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/-[0-9a-f]{6}$/);
  });

  it("gives truncated names distinct hashes for distinct labels", () => {
    const prefix = "feature/some-extremely-long-branch-name-that-keeps-going";
    const first = composeProjectName("repo", `${prefix}-one`);
    const second = composeProjectName("repo", `${prefix}-two`);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
  });
});

describe("resolveProjectNames", () => {
  it("maps every label to a name", () => {
    const names = resolveProjectNames("ruker", ["main", "feature/login"]);
    expect(names.get("main")).toBe("ruker-wt-main");
    expect(names.get("feature/login")).toBe("ruker-wt-feature-login");
  });

  it("disambiguates labels that sanitize to the same name", () => {
    const names = resolveProjectNames("repo", ["feature/v2", "feature-v2"]);

    expect(new Set(names.values()).size).toBe(2);
    // The lexicographically smaller label keeps the clean name.
    expect(names.get("feature-v2")).toBe("repo-wt-feature-v2");
    expect(names.get("feature/v2")).toMatch(/^repo-wt-feature-v2-[0-9a-f]{6}$/);
  });

  it("is deterministic for a given label set", () => {
    const labels = ["b", "a", "c", "feature/v2", "feature-v2"];
    const first = resolveProjectNames("repo", labels);
    const second = resolveProjectNames("repo", [...labels].reverse());
    expect(new Map(first)).toEqual(new Map(second));
  });
});
