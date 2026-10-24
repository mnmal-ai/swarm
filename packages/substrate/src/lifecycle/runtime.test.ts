import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every subprocess this module runs goes through `execFile`: `node --version`,
 * `tar` (the plugin version inside the tarball) and `npm install`. The mock
 * dispatches on the command so no real Node, tar or npm runs here.
 */
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
interface ExecCall {
  cmd: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
  /** Snapshots taken while the call runs: the user and global config npm was handed. */
  userconfigContent?: string | null;
  globalconfigContent?: string | null;
  runtimeNpmrcExists?: boolean;
}

const state = vi.hoisted(() => ({
  nodeVersion: "v26.10.0\n",
  pluginVersion: "0.8.0",
  npmFailures: 0,
  calls: [] as Array<{
    cmd: string;
    args: readonly string[];
    options: { cwd?: string; env?: NodeJS.ProcessEnv };
    userconfigContent?: string | null;
    globalconfigContent?: string | null;
    runtimeNpmrcExists?: boolean;
  }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const execFile = (
    cmd: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
    callback: ExecCallback,
  ) => {
    const call: ExecCall = { cmd, args, options };
    state.calls.push(call);
    queueMicrotask(() => {
      if (args[0] === "--version") return callback(null, state.nodeVersion, "");
      if (cmd === "tar") return callback(null, JSON.stringify({ name: "@mnmal-ai/swarm-substrate-plugin", version: state.pluginVersion }), "");
      if (path.basename(cmd) === "npm") {
        const userconfig = options.env?.npm_config_userconfig;
        call.userconfigContent = userconfig && fs.existsSync(userconfig) ? fs.readFileSync(userconfig, "utf8") : null;
        const globalconfig = options.env?.npm_config_globalconfig;
        call.globalconfigContent = globalconfig && fs.existsSync(globalconfig) ? fs.readFileSync(globalconfig, "utf8") : null;
        call.runtimeNpmrcExists = fs.existsSync(path.join(options.cwd ?? "", ".npmrc"));
        if (state.npmFailures > 0) {
          state.npmFailures -= 1;
          const err = Object.assign(new Error("Command failed: npm install"), { code: 1 });
          return callback(err, "", "npm error 404 Not Found - GET https://registry.npmjs.org/@mnmal-ai%2fcortext");
        }
        const bin = path.join(options.cwd ?? "", "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js");
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, "// substrate\n");
        return callback(null, "", "");
      }
      return callback(new Error(`unexpected command ${cmd}`), "", "");
    });
    return {} as ReturnType<typeof original.execFile>;
  };
  return { ...original, execFile };
});

const { ensureRuntimeInstalled, NodeVersionError, NODE_VERSION_FLOOR, resolveNode } = await import("./runtime.js");

