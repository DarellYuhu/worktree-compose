import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandError,
  run,
  runAsync,
  runSafe,
} from "../../src/utils/exec.js";

const ECHO_ARG = "process.stdout.write(process.argv[1])";

describe("exec layer (no shell)", () => {
  let tmpDir: string;
  let marker: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-exec-")));
    marker = path.join(tmpDir, "pwned");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ["command substitution", (m: string) => `$(touch ${m})`],
    ["backticks", (m: string) => `\`touch ${m}\``],
    ["quotes and separators", (m: string) => `"; touch ${m}; echo "`],
    ["single quotes and pipes", (m: string) => `' | touch ${m} #`],
  ])("passes %s through literally", (_label, payload) => {
    const arg = payload(marker);
    expect(run("node", ["-e", ECHO_ARG, arg])).toBe(arg);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("passes payloads literally through runAsync too", async () => {
    const arg = `$(touch ${marker})`;
    const result = await runAsync("node", ["-e", ECHO_ARG, arg]);
    expect(result.stdout).toBe(arg);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("throws a CommandError carrying the exit code, command and stderr", () => {
    let caught: unknown;
    try {
      run("node", ["-e", "process.stderr.write('boom: disk full\\n'); process.exit(3)"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    const err = caught as CommandError;
    expect(err.code).toBe(3);
    expect(err.stderr).toBe("boom: disk full");
    expect(err.command).toContain("node -e");
    expect(err.message).toContain("exit 3");
    expect(err.message).toContain("boom: disk full");
  });

  it("reports a missing executable clearly", () => {
    expect(() => run("wtc-definitely-not-a-binary", [])).toThrow(/Command not found/);
  });

  it("runSafe returns null instead of throwing", () => {
    expect(runSafe("node", ["-e", "process.exit(1)"])).toBeNull();
    expect(runSafe("node", ["-e", "process.stdout.write(' ok ')"])).toBe("ok");
  });

  it("runAsync rejects with the stderr tail", async () => {
    await expect(
      runAsync("node", ["-e", "console.error('compose: port is already allocated'); process.exit(1)"]),
    ).rejects.toMatchObject({
      name: "CommandError",
      code: 1,
      stderr: "compose: port is already allocated",
    });
  });

  it("runAsync keeps only a bounded tail of the output", async () => {
    const result = await runAsync("node", [
      "-e",
      "for (let i = 0; i < 1000; i++) console.log('line ' + i)",
    ]);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines[lines.length - 1]).toBe("line 999");
  });

  it("runAsync honours cwd and env", async () => {
    const result = await runAsync(
      "node",
      ["-e", "process.stdout.write(process.cwd() + '|' + process.env.WTC_TEST_VALUE)"],
      { cwd: tmpDir, env: { ...process.env, WTC_TEST_VALUE: "x y" } },
    );
    expect(result.stdout).toBe(`${tmpDir}|x y`);
  });

  it("kills a command that exceeds its timeout (sync and async)", async () => {
    const start = Date.now();
    expect(() => run("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 300 })).toThrow(
      /Command timed out after 0s/,
    );
    await expect(runAsync("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 300 })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("aborts a running command when its signal fires, and streams lines", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const pending = runAsync(
      "node",
      ["-e", "console.log('building'); setTimeout(() => {}, 5000)"],
      {
        signal: controller.signal,
        onLine: (line) => {
          lines.push(line);
          controller.abort();
        },
      },
    );
    await expect(pending).rejects.toThrow(/Command cancelled/);
    expect(lines).toEqual(["building"]);
  });
});
