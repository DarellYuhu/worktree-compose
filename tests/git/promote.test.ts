import { isEnvFile } from "../../src/git/promote.js";

describe("isEnvFile", () => {
  it("excludes local env files at any depth", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile(".env.development")).toBe(true);
    expect(isEnvFile("apps/server/.env.local")).toBe(true);
  });

  it("keeps committed env templates promotable", () => {
    for (const f of [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      "apps/web/.env.defaults",
    ]) {
      expect(isEnvFile(f)).toBe(false);
    }
  });

  it("ignores files that merely contain .env", () => {
    expect(isEnvFile("src/env.ts")).toBe(false);
    expect(isEnvFile("docs/.envrc")).toBe(false);
  });
});
