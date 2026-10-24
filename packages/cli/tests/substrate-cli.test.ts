/**
 * `swarm substrate start|stop|status` act on the stack the project it is run
 * from uses — its dedicated stack when its config declares one — resolved the
 * same way the startup path resolves it.
 *
 * Every port here is made up or only named, and stopping, health and Postgres
 * probes are injected: these tests never reach a real sidecar, never bind a
 * port and never signal a real process.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalOnlyViolation } from "@mnmal-ai/swarm-substrate";
import {
  reportSubstrateStack,
  resolveSubstrateStack,
  skipsSubstrateStartup,
  stopSubstrateStack,
  substrateStart,
  SUBSTRATE_HELP,
  type StatusDeps,
} from "../src/cli/substrate.js";
import { ProjectSubstrateConfigError } from "../src/project-substrate.js";
import {
  STACK,
  swarmDir,
  dedicatedProject,
  fakeMachine,
  isolateSubstrateProject,
  projectConfig,
  saveGlobalConfig,
  sharedProject,
} from "./substrate-project-fixture.js";

isolateSubstrateProject();

const portOf = (url: string) => new URL(url).port;

describe("resolveSubstrateStack", () => {
  it("resolves a project's dedicated stack, whatever the global config says", () => {
    saveGlobalConfig({ substrate_url: "http://localhost:32338" });
    const stack = resolveSubstrateStack(dedicatedProject());
    expect(stack.kind).toBe("dedicated");
    expect(portOf(stack.cold.endpoint)).toBe("45002");
    expect(portOf(stack.meta.endpoint)).toBe("45005");
    expect(stack.cold.postgresUrl).toBe(STACK.postgres_url);
    expect(stack.meta.postgresUrl).toBe(STACK.meta_postgres_url);
    expect(stack.cold.managed && stack.meta.managed).toBe(true);
  });

  it("names a dedicated stack's sidecars by its compose project, or by its port when it has none", () => {
    const named = resolveSubstrateStack(dedicatedProject({ compose_project: "project-a-substrate" }));
    expect(named.cold.spec.stack).toBe("project-a-substrate");
    expect(named.meta.spec.stack).toBe("project-a-substrate");
    const unnamed = resolveSubstrateStack(dedicatedProject());
    expect(unnamed.cold.spec.stack).toBe("swarm-dedicated-45002");
  });

  it("carries the compose project that runs a dedicated stack's Postgres", () => {
    const stack = resolveSubstrateStack(
      dedicatedProject({ compose_file: "substrate/dc.yml", compose_project: "project-a-substrate" }),
    );
    expect(stack.compose).toEqual({
      file: join(swarmDir(), "domains", "project-a", "substrate", "dc.yml"),
      project: "project-a-substrate",
      env: { SWARM_DEDICATED_PG_PORT: "45001", SWARM_DEDICATED_META_PG_PORT: "45004" },
    });
  });

  it("resolves the shared stack like the startup path: saved substrate_url, then the default", () => {
    const byDefault = resolveSubstrateStack(sharedProject());
    expect(byDefault.kind).toBe("shared");
    expect(byDefault.cold.endpoint).toBe("http://localhost:32338");
    expect(byDefault.meta.endpoint).toBe("http://localhost:32341");
    expect(byDefault.source).toBe("default");
    expect(byDefault.cold.spec.stack).toBeUndefined();

    saveGlobalConfig({ substrate_url: "http://localhost:47400" });
    const saved = resolveSubstrateStack(sharedProject());
    expect(saved.cold.endpoint).toBe("http://localhost:47400");
    expect(saved.source).toMatch(/substrate_url/);
    // Not the cold spec's own port: someone else's sidecar, never swarm's to stop.
    expect(saved.cold.managed).toBe(false);
  });

  it("keeps the environment overrides for the shared stack", () => {
    process.env.SWARM_SUBSTRATE_PORT = "47500";
    process.env.SWARM_META_PORT = "47501";
    let stack = resolveSubstrateStack(sharedProject());
    expect(portOf(stack.cold.endpoint)).toBe("47500");
    expect(portOf(stack.meta.endpoint)).toBe("47501");
    expect(stack.cold.spec.port).toBe(47500);

    saveGlobalConfig({ substrate_url: "http://localhost:47400" });
    process.env.SWARM_SUBSTRATE_ENDPOINT = "http://127.0.0.1:47600";
    stack = resolveSubstrateStack(sharedProject());
    expect(stack.cold.endpoint).toBe("http://127.0.0.1:47600");
    expect(stack.source).toBe("SWARM_SUBSTRATE_ENDPOINT");
  });

  it("refuses an environment that points a dedicated project at another stack", () => {
    process.env.SWARM_SUBSTRATE_PORT = "32338";
    expect(() => resolveSubstrateStack(dedicatedProject())).toThrow(ProjectSubstrateConfigError);
  });

  it("never resolves off this machine for a local_only project", () => {
    saveGlobalConfig({ substrate_url: "http://10.1.2.3:32338" });
    expect(() => resolveSubstrateStack(projectConfig({ local_only: true }))).toThrow(LocalOnlyViolation);
  });
});

describe("stopSubstrateStack", () => {
  const busyMachine = { 45002: 4101, 45005: 4102, 32338: 3101, 32341: 3102 };

  it("stops the dedicated stack's cold and meta sidecars and never the shared ones", async () => {
    const m = fakeMachine(busyMachine);
    await stopSubstrateStack(resolveSubstrateStack(dedicatedProject({ compose_project: "project-a-substrate" })), m.deps);
    expect(m.killed).toEqual([4101, 4102]);
    expect(m.asked).toEqual([45002, 45005]);
    expect(m.stacks).toEqual(["project-a-substrate", "project-a-substrate"]);
  });

  it("stops the shared stack's sidecars when the project has no stack of its own", async () => {
    const m = fakeMachine(busyMachine);
    await stopSubstrateStack(resolveSubstrateStack(sharedProject()), m.deps);
    expect(m.killed).toEqual([3101, 3102]);
    expect(m.stacks).toEqual([undefined, undefined]);
  });

  it("does not stop a sidecar swarm did not start for this stack (a saved substrate_url elsewhere)", async () => {
    saveGlobalConfig({ substrate_url: "http://localhost:47400" });
    const m = fakeMachine({ 47400: 4401, ...busyMachine });
    await stopSubstrateStack(resolveSubstrateStack(sharedProject()), m.deps);
    expect(m.asked).toEqual([32341]);
    expect(m.killed).toEqual([3102]);
    expect(m.output()).toMatch(/47400.*not a sidecar swarm started/);
  });

  it("says so when nothing of the project's stack is running", async () => {
    const m = fakeMachine({ 32338: 3101, 32341: 3102 });
    await stopSubstrateStack(resolveSubstrateStack(dedicatedProject()), m.deps);
    expect(m.killed).toEqual([]);
    expect(m.output()).toMatch(/nothing .*running/i);
    expect(m.output()).toContain("45002");
    expect(m.output()).toContain("45005");
  });

  it("leaves the dedicated Postgres and its volumes alone, and says how to stop it", async () => {
    const project = dedicatedProject({ compose_file: "substrate/dc.yml", compose_project: "project-a-substrate" });
    const m = fakeMachine(busyMachine);
    await stopSubstrateStack(resolveSubstrateStack(project), m.deps);
    expect(m.killed).toEqual([4101, 4102]);
    expect(m.output()).toMatch(/left running, with its data volumes/i);
    // The compose file refuses to load without its port variables.
    expect(m.output()).toContain(
      "SWARM_DEDICATED_PG_PORT=45001 SWARM_DEDICATED_META_PG_PORT=45004 " +
        `docker compose -p project-a-substrate -f ${join(swarmDir(), "domains", "project-a", "substrate", "dc.yml")} stop`,
    );
  });

  it("reports a pid it would not signal, and does not claim nothing is running", async () => {
    const m = fakeMachine({ 45005: 4102 });
    const deps = {
      ...m.deps,
      stop: async (spec: Parameters<typeof m.deps.stop>[0]) =>
        spec.port === 45002
          ? { stopped: false, pid: 4101, reason: "pid 4101 is not this stack's Substrate sidecar: its working directory is unreadable" }
          : m.deps.stop(spec),
    };
    await stopSubstrateStack(resolveSubstrateStack(dedicatedProject()), deps);
    expect(m.killed).toEqual([4102]);
    expect(m.output()).toMatch(/pid 4101 is not this stack's Substrate sidecar/);
    expect(m.output()).not.toMatch(/nothing .*running/i);
  });

  it("reports a stop that failed, without throwing", async () => {
    const m = fakeMachine({});
    const deps = {
      ...m.deps,
      stop: async () => {
        throw new Error("EPERM");
      },
    };
    await expect(stopSubstrateStack(resolveSubstrateStack(dedicatedProject()), deps)).resolves.toEqual([]);
    expect(m.output()).toMatch(/could not stop.*EPERM/i);
    expect(m.output()).not.toMatch(/nothing .*running/i);
  });

  it("stops only the sidecars it is asked to", async () => {
    const m = fakeMachine(busyMachine);
    await stopSubstrateStack(resolveSubstrateStack(dedicatedProject()), m.deps, ["cold"]);
    expect(m.asked).toEqual([45002]);
    expect(m.killed).toEqual([4101]);
  });
});

/** A pretend machine for status: which ports answer, and how many namespaces each sidecar serves. */
function fakeProbes(up: number[], namespaces: Record<number, number> = {}) {
  const lines: string[] = [];
  const deps: StatusDeps = {
    isHealthy: async (endpoint) => up.includes(Number(new URL(endpoint).port)),
    namespaceCount: async (endpoint) => namespaces[Number(new URL(endpoint).port)] ?? null,
    probePostgres: async (url) => {
      const u = new URL(url);
      const port = Number(u.port || 5432);
      return { reachable: up.includes(port), host: u.hostname, port };
    },
    log: (line) => {
      lines.push(line);
    },
  };
  const lineWith = (needle: string) => lines.find((l) => l.includes(needle)) ?? "";
  return { deps, output: () => lines.join("\n"), lineWith };
}

