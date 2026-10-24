/**
 * The sidecar process lifecycle against stand-in `substrate.js` scripts run by
 * this Node: no Substrate install, no network beyond loopback, ephemeral ports
 * only.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeInfo } from "./runtime.js";
import { ensureSidecar, processInfo, serveBinFor, sidecarProcessCheck, SidecarStartError, stopSidecar } from "./sidecar.js";
import { SIDECAR_SPECS, type SidecarSpec } from "./specs.js";

/** A port nothing listens on: bind 0, read it, close. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const HEALTHY_SERVER = `
const http = require("node:http");
console.log("booting on", process.env.HOST, process.env.PORT, "actor", process.env.SUBSTRATE_SYSTEM_ACTOR);
http.createServer((req, res) => { res.writeHead(req.url === "/health" ? 200 : 404); res.end("{}"); })
  .listen(Number(process.env.PORT), process.env.HOST);
process.on("SIGTERM", () => process.exit(0));
`;

const CRASHING_SERVER = `
for (let i = 1; i <= 30; i++) console.error("boot line " + i);
process.exit(3);
`;

describe("ensureSidecar / stopSidecar", () => {
  let root: string;
  let stackDir: string;
  let spec: SidecarSpec;
  const strays: number[] = [];

  /** A stand-in runtime whose substrate.js is `script`, linked from the stack as ensureStackDir does. */
  function runtimeWith(script: string): RuntimeInfo {
    const bin = join(root, "runtime", "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js");
    mkdirSync(join(bin, ".."), { recursive: true });
    // CommonJS, whatever the nearest package.json says.
    writeFileSync(join(bin, "..", "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(bin, script);
    if (!existsSync(join(stackDir, "node_modules"))) symlinkSync(join(root, "runtime", "node_modules"), join(stackDir, "node_modules"));
    return { runtimeDir: join(root, "runtime"), substrateBin: bin, installedMarker: join(root, "runtime", ".installed-x") };
  }

  /** A long-lived process that is not this stack's sidecar. */
  function decoy(script: string, args: string[], cwd: string): number {
    const child = spawn(process.execPath, [script, ...args], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    strays.push(child.pid as number);
    return child.pid as number;
  }

  const SLEEPER = "setTimeout(() => {}, 30000);\n";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "substrate-sidecar-"));
    stackDir = join(root, "stack");
    mkdirSync(stackDir, { recursive: true });
    const cold = SIDECAR_SPECS.find((s) => s.label === "cold") as SidecarSpec;
    spec = { ...cold, port: await freePort(), postgresUrl: "memory" };
  });

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a sidecar, leaves a healthy one alone, and stops it so the pid is gone", async () => {
    const runtime = runtimeWith(HEALTHY_SERVER);
    const first = await ensureSidecar(spec, { node: process.execPath, runtime, stackDir, quiet: true });
    expect(first).toMatchObject({ label: "cold", endpoint: `http://127.0.0.1:${spec.port}`, started: true });
    expect(first.pid).toBeGreaterThan(0);
    strays.push(first.pid as number);
    expect(readFileSync(join(stackDir, "server.pid"), "utf8").trim()).toBe(String(first.pid));
    expect(readFileSync(join(stackDir, "server.log"), "utf8")).toContain(`booting on 127.0.0.1 ${spec.port} actor swarm`);

    const second = await ensureSidecar(spec, { node: process.execPath, runtime, stackDir, quiet: true });
    expect(second).toMatchObject({ started: false, pid: first.pid });

    // It was spawned as `<node> <stack's substrate.js, resolved> serve` from the stack dir.
    const info = processInfo(first.pid as number);
    expect(info.alive).toBe(true);
    expect(info.command).toContain(`${serveBinFor(stackDir)} serve`);
    expect(realpathSync(info.cwd as string)).toBe(realpathSync(stackDir));
    expect(sidecarProcessCheck(info, stackDir)).toEqual({ ours: true, reason: "" });

    const stopped = await stopSidecar(spec, { stackDir });
    expect(stopped).toEqual({ stopped: true, pid: first.pid });
    expect(processInfo(first.pid as number).alive).toBe(false);
    expect(existsSync(join(stackDir, "server.pid"))).toBe(false);
  });

  describe("a stack whose node_modules does not lead to the runtime", () => {
    const failure = async (runtime: RuntimeInfo) =>
      (await ensureSidecar(spec, { node: process.execPath, runtime, stackDir, quiet: true }).catch(
        (e: unknown) => e,
      )) as SidecarStartError;

    it("names a real node_modules directory, which swarm leaves alone, and how to clear it", async () => {
      mkdirSync(join(stackDir, "node_modules"));
      const err = await failure(runtimeWith(HEALTHY_SERVER));
      const link = join(stackDir, "node_modules");
      expect(err).toBeInstanceOf(SidecarStartError);
      expect(err.message).toContain(`${link} is a real directory`);
      expect(err.message).toContain(`rm -rf ${link}`);
      expect(err.message).toContain("swarm substrate start");
      expect(err.message).not.toContain("ensureStackDir");
    });

    it("names a missing node_modules and the command that creates it", async () => {
      const runtime = runtimeWith(HEALTHY_SERVER);
      rmSync(join(stackDir, "node_modules"));
      const err = await failure(runtime);
      expect(err.message).toContain(`${join(stackDir, "node_modules")} is missing`);
      expect(err.message).toContain("swarm substrate start");
    });

    it("names a link to somewhere else and the command that relinks it", async () => {
      mkdirSync(join(root, "elsewhere"));
      symlinkSync(join(root, "elsewhere"), join(stackDir, "node_modules"));
      const err = await failure(runtimeWith(HEALTHY_SERVER));
      expect(err.message).toContain(`links to ${join(root, "elsewhere")}`);
      expect(err.message).toContain("swarm substrate start");
    });
  });

  it("fails with the last 20 lines of server.log when the child exits during boot", async () => {
    const runtime = runtimeWith(CRASHING_SERVER);
    const err = (await ensureSidecar(spec, { node: process.execPath, runtime, stackDir, quiet: true }).catch(
      (e: unknown) => e,
    )) as SidecarStartError;
    expect(err).toBeInstanceOf(SidecarStartError);
    expect(err.message).toMatch(/exited during startup \(code 3\)/);
    expect(err.message).toContain("boot line 30");
    expect(err.message).toContain("boot line 11");
    expect(err.message).not.toMatch(/boot line 10\b/);
    expect(err.logFile).toBe(join(stackDir, "server.log"));
    expect(existsSync(join(stackDir, "server.pid"))).toBe(false);
  });

  it("never signals a pid whose command line is not a Substrate serve", async () => {
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
    other.unref();
    strays.push(other.pid as number);
    writeFileSync(join(stackDir, "server.pid"), `${other.pid}\n`);

    const result = await stopSidecar(spec, { stackDir });

    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/not this stack's Substrate sidecar/);
    expect(processInfo(other.pid as number).alive).toBe(true);
    expect(existsSync(join(stackDir, "server.pid"))).toBe(false);
  });

  it("never signals another script whose argv contains 'substrate.js serve'", async () => {
    runtimeWith(HEALTHY_SERVER);
    // Another project's Substrate: a different substrate.js, run with `serve`.
    const other = join(root, "other-project", "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, SLEEPER);
    const pid = decoy(other, ["serve"], join(root, "other-project"));
    writeFileSync(join(stackDir, "server.pid"), `${pid}\n`);

    const result = await stopSidecar(spec, { stackDir });

    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/not this stack's Substrate sidecar.*command line.*nothing was signalled/s);
    expect(processInfo(pid).alive).toBe(true);
    expect(existsSync(join(stackDir, "server.pid"))).toBe(false);
  });

  it("never signals the sibling sidecar: the same substrate.js serve from another stack directory", async () => {
    runtimeWith(SLEEPER);
    const sibling = join(root, "meta-stack");
    mkdirSync(sibling, { recursive: true });
    const pid = decoy(serveBinFor(stackDir), ["serve"], sibling);
    writeFileSync(join(stackDir, "server.pid"), `${pid}\n`);

    const result = await stopSidecar(spec, { stackDir });

    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/working directory/);
    expect(processInfo(pid).alive).toBe(true);
  });

  it("does not wait on a decoy pid in server.pid; it starts its own sidecar", async () => {
    const runtime = runtimeWith(HEALTHY_SERVER);
    const other = join(root, "elsewhere", "substrate.js");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, SLEEPER);
    const pid = decoy(other, ["serve"], join(root, "elsewhere"));
    writeFileSync(join(stackDir, "server.pid"), `${pid}\n`);

    const started = Date.now();
    const status = await ensureSidecar(spec, { node: process.execPath, runtime, stackDir, quiet: true });
    strays.push(status.pid as number);

    expect(status.started).toBe(true);
    expect(status.pid).not.toBe(pid);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(processInfo(pid).alive).toBe(true);
    expect((await stopSidecar(spec, { stackDir })).stopped).toBe(true);
  });

  it("reports a missing pid file without touching anything", async () => {
    expect(await stopSidecar(spec, { stackDir })).toEqual({ stopped: false, pid: null, reason: "no server.pid" });
  });
});
