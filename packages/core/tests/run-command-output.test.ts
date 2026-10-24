/**
 * run_command returns everything a command wrote, even when the OS reports
 * the exit before the last of the output has been read. Node
 * reads a child's pipes separately from its exit: under load the `exit`
 * event can come first, and a reader that stopped there returned
 * "(no output)" for a command that printed.
 *
 * The child here is a stand-in that exits first and writes afterwards, so the
 * ordering is certain rather than a matter of load.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fake = vi.hoisted(() => ({ child: undefined as undefined | (() => unknown) }));

vi.mock("@mnmal-ai/swarm-types", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    spawnInGroup: (...args: unknown[]) => unknown;
    killGroup: (pid: number) => Promise<void>;
  };
  return {
    ...actual,
    spawnInGroup: (...args: unknown[]) => (fake.child ? fake.child() : actual.spawnInGroup(...args)),
    // The stand-in has no process group to kill.
    killGroup: async (pid: number) => (fake.child ? undefined : actual.killGroup(pid)),
  };
});

const { executeTool } = await import("../src/index.js");

/** Exits, then writes `out` and `err` 20 ms later. With `closeStreams: false`, stdout stays open (a descendant holding the pipe). */
function exitsBeforeItsOutput(out: string, err: string, opts: { closeStreams: boolean } = { closeStreams: true }) {
  const child = Object.assign(new EventEmitter(), { pid: 4_000_000, stdout: new PassThrough(), stderr: new PassThrough() });
  setImmediate(() => {
    child.emit("exit", 0, null);
    setTimeout(() => {
      if (!opts.closeStreams) {
        child.stdout.write(out);
        return;
      }
      child.stdout.end(out);
      child.stderr.end(err);
      void Promise.all([finished(child.stdout), finished(child.stderr)]).then(() => child.emit("close", 0, null));
    }, 20);
  });
  return child;
}

describe("run_command output", () => {
  let dir: string | undefined;
  afterEach(async () => {
    fake.child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps output that arrives after the command exits", async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-run-command-output-"));
    fake.child = () => exitsBeforeItsOutput("out-1", "warn-1");
    const result = await executeTool("run_command", { command: "printf out-1" }, dir);
    expect(result).toEqual({ content: "out-1\n[stderr]\nwarn-1", is_error: false });
  });

  it("returns what arrived, without hanging, when a pipe never closes", async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-run-command-output-"));
    fake.child = () => exitsBeforeItsOutput("partial", "", { closeStreams: false });
    const started = Date.now();
    const result = await executeTool("run_command", { command: "printf partial" }, dir);
    expect(result).toEqual({ content: "partial", is_error: false });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
