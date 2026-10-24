/**
 * Shared fixture for tests of the Substrate stack a project resolves to: a temp
 * `.swarm/` with one domain (project-a), a temp HOME (the saved substrate_url
 * lives in ~/.swarm/config.json, and the real one must not leak in), and every
 * SWARM_SUBSTRATE_* / SWARM_META_* variable cleared before and restored after
 * each test.
 *
 * Every port is made up, and stopping a sidecar goes through fakeMachine:
 * nothing here reaches a real sidecar or signals a real process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { SidecarSpec } from "@mnmal-ai/swarm-substrate";
import type { StopDeps } from "../src/cli/substrate.js";
import { readProjectSubstrateConfig } from "../src/project-substrate.js";

/** A dedicated stack on made-up ports. */
export const STACK = {
  port: 45002,
  postgres_url: "postgresql://swarm:swarm@127.0.0.1:45001/swarm",
  meta_port: 45005,
  meta_postgres_url: "postgresql://swarm:swarm@127.0.0.1:45004/swarm_meta",
};

const KEYS = [
  "HOME",
  "SWARM_SUBSTRATE_PORT",
  "SWARM_SUBSTRATE_ENDPOINT",
  "SWARM_SUBSTRATE_POSTGRES_URL",
  "SWARM_META_PORT",
  "SWARM_META_ENDPOINT",
  "SWARM_META_POSTGRES_URL",
  "SWARM_SUBSTRATE_LOCAL_ONLY",
  "SWARM_SUBSTRATE_DEDICATED",
  "SWARM_EMBEDDER_KIND",
  "SWARM_EMBEDDER_OLLAMA_URL",
];

let root = "";
let swarm = "";
let home = "";

/** Register the per-test isolation hooks. Call once at the top of a test file. */
export function isolateSubstrateProject(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "substrate-project-"));
    swarm = join(root, "project", ".swarm");
    home = join(root, "home");
    mkdirSync(join(swarm, "domains", "project-a"), { recursive: true });
    mkdirSync(home);
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });
}

/** The current test's `.swarm/` directory. */
export const swarmDir = (): string => swarm;

/** The current test's HOME. */
export const homeDir = (): string => home;

/** Write project-a's `substrate` block (when given) and read the project's config back. */
export function projectConfig(substrate?: Record<string, unknown>) {
  if (substrate !== undefined) {
    writeFileSync(join(swarm, "domains", "project-a", "config.json"), JSON.stringify({ substrate }));
  }
  return readProjectSubstrateConfig(swarm, "project-a");
}
export const dedicatedProject = (extra: Record<string, unknown> = {}) => projectConfig({ ...STACK, ...extra });
export const sharedProject = () => projectConfig();

/** Write the user-wide ~/.swarm/config.json of the current test's HOME. */
export function saveGlobalConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, ".swarm"), { recursive: true });
  writeFileSync(join(home, ".swarm", "config.json"), JSON.stringify(cfg));
}

/**
 * A pretend machine: which sidecar pid each port's stack directory names, and
 * what stop did. Stopping goes through the spec, as `stopSidecar` does: a port
 * with a running sidecar is stopped, any other reports no server.pid.
 */
export function fakeMachine(running: Record<number, number>) {
  const killed: number[] = [];
  const asked: number[] = [];
  const stacks: Array<string | undefined> = [];
  const lines: string[] = [];
  const deps: StopDeps = {
    stop: async (spec: SidecarSpec) => {
      asked.push(spec.port);
      stacks.push(spec.stack);
      const pid = running[spec.port];
      if (pid === undefined) return { stopped: false, pid: null, reason: "no server.pid" };
      killed.push(pid);
      return { stopped: true, pid };
    },
    log: (line) => {
      lines.push(line);
    },
  };
  return { deps, killed, asked, stacks, output: () => lines.join("\n") };
}
