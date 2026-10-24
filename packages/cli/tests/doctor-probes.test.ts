/**
 * `swarm doctor`: one row per piece of the Substrate stack, each unhealthy row
 * with a fix line. Every probe is injected, so nothing here runs node, dials a
 * port or reads the real ~/.swarm.
 */
import { describe, expect, it, vi } from "vitest";
import { NodeVersionError, NODE_VERSION_FLOOR } from "@mnmal-ai/swarm-substrate";
import { collectDoctorRows, type DoctorDeps, type DoctorRow, getDoctorTargets } from "../src/cli/doctor-probes.js";
import { runDoctor } from "../src/cli/doctor.js";
import { dedicatedProject, isolateSubstrateProject } from "./substrate-project-fixture.js";
import { applyProjectSubstrateConfig } from "../src/project-substrate.js";

isolateSubstrateProject();

/** A machine where everything is up; override what a test needs down. */
function machine(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    resolveNode: async () => ({ path: "/opt/node/bin/node", version: "26.10.0" }),
    findRuntime: () => ({
      runtimeDir: "/home/u/.swarm/substrate/runtime",
      substrateBin: "/home/u/.swarm/substrate/runtime/node_modules/@mnmal-ai/substrate/dist/substrate.js",
      installedMarker: "/home/u/.swarm/substrate/runtime/.installed-abc",
    }),
    runtimeDir: () => "/home/u/.swarm/substrate/runtime",
    platform: "darwin",
    findLsof: () => "/usr/sbin/lsof",
    probePostgres: async () => true,
    isHealthy: async () => true,
    servesNamespace: async () => true,
    probeHttp: async () => true,
    ...overrides,
  };
}

const row = (rows: DoctorRow[], component: string): DoctorRow => {
  const found = rows.find((r) => r.component === component);
  expect(found, `a '${component}' row`).toBeDefined();
  return found!;
};

