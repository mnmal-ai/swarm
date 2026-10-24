/**
 * The CLI's way into the Substrate lifecycle: the options every bring-up
 * passes (`substrateReadyOptions`), and the runtime-reinstall guard that stops
 * every stack on the machine before the shared runtime's node_modules is
 * replaced (`stopAllStacks`).
 *
 * Stacks live in a temp directory and stopping goes through a recorder:
 * nothing here signals a real process or reads the real ~/.swarm.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORTEXT_VERSION,
  ensureRuntimeInstalled,
  type SidecarSpec,
  type StopSidecarOptions,
  SUBSTRATE_VERSION,
} from "@mnmal-ai/swarm-substrate";
import { resolvePluginTarball } from "../src/substrate/plugin-asset.js";
import { RuntimeReinstallBlockedError, stopAllStacks, substrateReadyOptions } from "../src/substrate/ready.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "substrate-stacks-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function stack(name: string, pid?: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (pid !== undefined) writeFileSync(join(dir, "server.pid"), `${pid}\n`);
  return dir;
}

function recorder() {
  const stopped: Array<{ label: string; stackDir: string | undefined }> = [];
  const stop = vi.fn(async (spec: SidecarSpec, opts: StopSidecarOptions = {}) => {
    stopped.push({ label: spec.label, stackDir: opts.stackDir });
    return { stopped: true, pid: 1 };
  });
  return { stop, stopped };
}

describe("stopAllStacks", () => {
  it("stops the sidecar of every stack with a server.pid — the shared pair and every project's dedicated pair", async () => {
    stack("cold", 101);
    stack("meta"); // not running: no pid file
    stack("project-a-cold", 201);
    stack("project-a-meta", 202);
    stack("swarm-dedicated-45002-cold", 301);
    writeFileSync(join(root, "stray-file"), "");
    const r = recorder();

    const results = await stopAllStacks({ root, stop: r.stop, log: () => {} });

    expect(results).toHaveLength(4);
    expect(r.stopped.sort((a, b) => String(a.stackDir).localeCompare(String(b.stackDir)))).toEqual([
      { label: "cold", stackDir: join(root, "cold") },
      { label: "cold", stackDir: join(root, "project-a-cold") },
      { label: "meta", stackDir: join(root, "project-a-meta") },
      { label: "cold", stackDir: join(root, "swarm-dedicated-45002-cold") },
    ]);
  });

  it("does nothing, without throwing, when there are no stacks yet", async () => {
    const r = recorder();
    await expect(stopAllStacks({ root: join(root, "missing"), stop: r.stop, log: () => {} })).resolves.toEqual([]);
    expect(r.stop).not.toHaveBeenCalled();
  });

  it("tries every stack, then refuses the reinstall when a stop threw, naming the stack", async () => {
    stack("cold", 101);
    stack("project-a-cold", 201);
    const lines: string[] = [];
    const stop = vi.fn(async (_spec: SidecarSpec, opts: StopSidecarOptions = {}) => {
      if (opts.stackDir?.endsWith("/cold")) throw new Error("EPERM");
      return { stopped: true, pid: 201 };
    });
    const err = await stopAllStacks({ root, stop, log: (l) => lines.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeReinstallBlockedError);
    expect((err as RuntimeReinstallBlockedError).blocked).toEqual([{ stack: "cold", reason: "stopping it failed (EPERM)" }]);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toMatch(/could not stop the cold sidecar.*EPERM/i);
    expect(lines.join("\n")).toMatch(/project-a-cold.*pid 201/);
  });

  it("refuses the reinstall when stopSidecar reports a live pid it did not stop", async () => {
    stack("project-a-cold", 4242);
    const reason = "pid 4242 is not this stack's Substrate sidecar: its working directory is unreadable";
    const stop = vi.fn(async () => ({ stopped: false, pid: 4242, reason }));
    const lines: string[] = [];
    const err = await stopAllStacks({ root, stop, isAlive: (pid) => pid === 4242, log: (l) => lines.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeReinstallBlockedError);
    expect((err as Error).message).toContain("project-a-cold");
    expect((err as Error).message).toContain(reason);
    expect(lines.join("\n")).toContain(reason);
  });

  it("lets the reinstall go on when a pid it did not stop is gone, or nothing was running", async () => {
    stack("cold", 101);
    stack("meta", 102);
    const stop = vi.fn(async (spec: SidecarSpec) =>
      spec.label === "cold"
        ? { stopped: false, pid: 101, reason: "pid 101 is not this stack's Substrate sidecar: its command line is not ours" }
        : { stopped: false, pid: 102, reason: "not running" },
    );
    await expect(stopAllStacks({ root, stop, isAlive: () => false, log: () => {} })).resolves.toHaveLength(2);
  });

  it("refuses the reinstall when the stacks directory cannot be read", async () => {
    const notADir = join(root, "stacks-file");
    writeFileSync(notADir, "");
    const r = recorder();
    await expect(stopAllStacks({ root: notADir, stop: r.stop, log: () => {} })).rejects.toThrow(RuntimeReinstallBlockedError);
    expect(r.stop).not.toHaveBeenCalled();
  });

  it("keeps the runtime's node_modules when the guard refuses: the install stops before removing anything", async () => {
    stack("project-a-cold", 4242);
    const runtimeDir = join(root, "runtime");
    mkdirSync(join(runtimeDir, "node_modules"), { recursive: true });
    writeFileSync(join(runtimeDir, "node_modules", "sentinel"), "live sidecar code");
    writeFileSync(join(runtimeDir, ".installed-oldhash"), "{}");
    const { path: pluginTarball } = await resolvePluginTarball();
    const stop = vi.fn(async () => ({ stopped: false, pid: 4242, reason: "its working directory is unreadable" }));

    await expect(
      ensureRuntimeInstalled({
        runtimeDir,
        pluginTarball,
        substrateVersion: SUBSTRATE_VERSION,
        cortextVersion: CORTEXT_VERSION,
        quiet: true,
        nodePath: process.execPath,
        beforeReinstall: () => stopAllStacks({ root, stop, isAlive: () => true, log: () => {} }).then(() => {}),
      }),
    ).rejects.toThrow(RuntimeReinstallBlockedError);

    expect(stop).toHaveBeenCalledOnce();
    expect(readFileSync(join(runtimeDir, "node_modules", "sentinel"), "utf8")).toBe("live sidecar code");
    expect(existsSync(join(runtimeDir, ".installed-oldhash"))).toBe(true);
    expect(existsSync(join(runtimeDir, "package.json"))).toBe(false);
  });
});

describe("substrateReadyOptions", () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });

  it("passes the plugin tarball, the embedder from SWARM_EMBEDDER_*, and the all-stacks reinstall guard", async () => {
    const stopAll = vi.fn(async () => []);
    const opts = await substrateReadyOptions(
      { quiet: true, dockerComposeDir: "/infra" },
      {
        resolvePluginTarball: async () => ({ path: "/abs/swarm-substrate-plugin.tgz", version: "0.8.0" }),
        env: env({ SWARM_EMBEDDER_MODEL: "bge-m3", SWARM_EMBEDDER_TIMEOUT_MS: "20000", SWARM_EMBED_ON_WRITE: "1" }),
        stopAllStacks: stopAll,
      },
    );
    expect(opts).toMatchObject({
      quiet: true,
      dockerComposeDir: "/infra",
      pluginTarball: "/abs/swarm-substrate-plugin.tgz",
      embedder: { kind: "ollama", model: "bge-m3", dimension: 1024, timeoutMs: 20000, embedOnWrite: true },
    });
    expect(stopAll).not.toHaveBeenCalled();
    await opts.beforeReinstall?.();
    expect(stopAll).toHaveBeenCalledOnce();
  });

  it("passes no tarball, and says why, when the CLI cannot find its own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = await substrateReadyOptions(
        { quiet: false },
        {
          resolvePluginTarball: async () => {
            throw new Error("swarm-substrate-plugin.tgz not found");
          },
          env: env(),
          stopAllStacks: async () => [],
        },
      );
      expect(opts.pluginTarball).toBeUndefined();
      expect(warn.mock.calls.flat().join("\n")).toMatch(/swarm-substrate-plugin\.tgz not found/);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a malformed embedder setting before anything starts", async () => {
    await expect(
      substrateReadyOptions(
        { quiet: true },
        {
          resolvePluginTarball: async () => ({ path: "/abs/p.tgz", version: "0.8.0" }),
          env: env({ SWARM_EMBEDDER_KIND: "openai" }),
          stopAllStacks: async () => [],
        },
      ),
    ).rejects.toThrow(/SWARM_EMBEDDER_KIND/);
  });
});
