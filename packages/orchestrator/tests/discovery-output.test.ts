/**
 * Discovery keeps all of a command's output, even when the OS reports the
 * exit before the last of it has been read (the same race as run_command).
 * The child here exits first and writes after.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";

const fake = vi.hoisted(() => ({ child: undefined as undefined | (() => unknown) }));

vi.mock("@mnmal-ai/swarm-types", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    spawnInGroup: (...args: unknown[]) => unknown;
    killGroup: (pid: number) => Promise<void>;
  };
  return {
    ...actual,
    spawnInGroup: (...args: unknown[]) => (fake.child ? fake.child() : actual.spawnInGroup(...args)),
    killGroup: async (pid: number) => (fake.child ? undefined : actual.killGroup(pid)),
  };
});

const { runDiscovery } = await import("../src/orchestrator/discovery.js");

function exitsBeforeItsOutput(out: string, err: string) {
  const child = Object.assign(new EventEmitter(), { pid: 4_000_001, stdout: new PassThrough(), stderr: new PassThrough() });
  setImmediate(() => {
    child.emit("exit", 1, null);
    setTimeout(() => {
      child.stdout.end(out);
      child.stderr.end(err);
      void Promise.all([finished(child.stdout), finished(child.stderr)]).then(() => child.emit("close", 1, null));
    }, 20);
  });
  return child;
}

describe("runDiscovery output", () => {
  afterEach(() => {
    fake.child = undefined;
  });

  it("keeps output that arrives after the command exits", async () => {
    fake.child = () => exitsBeforeItsOutput("3 tests, 1 failing", "error: expected 2, got 3");
    const { results } = await runDiscovery([{ command: "npm test", cwd: "/tmp", label: "test" }]);
    expect(results[0]).toMatchObject({ success: false, exitCode: 1, stdout: "3 tests, 1 failing", stderr: "error: expected 2, got 3" });
  });
});
