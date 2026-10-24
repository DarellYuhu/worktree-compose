import {
  composeArgs,
  daemonCheckArgs,
  engineFromArgv,
  NO_ENGINE_MESSAGE,
  resolveEngine,
} from "../../src/compose/engine.js";

describe("resolveEngine", () => {
  const none = () => false;

  it("prefers WTC_COMPOSE_COMMAND", () => {
    const engine = resolveEngine(
      { composeCommand: "docker compose" },
      { WTC_COMPOSE_COMMAND: "  podman   compose " },
      none,
    );
    expect(engine).toEqual({
      compose: ["podman", "compose"],
      cli: "podman",
      cliArgv: ["podman"],
      label: "podman compose",
    });
  });

  it("uses config composeCommand to choose a known tool (string or array)", () => {
    expect(resolveEngine({ composeCommand: "docker-compose" }, {}, none)).toMatchObject({
      compose: ["docker-compose"],
      cli: "docker",
      cliArgv: ["docker"],
    });
    expect(resolveEngine({ composeCommand: ["podman", "compose"] }, {}, none)).toMatchObject({
      compose: ["podman", "compose"],
      cli: "podman",
    });
    expect(resolveEngine({ composeCommand: "podman-compose" }, {}, none)).toMatchObject({ cli: "podman" });
  });

  it("refuses an arbitrary command from repository config", () => {
    for (const composeCommand of [
      ["touch", "/tmp/pwned"],
      "/opt/bin/podman-compose --podman-run-args=--quiet",
      ["docker", "--config", "./plugins", "compose"],
      "docker compose --file evil.yml",
    ]) {
      expect(() => resolveEngine({ composeCommand }, {}, none)).toThrow(
        /is not a known compose tool.*set WTC_COMPOSE_COMMAND/,
      );
    }
  });

  it("accepts any command from the WTC_COMPOSE_COMMAND environment variable", () => {
    expect(
      resolveEngine({}, { WTC_COMPOSE_COMMAND: "/opt/bin/podman-compose --podman-run-args=--quiet" }, none),
    ).toMatchObject({ compose: ["/opt/bin/podman-compose", "--podman-run-args=--quiet"], cli: "podman" });
  });

  it("rejects an empty composeCommand", () => {
    expect(() => resolveEngine({ composeCommand: "  " }, {}, none)).toThrow(/Invalid "composeCommand"/);
    expect(() => resolveEngine({ composeCommand: [] }, {}, none)).toThrow(/Invalid "composeCommand"/);
  });

  it("auto-detects in order: docker compose, podman compose, docker-compose, podman-compose", () => {
    const tried: string[] = [];
    const only = (wanted: string) => (argv: string[]) => {
      tried.push(argv.join(" "));
      return argv.join(" ") === wanted;
    };

    expect(resolveEngine({}, {}, only("docker-compose")).label).toBe("docker-compose");
    // Every candidate is checked: whether several are installed decides daemon probing.
    expect(tried).toEqual(["docker compose", "podman compose", "docker-compose", "podman-compose"]);

    expect(resolveEngine({}, {}, only("podman-compose"))).toMatchObject({ cli: "podman" });
    expect(resolveEngine({}, {}, () => true).label).toBe("docker compose");
  });

  it("prefers an installed engine whose daemon answers", () => {
    const installed = () => true;
    const podmanUp = (cliArgv: string[]) => cliArgv[0] === "podman";
    expect(resolveEngine({}, {}, installed, podmanUp).label).toBe("podman compose");
  });

  it("falls back to the first installed engine when no daemon answers", () => {
    expect(resolveEngine({}, {}, () => true, () => false).label).toBe("docker compose");
  });

  it("probes daemons only when more than one engine is installed, each daemon once", () => {
    const asked: string[] = [];
    const daemon = (cliArgv: string[]) => {
      asked.push(cliArgv.join(" "));
      return false;
    };
    // One installed engine: taken as is, no daemon call.
    const only = (argv: string[]) => argv.join(" ") === "docker compose";
    expect(resolveEngine({}, {}, only, daemon).label).toBe("docker compose");
    expect(asked).toEqual([]);

    // docker compose + docker-compose + podman-compose: the docker daemon is asked once.
    const three = (argv: string[]) => argv.join(" ") !== "podman compose";
    expect(resolveEngine({}, {}, three, daemon).label).toBe("docker compose");
    expect(asked).toEqual(["docker", "podman"]);
  });

  it("checks a daemon with `<cliArgv> info` (version answers without a daemon)", () => {
    expect(daemonCheckArgs(engineFromArgv(["docker", "--context", "colima", "compose"]))).toEqual([
      "docker",
      ["--context", "colima", "info"],
    ]);
    expect(daemonCheckArgs(engineFromArgv(["podman-compose"]))).toEqual(["podman", ["info"]]);
  });

  it("explains how to fix a missing engine", () => {
    expect(() => resolveEngine({}, {}, none)).toThrow(NO_ENGINE_MESSAGE);
  });
});

describe("engineFromArgv", () => {
  it("keeps global flags before `compose` for container-CLI calls", () => {
    expect(engineFromArgv(["docker", "--context", "colima", "compose"]).cliArgv).toEqual([
      "docker",
      "--context",
      "colima",
    ]);
    expect(engineFromArgv(["/usr/local/bin/podman", "--remote", "compose"])).toMatchObject({
      cli: "podman",
      cliArgv: ["/usr/local/bin/podman", "--remote"],
    });
    expect(engineFromArgv(["docker-compose"]).cliArgv).toEqual(["docker"]);
    expect(engineFromArgv(["podman-compose"]).cliArgv).toEqual(["podman"]);
  });
});

describe("composeArgs", () => {
  it("puts -p <project> after the compose prefix", () => {
    const docker = engineFromArgv(["docker", "compose"]);
    expect(composeArgs(docker, "p1", "up", "-d")).toEqual(["compose", "-p", "p1", "up", "-d"]);
    expect(composeArgs(engineFromArgv(["podman-compose"]), "p1", "down")).toEqual(["-p", "p1", "down"]);
  });
});
