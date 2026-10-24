/**
 * sync --force kills sidecar
 *
 * `swarm sync --force` resets the database and stops the sidecar so a fresh
 * one starts. killSidecar() stops only the cold sidecar of the stack this
 * project resolves to — through its stack directory's server.pid, as
 * `swarm substrate stop` does — never the meta sidecar (force-sync does not
 * reset the meta store) and never another project's sidecars. It used to run
 * a machine-wide `pkill`, which killed every project's sidecars.
 *
 * Stopping goes through a fake: nothing here signals a real process.
 */

import { describe, expect, it } from "vitest";
import { killSidecar } from "../src/cli/db.js";
import { dedicatedProject, fakeMachine, isolateSubstrateProject, sharedProject } from "./substrate-project-fixture.js";

isolateSubstrateProject();

// This project's dedicated stack, another project's dedicated stack, and the
// shared stack, all up at once.
const busyMachine = {
  45002: 4101,
  45005: 4102,
  46002: 4601,
  46005: 4602,
  32338: 3101,
  32341: 3102,
};

describe("killSidecar", () => {
  it("stops this project's dedicated cold sidecar, never another stack's", async () => {
    const m = fakeMachine(busyMachine);
    await killSidecar(dedicatedProject({ compose_project: "project-a" }), m.deps);
    expect(m.killed).toEqual([4101]);
    expect(m.asked).toEqual([45002]);
    expect(m.stacks).toEqual(["project-a"]);
  });

  it("stops only the shared cold sidecar for a project without its own stack", async () => {
    const m = fakeMachine(busyMachine);
    await killSidecar(sharedProject(), m.deps);
    expect(m.killed).toEqual([3101]);
  });

  it("leaves the meta sidecar running: force-sync resets only the cold store", async () => {
    const m = fakeMachine(busyMachine);
    await killSidecar(dedicatedProject(), m.deps);
    await killSidecar(sharedProject(), m.deps);
    expect(m.asked).not.toContain(45005);
    expect(m.asked).not.toContain(32341);
  });

  it("reports, without throwing, a pid it would not signal", async () => {
    const m = fakeMachine({});
    const deps = {
      ...m.deps,
      stop: async () => ({ stopped: false, pid: 4101, reason: "pid 4101 is not this stack's Substrate sidecar" }),
    };
    await expect(killSidecar(dedicatedProject(), deps)).resolves.toEqual([]);
    expect(m.output()).toMatch(/pid 4101 is not this stack's Substrate sidecar/);
  });

  it("does not throw when nothing is running", async () => {
    const m = fakeMachine({});
    await expect(killSidecar(dedicatedProject(), m.deps)).resolves.toEqual([]);
    expect(m.killed).toEqual([]);
  });
});