describe("reportSubstrateStack", () => {
  it("reports the dedicated stack's own sidecars and Postgres, one line each, on their real ports", async () => {
    const stack = resolveSubstrateStack(
      dedicatedProject({ compose_file: "substrate/dc.yml", compose_project: "project-a-substrate" }),
    );
    const p = fakeProbes([45002, 45001], { 45002: 4 });
    const { coldHealthy } = await reportSubstrateStack(stack, p.deps);

    expect(coldHealthy).toBe(true);
    expect(p.output()).toMatch(/dedicated/);
    expect(p.output()).toContain("project-a-substrate");
    expect(p.lineWith("45002")).toMatch(/cold sidecar.*healthy.*4 namespaces/i);
    expect(p.lineWith("45005")).toMatch(/meta sidecar.*not running/i);
    expect(p.lineWith("45001")).toMatch(/cold postgres.*running/i);
    expect(p.lineWith("45004")).toMatch(/meta postgres.*not reachable/i);
    for (const shared of ["32337", "32338", "32340", "32341"]) expect(p.output()).not.toContain(shared);
  });

  it("never prints a Postgres URL's credentials", async () => {
    const p = fakeProbes([]);
    await reportSubstrateStack(resolveSubstrateStack(dedicatedProject()), p.deps);
    expect(p.output()).not.toContain("swarm:swarm@");
  });

  it("names the shared stack and where its endpoint came from", async () => {
    const p = fakeProbes([32337, 32338, 32340, 32341], { 32338: 3, 32341: 1 });
    const { coldHealthy } = await reportSubstrateStack(resolveSubstrateStack(sharedProject()), p.deps);
    expect(coldHealthy).toBe(true);
    expect(p.output()).toMatch(/shared/);
    expect(p.output()).toMatch(/default/);
    expect(p.lineWith("32338")).toMatch(/cold sidecar.*healthy.*3 namespaces/i);
    expect(p.lineWith("32341")).toMatch(/meta sidecar.*healthy.*1 namespace\b/i);
    expect(p.lineWith("32337")).toMatch(/cold postgres.*running/i);
    expect(p.lineWith("32340")).toMatch(/meta postgres.*running/i);
  });

  it("says when a healthy sidecar's namespaces could not be read", async () => {
    const p = fakeProbes([32338]);
    await reportSubstrateStack(resolveSubstrateStack(sharedProject()), p.deps);
    expect(p.lineWith("32338")).toMatch(/healthy.*namespaces unknown/i);
  });

  it("reports a Substrate on the in-memory store without probing a Postgres", async () => {
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "memory";
    const p = fakeProbes([]);
    await reportSubstrateStack(resolveSubstrateStack(sharedProject()), p.deps);
    expect(p.output()).toMatch(/cold postgres.*in-memory store/i);
  });
});

