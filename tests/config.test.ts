import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveConfig } from "../src/context.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-config-")));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  it("names the file in JSON parse errors", () => {
    fs.writeFileSync(path.join(dir, ".wtcrc.json"), '{ "portStride": 10, }');
    expect(() => loadConfig(dir)).toThrow(`Invalid JSON in ${path.join(dir, ".wtcrc.json")}:`);
  });

  it("names package.json in parse errors too", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ nope");
    expect(() => loadConfig(dir)).toThrow(`Invalid JSON in ${path.join(dir, "package.json")}:`);
  });

  it("reads package.json#wtc", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ wtc: { portStride: 5 } }));
    expect(loadConfig(dir)).toEqual({ portStride: 5 });
  });
});

describe("resolveConfig validation", () => {
  it("requires sync to be an array of strings", () => {
    expect(() => resolveConfig({ sync: "nginx" as unknown as string[] }, {})).toThrow(/Invalid "sync"/);
    expect(() => resolveConfig({ sync: ["ok", 3 as unknown as string] }, {})).toThrow(/Invalid "sync"/);
    expect(resolveConfig({ sync: ["nginx"] }, {}).sync).toEqual(["nginx"]);
  });

  it("validates composeCommand", () => {
    expect(() => resolveConfig({ composeCommand: 42 as unknown as string }, {})).toThrow(/Invalid "composeCommand"/);
    expect(() => resolveConfig({ composeCommand: [] }, {})).toThrow(/Invalid "composeCommand"/);
    expect(resolveConfig({ composeCommand: "podman compose" }, {}).composeCommand).toBe("podman compose");
  });

  it("accepts a $schema key", () => {
    expect(resolveConfig({ $schema: "./node_modules/worktree-compose/wtc.schema.json" }, {}).envFile).toBe(".env");
  });
});
