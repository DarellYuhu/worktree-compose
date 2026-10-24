import { parseLabelString, parsePsContainers, parsePsJson, stackStatus } from "../../src/compose/status.js";

const dockerNdjson = [
  {
    ID: "a1",
    Names: "myapp-wt-1-feat-web-1",
    State: "running",
    Labels:
      "com.docker.compose.project=myapp-wt-1-feat,com.docker.compose.project.config_files=/w/a/compose.yaml,/w/a/compose.override.yaml,com.docker.compose.service=web",
  },
  {
    ID: "a2",
    Names: "myapp-wt-1-feat-db-1",
    State: "exited",
    Labels: "com.docker.compose.service=db,com.docker.compose.project=myapp-wt-1-feat",
  },
  {
    ID: "b1",
    Names: "myapp-wt-2-x-web-1",
    State: "running",
    Labels: "com.docker.compose.project=myapp-wt-2-x",
  },
  { ID: "c1", Names: "standalone", State: "running", Labels: "maintainer=someone" },
]
  .map((c) => JSON.stringify(c))
  .join("\n");

const podmanArray = JSON.stringify([
  {
    Id: "p1",
    Names: ["myapp-wt-3-y_web_1"],
    State: "running",
    Labels: { "io.podman.compose.project": "myapp-wt-3-y", "com.example": "a,b=c" },
  },
  {
    Id: "p2",
    Names: ["myapp-wt-3-y_db_1"],
    State: "exited",
    Labels: { "io.podman.compose.project": "myapp-wt-3-y" },
  },
  { Id: "p3", Names: ["loose"], State: "running", Labels: null },
]);

describe("parsePsJson", () => {
  it("parses Docker NDJSON with string labels (commas inside values)", () => {
    const states = parsePsJson(dockerNdjson);
    expect(states.get("myapp-wt-1-feat")).toEqual({ running: 1, total: 2 });
    expect(states.get("myapp-wt-2-x")).toEqual({ running: 1, total: 1 });
    expect(states.size).toBe(2);
  });

  it("parses a Podman JSON array with object labels", () => {
    const states = parsePsJson(podmanArray);
    expect(states.get("myapp-wt-3-y")).toEqual({ running: 1, total: 2 });
    expect(states.size).toBe(1);
  });

  it("does not count one-off `compose run` containers", () => {
    const states = parsePsJson(
      [
        {
          ID: "s1",
          Names: "myapp-wt-1-a-r-1",
          State: "running",
          Labels: "com.docker.compose.project=myapp-wt-1-a,com.docker.compose.oneoff=False",
        },
        {
          ID: "o1",
          Names: "myapp-wt-1-a-r-run-1a2b3c",
          State: "exited",
          Labels: "com.docker.compose.project=myapp-wt-1-a,com.docker.compose.oneoff=True",
        },
      ]
        .map((c) => JSON.stringify(c))
        .join("\n"),
    );
    expect(states.get("myapp-wt-1-a")).toEqual({ running: 1, total: 1 });

    const podman = parsePsJson(
      JSON.stringify([
        { Id: "p1", Names: ["myapp-wt-3-y_web_1"], State: "running", Labels: { "io.podman.compose.project": "myapp-wt-3-y" } },
        { Id: "p2", Names: ["myapp-wt-3-y_web_tmp12345"], State: "exited", Labels: { "io.podman.compose.project": "myapp-wt-3-y" } },
      ]),
    );
    expect(podman.get("myapp-wt-3-y")).toEqual({ running: 1, total: 1 });
  });

  it("treats empty output as no containers", () => {
    expect(parsePsJson("").size).toBe(0);
    expect(parsePsJson("[]").size).toBe(0);
  });

  it("throws on output that is not JSON", () => {
    expect(() => parsePsJson("CONTAINER ID   IMAGE")).toThrow();
  });
});

describe("parsePsContainers", () => {
  it("exposes project, working_dir, state and one-off per container", () => {
    const listing = [
      {
        ID: "s1",
        Names: "myapp-wt-1-a-web-1",
        State: "Running",
        Labels:
          "com.docker.compose.project=myapp-wt-1-a,com.docker.compose.project.config_files=/w/my dir/a=b.yml,/w/x.yml,com.docker.compose.project.working_dir=/w/my dir,com.docker.compose.oneoff=False",
      },
      {
        ID: "o1",
        Names: "myapp-wt-1-a-web-run-1",
        State: "exited",
        Labels: "com.docker.compose.project=myapp-wt-1-a,com.docker.compose.oneoff=TRUE",
      },
      { ID: "x1", Names: "loose", State: "running", Labels: "" },
    ]
      .map((c) => JSON.stringify(c))
      .join("\n");
    const containers = parsePsContainers(listing);
    expect(containers.map((c) => [c.project, c.workingDir, c.state, c.running, c.oneoff])).toEqual([
      ["myapp-wt-1-a", "/w/my dir", "running", true, false],
      ["myapp-wt-1-a", null, "exited", false, true],
      [null, null, "running", true, false],
    ]);
    // …while the per-project counts skip the one-off.
    expect([...parsePsJson(listing)]).toEqual([["myapp-wt-1-a", { running: 1, total: 1 }]]);
  });
});

describe("parseLabelString", () => {
  it("keeps commas that belong to a value", () => {
    expect(parseLabelString("a=1,files=/x.yml,/y.yml,b=2")).toEqual({
      a: "1",
      files: "/x.yml,/y.yml",
      b: "2",
    });
  });

  it("only starts a new label at an identifier key", () => {
    expect(parseLabelString("files=/a b/c=d.yml,/e.yml,com.docker.compose.service=web")).toEqual({
      files: "/a b/c=d.yml,/e.yml",
      "com.docker.compose.service": "web",
    });
  });

  it("keeps Docker Desktop's '/'-keyed labels out of the values before them", () => {
    const labels = [
      "com.docker.compose.project=myapp-wt-1-a",
      "desktop.docker.io/binds/0/SourceKind=hostFile",
      "com.docker.compose.project.working_dir=/w/myapp-a",
      "desktop.docker.io/binds/0/Source=/w/myapp-a/conf",
      "com.docker.compose.oneoff=True",
      "desktop.docker.io/binds/0/Target=/conf",
      "com.docker.compose.project.config_files=/w/myapp-a/compose.yaml,/a b/c=d.yml",
    ].join(",");
    expect(parseLabelString(labels)).toEqual({
      "com.docker.compose.project": "myapp-wt-1-a",
      "desktop.docker.io/binds/0/SourceKind": "hostFile",
      "com.docker.compose.project.working_dir": "/w/myapp-a",
      "desktop.docker.io/binds/0/Source": "/w/myapp-a/conf",
      "com.docker.compose.oneoff": "True",
      "desktop.docker.io/binds/0/Target": "/conf",
      "com.docker.compose.project.config_files": "/w/myapp-a/compose.yaml,/a b/c=d.yml",
    });
    const [c] = parsePsContainers(JSON.stringify({ ID: "1", Names: "x", State: "running", Labels: labels }));
    expect(c).toMatchObject({ project: "myapp-wt-1-a", workingDir: "/w/myapp-a", oneoff: true });
  });
});

describe("stackStatus", () => {
  it("labels states", () => {
    expect(stackStatus({ running: 2, total: 2 })).toBe("up");
    expect(stackStatus({ running: 1, total: 3 })).toBe("partial");
    expect(stackStatus({ running: 0, total: 3 })).toBe("exited");
    expect(stackStatus({ running: 0, total: 0 })).toBe("down");
    expect(stackStatus(null)).toBe("?");
  });
});