describe("substrateStart", () => {
  it("reads the db config of the swarm directory it was given, and brings that stack up", async () => {
    const resolveDbConfig = vi.fn(async () => ({ source: "docker" as const, postgresUrl: "postgresql://x", dockerComposeDir: "/infra" }));
    const ensure = vi.fn(async () => ({}) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await substrateStart(dedicatedProject({ compose_project: "project-a-substrate" }), { "swarm-path": "/elsewhere/.swarm" }, { resolveDbConfig, ensure });
    } finally {
      log.mockRestore();
    }
    expect(resolveDbConfig).toHaveBeenCalledWith({ swarmDir: "/elsewhere/.swarm" });
    expect(ensure).toHaveBeenCalledWith({ quiet: false, dockerComposeDir: "/infra", isolated: { composeProject: "project-a-substrate" } });
  });

  it("defaults to .swarm", async () => {
    const resolveDbConfig = vi.fn(async () => null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await substrateStart(sharedProject(), {}, { resolveDbConfig, ensure: vi.fn(async () => ({}) as never) });
    } finally {
      log.mockRestore();
    }
    expect(resolveDbConfig).toHaveBeenCalledWith({ swarmDir: ".swarm" });
  });
});

describe("skipsSubstrateStartup", () => {
  it("skips the startup path for stop and status, which must see the stack as it is", () => {
    // Starting the stack first would make stop start what it then stops, and
    // status could never report a stack that is down.
    expect(skipsSubstrateStartup("stop")).toBe(true);
    expect(skipsSubstrateStartup("status")).toBe(true);
  });

  it("keeps the startup path for everything else", () => {
    for (const sub of ["start", undefined]) expect(skipsSubstrateStartup(sub)).toBe(false);
  });
});

describe("swarm substrate help", () => {
  it("lists start, stop and status, and nothing else", () => {
    expect(SUBSTRATE_HELP).toMatch(/start/);
    expect(SUBSTRATE_HELP).toMatch(/stop/);
    expect(SUBSTRATE_HELP).toMatch(/status/);
    expect(SUBSTRATE_HELP).not.toMatch(/dashboard|explore/);
  });
});