describe("runtime", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = ["HOME", "SWARM_NODE"] as const;
  let root: string;
  let nodePath: string;
  let tarball: string;

  beforeEach(() => {
    for (const k of KEYS) savedEnv[k] = process.env[k];
    root = mkdtempSync(join(tmpdir(), "substrate-runtime-"));
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
    // A fake Node install: bin/node plus the npm that ships beside it.
    nodePath = join(root, "node-install", "bin", "node");
    mkdirSync(dirname(nodePath), { recursive: true });
    for (const bin of ["node", "npm"]) {
      writeFileSync(join(dirname(nodePath), bin), "#!/bin/sh\n");
      chmodSync(join(dirname(nodePath), bin), 0o755);
    }
    process.env.SWARM_NODE = nodePath;
    tarball = join(root, "swarm-substrate-plugin.tgz");
    writeFileSync(tarball, Buffer.alloc(1234, 1));
    state.nodeVersion = "v26.10.0\n";
    state.pluginVersion = "0.8.0";
    state.npmFailures = 0;
    state.calls.length = 0;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  function options(runtimeDir = join(root, "home", ".swarm", "substrate", "runtime")) {
    return {
      runtimeDir,
      pluginTarball: tarball,
      substrateVersion: "1.0.0-alpha.7",
      cortextVersion: "1.0.0-alpha.7",
      quiet: true,
    };
  }

  const npmCalls = () => state.calls.filter((c) => c.cmd.endsWith("/npm"));
  const markers = (dir: string) => readdirSync(dir).filter((f) => f.startsWith(".installed-"));

  describe("resolveNode", () => {
    it("resolveNode rejects node older than 26.2.0 with the floor in the message", async () => {
      state.nodeVersion = "v24.0.0\n";
      const err = await resolveNode().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeVersionError);
      const message = (err as Error).message;
      expect(message).toContain("24.0.0");
      expect(message).toContain(NODE_VERSION_FLOOR);
      expect(NODE_VERSION_FLOOR).toBe("26.2.0");
      expect(message).toMatch(/install Node 26\.2 or newer, e\.g\. with mise or your package manager/);
    });

    it("accepts the floor and newer, preferring SWARM_NODE", async () => {
      state.nodeVersion = "v26.2.0\n";
      expect(await resolveNode()).toEqual({ path: nodePath, version: "26.2.0" });
      state.nodeVersion = "v27.1.3\n";
      expect(await resolveNode()).toEqual({ path: nodePath, version: "27.1.3" });
      expect(state.calls.every((c) => c.cmd === nodePath)).toBe(true);
    });

    it("refuses a relative SWARM_NODE", async () => {
      process.env.SWARM_NODE = "bin/node";
      await expect(resolveNode()).rejects.toThrow(/SWARM_NODE.*absolute/);
    });
  });

  describe("ensureRuntimeInstalled", () => {
    it("writes the runtime package.json and installs with the npm beside the resolved node, isolated from any user .npmrc", async () => {
      const opts = options();
      mkdirSync(opts.runtimeDir, { recursive: true });
      writeFileSync(join(opts.runtimeDir, ".npmrc"), "@mnmal-ai:registry=https://npm.pkg.github.com\n");

      const info = await ensureRuntimeInstalled(opts);

      expect(JSON.parse(readFileSync(join(opts.runtimeDir, "package.json"), "utf8"))).toEqual({
        private: true,
        dependencies: {
          "@mnmal-ai/substrate": "1.0.0-alpha.7",
          "@mnmal-ai/cortext": "1.0.0-alpha.7",
          "@mnmal-ai/swarm-substrate-plugin": `file:${tarball}`,
        },
      });
      const [npm] = npmCalls();
      expect(npm.cmd).toBe(join(dirname(nodePath), "npm"));
      expect(npm.args).toEqual(["install", "--no-audit", "--no-fund", "--loglevel=error"]);
      expect(npm.options.cwd).toBe(opts.runtimeDir);
      expect(npm.options.env?.npm_config_registry).toBe("https://registry.npmjs.org/");
      expect(npm.userconfigContent).toBe("");
      // The global npmrc is empty too, so no machine-wide scope rule applies; a
      // separate file, because npm refuses one file as both user and global config.
      expect(npm.globalconfigContent).toBe("");
      expect(npm.options.env?.npm_config_globalconfig).not.toBe(npm.options.env?.npm_config_userconfig);
      expect(dirname(npm.options.env?.npm_config_globalconfig as string)).toBe(
        dirname(npm.options.env?.npm_config_userconfig as string),
      );
      expect(npm.runtimeNpmrcExists).toBe(false);
      expect(npm.options.env?.PATH?.split(":")[0]).toBe(dirname(nodePath));
      expect(info).toEqual({
        runtimeDir: opts.runtimeDir,
        substrateBin: join(opts.runtimeDir, "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js"),
        installedMarker: expect.stringMatching(/\/\.installed-[0-9a-f]+$/),
      });
      expect(existsSync(info.installedMarker)).toBe(true);
    });

    it("ensureRuntimeInstalled is a no-op when the marker for this hash exists", async () => {
      const opts = options();
      const first = await ensureRuntimeInstalled(opts);
      expect(npmCalls()).toHaveLength(1);

      const second = await ensureRuntimeInstalled(opts);
      expect(npmCalls()).toHaveLength(1); // npm not invoked again
      expect(second).toEqual(first);

      // A different tarball is another hash even at the same size (the bytes
      // are hashed): it installs again, and only the new marker is left.
      writeFileSync(tarball, Buffer.alloc(1234, 2));
      const third = await ensureRuntimeInstalled(opts);
      expect(npmCalls()).toHaveLength(2);
      expect(third.installedMarker).not.toBe(first.installedMarker);
      expect(markers(opts.runtimeDir)).toEqual([third.installedMarker.split("/").pop()]);
    });

    it("calls beforeReinstall only when a changed install is about to replace an existing node_modules", async () => {
      const opts = options();
      const order: string[] = [];
      const beforeReinstall = vi.fn(() => {
        order.push(`hook (npm calls so far: ${npmCalls().length}, node_modules there: ${existsSync(join(opts.runtimeDir, "node_modules"))})`);
      });

      await ensureRuntimeInstalled({ ...opts, beforeReinstall }); // first install: nothing to stop
      await ensureRuntimeInstalled({ ...opts, beforeReinstall }); // marker no-op
      expect(beforeReinstall).not.toHaveBeenCalled();

      writeFileSync(tarball, Buffer.alloc(1234, 3));
      await ensureRuntimeInstalled({ ...opts, beforeReinstall });
      expect(beforeReinstall).toHaveBeenCalledOnce();
      // It ran before the second npm install, while the old node_modules still existed.
      expect(order).toEqual(["hook (npm calls so far: 1, node_modules there: true)"]);
      expect(npmCalls()).toHaveLength(2);
    });

    it("a failed npm install leaves no marker and the next call retries", async () => {
      const opts = options();
      state.npmFailures = 1;

      const err = await ensureRuntimeInstalled(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(opts.runtimeDir);
      expect((err as Error).message).toMatch(/404 Not Found/);
      expect(markers(opts.runtimeDir)).toEqual([]);

      const info = await ensureRuntimeInstalled(opts);
      expect(npmCalls()).toHaveLength(2);
      expect(markers(opts.runtimeDir)).toEqual([info.installedMarker.split("/").pop()]);
    });

    it("refuses a missing plugin tarball before running npm", async () => {
      const opts = { ...options(), pluginTarball: join(root, "missing.tgz") };
      await expect(ensureRuntimeInstalled(opts)).rejects.toThrow(/missing\.tgz/);
      expect(npmCalls()).toHaveLength(0);
    });
  });
});