describe("collectDoctorRows", () => {
  it("lists the stack in order, all ok on a healthy machine", async () => {
    const rows = await collectDoctorRows(machine());
    expect(rows.map((r) => r.component)).toEqual([
      "Node",
      "Substrate runtime",
      "lsof",
      "cold Postgres",
      "cold sidecar",
      "meta Postgres",
      "meta sidecar",
      "dashboard",
    ]);
    expect(rows.every((r) => r.state === "ok")).toBe(true);
    expect(rows.every((r) => r.fixCommand === undefined)).toBe(true);
  });

  it("reports Node below 26.2.0 with the floor and a fix line", async () => {
    const rows = await collectDoctorRows(
      machine({
        resolveNode: async () => {
          throw new NodeVersionError(
            "Node 24.0.0 at /usr/bin/node is too old for the Substrate sidecar, which needs Node 26.2.0 or newer. Fix: install Node 26.2 or newer.",
            "24.0.0",
            "/usr/bin/node",
          );
        },
      }),
    );
    const node = row(rows, "Node");
    expect(NODE_VERSION_FLOOR).toBe("26.2.0");
    expect(node.state).toBe("down");
    expect(node.detail).toContain("24.0.0");
    expect(node.detail).toContain("/usr/bin/node");
    expect(node.detail).toContain("26.2.0");
    expect(node.fixCommand).toMatch(/26\.2/);
    expect(node.fixCommand).toMatch(/mise/);
    expect(node.fixCommand).toMatch(/package manager/);
    // A floor problem is not fixed by starting the stack.
    expect(node.fixCommand).not.toMatch(/swarm substrate start/);
  });

  it("reports no Node at all, with the floor and the same fix", async () => {
    const rows = await collectDoctorRows(
      machine({
        resolveNode: async () => {
          throw new NodeVersionError("No Node found: SWARM_NODE is unset and there is no node on PATH.", null, null);
        },
      }),
    );
    const node = row(rows, "Node");
    expect(node.state).toBe("down");
    expect(node.detail).toMatch(/no node/i);
    expect(node.detail).toContain("26.2.0");
    expect(node.fixCommand).toMatch(/mise/);
  });

  it("reports a Node that gave no version in resolveNode's words, without its Fix tail", async () => {
    const rows = await collectDoctorRows(
      machine({
        resolveNode: async () => {
          throw new NodeVersionError(
            "Node (unknown version) at /usr/bin/true is too old for the Substrate sidecar, which needs Node 26.2.0 or newer. Fix: install Node 26.2 or newer.",
            null,
            "/usr/bin/true",
          );
        },
      }),
    );
    const node = row(rows, "Node");
    expect(node.state).toBe("down");
    expect(node.detail).toContain("/usr/bin/true");
    expect(node.detail).toContain("26.2.0");
    expect(node.detail).not.toContain("Fix:");
    expect(node.fixCommand).toMatch(/mise/);
  });

  it("names the Node it found when it is new enough", async () => {
    const node = row(await collectDoctorRows(machine()), "Node");
    expect(node.detail).toContain("26.10.0");
    expect(node.detail).toContain("/opt/node/bin/node");
  });

  it("reports a missing runtime with `swarm substrate start` as the fix", async () => {
    const runtime = row(await collectDoctorRows(machine({ findRuntime: () => null })), "Substrate runtime");
    expect(runtime.state).toBe("down");
    expect(runtime.detail).toContain("/home/u/.swarm/substrate/runtime");
    expect(runtime.fixCommand).toBe("swarm substrate start");
  });

  it("reports lsof missing on macOS, where stopping a sidecar needs it, with a fix line", async () => {
    const lsof = row(await collectDoctorRows(machine({ findLsof: () => null })), "lsof");
    expect(lsof.state).toBe("down");
    expect(lsof.detail).toMatch(/stop/);
    expect(lsof.fixCommand).toMatch(/lsof/);
  });

  it("has no lsof row off macOS", async () => {
    const rows = await collectDoctorRows(machine({ platform: "linux", findLsof: () => null }));
    expect(rows.find((r) => r.component === "lsof")).toBeUndefined();
  });

  it("points every stack row at `swarm substrate start`", async () => {
    const rows = await collectDoctorRows(
      machine({ probePostgres: async () => false, isHealthy: async () => false }),
    );
    for (const component of ["cold Postgres", "cold sidecar", "meta Postgres", "meta sidecar"]) {
      const r = row(rows, component);
      expect(r.state).toBe("down");
      expect(r.fixCommand).toBe("swarm substrate start");
    }
  });

  it("flags a healthy sidecar that does not serve its namespace", async () => {
    const rows = await collectDoctorRows(machine({ servesNamespace: async (_url, ns) => ns !== "swarm_meta" }));
    expect(row(rows, "cold sidecar").state).toBe("ok");
    const meta = row(rows, "meta sidecar");
    expect(meta.state).toBe("wrong-namespace");
    expect(meta.detail).toContain("swarm_meta");
    expect(meta.fixCommand).toBe("swarm substrate start");
  });

  it("never dials a Postgres for the in-memory store", async () => {
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "memory";
    const probePostgres = vi.fn(async () => true);
    const rows = await collectDoctorRows(machine({ probePostgres }));
    expect(row(rows, "cold Postgres").detail).toMatch(/in-memory/);
    expect(probePostgres).toHaveBeenCalledTimes(1); // meta only
  });

  it("never throws, whatever is down", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    const rows = await collectDoctorRows(
      machine({
        resolveNode: boom,
        findRuntime: () => {
          throw new Error("boom");
        },
        probePostgres: boom,
        isHealthy: boom,
        servesNamespace: boom,
        probeHttp: boom,
      }),
    );
    expect(rows).toHaveLength(8);
    expect(rows.some((r) => r.state === "ok")).toBe(true); // lsof still found
  });
});

describe("getDoctorTargets", () => {
  it("probes the endpoints and Postgres the run would use: the shared stack by default", () => {
    const [cold, meta] = getDoctorTargets();
    expect(cold.endpoint).toBe("http://localhost:32338");
    expect(meta.endpoint).toBe("http://localhost:32341");
    expect(cold.pgUrl).toContain(":32337/");
    expect(meta.pgUrl).toContain(":32340/");
  });

  it("follows a dedicated project's stack once the preamble applied it", () => {
    applyProjectSubstrateConfig(dedicatedProject());
    const [cold, meta] = getDoctorTargets();
    expect(cold.endpoint).toBe("http://127.0.0.1:45002");
    expect(meta.endpoint).toBe("http://127.0.0.1:45005");
    expect(cold.pgUrl).toContain(":45001/");
    expect(meta.pgUrl).toContain(":45004/");
  });

  it("suggests `swarm substrate start` for the sidecars, never a hand-run script", () => {
    for (const target of getDoctorTargets()) {
      expect(target.sidecarFixCommand).toBe("swarm substrate start");
      expect(target.sidecarFixCommand).not.toContain("npx tsx");
    }
  });
});

describe("runDoctor", () => {
  it("prints every row, a fix line under each unhealthy one, and the CLI version", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ""));
    });
    try {
      await runDoctor({}, machine({ isHealthy: async () => false }));
    } finally {
      log.mockRestore();
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes.
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toMatch(/cold sidecar\s+down/);
    expect(out).toMatch(/fix: swarm substrate start/);
    expect(out).toMatch(/swarm CLI\s+ok/);
  });
});
