/**
 * swarm doctor — pure diagnostics for the Substrate stack.
 *
 * This module DIAGNOSES; it never repairs. It deliberately does NOT call
 * `ensureSubstrateReady` (or any of its Postgres, runtime or sidecar
 * machinery): the whole point of `swarm doctor` is to report on a sick stack,
 * so it must run cleanly with zero sidecars up and bring nothing online as a
 * side effect. Every probe fails soft — a connect refusal, a timeout or a
 * thrown error produces a `down`/`unknown` row, never an exception — so
 * `collectDoctorRows()` always returns a full table even when everything is down.
 *
 * Rows, in order: the Node the sidecars run on (floor 26.2.0), the Substrate
 * runtime, `lsof` (macOS only: stopping a sidecar verifies its working
 * directory with it), then for each store (cold, meta) its Postgres and its
 * sidecar, then the dashboard. The topology comes from the lifecycle's own
 * `resolveSidecarSpecs()` and endpoint resolvers, read at call time, so a
 * dedicated project's stack (applied to the environment by the CLI preamble)
 * is what gets probed.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  defaultRuntimeDir,
  findInstalledRuntime,
  isMemoryStore,
  NODE_VERSION_FLOOR,
  NodeVersionError,
  probeNamespaceSchema,
  type ResolvedNode,
  resolveMetaEndpoint,
  resolveNode,
  resolveSidecarSpecs,
  resolveSubstrateEndpoint,
  type RuntimeInfo,
  type SidecarSpec,
  SubstrateClient,
} from "@mnmal-ai/swarm-substrate";
import postgres from "postgres";

// --- Public types ---

/** Health of a single piece of infra. */
export type DoctorState = "ok" | "down" | "wrong-namespace" | "unknown";

/**
 * One row of the consolidated `swarm doctor` table: a named component, its current
 * state, a human-readable detail line, and — when unhealthy — a concrete command
 * the operator can run to fix it. `fixCommand` is omitted on healthy rows.
 */
export interface DoctorRow {
  component: string;
  state: DoctorState;
  detail: string;
  fixCommand?: string;
}

/** A diagnosable sidecar and its companion Postgres, derived from one `SidecarSpec`. */
export interface DoctorTarget {
  /** The underlying sidecar spec (port + namespace + stack). */
  spec: SidecarSpec;
  /** Short human label for this store: "cold" / "meta". */
  label: string;
  /** Display name for the Postgres component row. */
  pgComponent: string;
  /** Display name for the sidecar component row. */
  sidecarComponent: string;
  /** Where the run would reach the sidecar (the lifecycle's endpoint resolution). */
  endpoint: string;
  /** Postgres URL probed for reachability (the spec's, with the environment applied). */
  pgUrl: string;
  /** Fix command surfaced when this store's Postgres is unreachable. */
  pgFixCommand: string;
  /** Fix command surfaced when this store's sidecar is down or serving the wrong namespace. */
  sidecarFixCommand: string;
}

/** What the probes need from the machine; tests inject every one. */
export interface DoctorDeps {
  resolveNode(): Promise<ResolvedNode>;
  findRuntime(): RuntimeInfo | null;
  runtimeDir(): string;
  platform: NodeJS.Platform;
  /** The lsof binary, or null when there is none. */
  findLsof(): string | null;
  probePostgres(url: string): Promise<boolean>;
  isHealthy(endpoint: string): Promise<boolean>;
  servesNamespace(endpoint: string, namespace: string): Promise<boolean>;
  probeHttp(url: string): Promise<boolean>;
}

const START = "swarm substrate start";
const NODE_FIX = `install Node ${NODE_VERSION_FLOOR} or newer, e.g. \`mise use -g node@26\` or with your package manager (or set SWARM_NODE to one)`;

/** Default dashboard port (matches DashboardServer's default and `swarm run --dashboard-port`). */
const DEFAULT_DASHBOARD_PORT = 3141;

// --- Targets ---

/**
 * The doctor targets, one per sidecar spec, with the environment applied: the
 * ports, Postgres URLs and endpoints the run itself would use. Reads env at
 * call time — do not cache the result.
 */
export function getDoctorTargets(): readonly DoctorTarget[] {
  const specs = resolveSidecarSpecs();
  return specs.map((spec) => ({
    spec,
    label: spec.label,
    pgComponent: `${spec.label} Postgres`,
    sidecarComponent: `${spec.label} sidecar`,
    endpoint: spec.label === "cold" ? resolveSubstrateEndpoint() : resolveMetaEndpoint(),
    pgUrl: spec.postgresUrl,
    pgFixCommand: START,
    sidecarFixCommand: START,
  }));
}

// --- Low-level probes (all fail-soft) ---

/**
 * Whether a Postgres is actually answering at `url`: one trivial query on a
 * short-timeout, single-connection handle that is always `end()`-ed. Stronger
 * than a bare TCP touch. False on any connect/query error — never throws.
 */
async function probePgReachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.end({ timeout: 5 });
    } catch {
      // never connected — nothing to drain.
    }
  }
}

/** Whether anything answers HTTP at `url` (any status counts). */
async function probeHttpReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** lsof on PATH, else /usr/sbin/lsof (where macOS ships it), else null. */
function findLsofBinary(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && isExecutable(join(dir, "lsof"))) return join(dir, "lsof");
  }
  return isExecutable("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null;
}

const machineDeps = (): DoctorDeps => ({
  resolveNode,
  findRuntime: () => findInstalledRuntime(defaultRuntimeDir()),
  runtimeDir: defaultRuntimeDir,
  platform: process.platform,
  findLsof: findLsofBinary,
  probePostgres: probePgReachable,
  isHealthy: (endpoint) => new SubstrateClient(endpoint).isHealthy(),
  servesNamespace: probeNamespaceSchema,
  probeHttp: probeHttpReachable,
});

// --- Row builders ---

/** The message without its "Fix: …" tail (the row carries the fix itself). */
function withoutFix(message: string): string {
  const i = message.indexOf(" Fix:");
  return (i === -1 ? message : message.slice(0, i)).trim();
}

async function nodeRow(deps: DoctorDeps): Promise<DoctorRow> {
  try {
    const node = await deps.resolveNode();
    return { component: "Node", state: "ok", detail: `${node.version} at ${node.path} (sidecars need ${NODE_VERSION_FLOOR}+)` };
  } catch (err) {
    if (err instanceof NodeVersionError) {
      let detail: string;
      if (err.found !== null) {
        detail = `Node ${err.found} at ${err.nodePath} is older than ${NODE_VERSION_FLOOR}, which the Substrate sidecars need`;
      } else {
        // No Node, one that would not run, or no version from it: resolveNode's own words.
        detail = withoutFix(err.message);
        if (!detail.includes(NODE_VERSION_FLOOR)) detail += ` (the Substrate sidecars need Node ${NODE_VERSION_FLOOR} or newer)`;
      }
      return { component: "Node", state: "down", detail, fixCommand: NODE_FIX };
    }
    return {
      component: "Node",
      state: "unknown",
      detail: `could not check (${err instanceof Error ? err.message : String(err)}); the sidecars need ${NODE_VERSION_FLOOR}+`,
      fixCommand: NODE_FIX,
    };
  }
}

function runtimeRow(deps: DoctorDeps): DoctorRow {
  try {
    const runtime = deps.findRuntime();
    if (runtime !== null) return { component: "Substrate runtime", state: "ok", detail: `installed in ${runtime.runtimeDir}` };
    return {
      component: "Substrate runtime",
      state: "down",
      detail: `not installed in ${deps.runtimeDir()}`,
      fixCommand: START,
    };
  } catch (err) {
    return {
      component: "Substrate runtime",
      state: "unknown",
      detail: `could not check (${err instanceof Error ? err.message : String(err)})`,
      fixCommand: START,
    };
  }
}

/** macOS only: stopping a sidecar reads its working directory with lsof. */
function lsofRow(deps: DoctorDeps): DoctorRow | null {
  if (deps.platform !== "darwin") return null;
  const lsof = deps.findLsof();
  if (lsof !== null) return { component: "lsof", state: "ok", detail: `${lsof} (checks a sidecar's pid before stopping it)` };
  return {
    component: "lsof",
    state: "down",
    detail: "not found: swarm cannot verify a sidecar's pid, so it will not stop one",
    fixCommand: "restore /usr/sbin/lsof (it ships with macOS) or put an lsof on PATH",
  };
}

/** One row for a store's Postgres; the in-memory store has none to dial. */
async function pgRow(target: DoctorTarget, deps: DoctorDeps): Promise<DoctorRow> {
  if (isMemoryStore(target.pgUrl)) {
    return { component: target.pgComponent, state: "ok", detail: "none — the sidecar runs on the in-memory store" };
  }
  const where = pgHostPort(target.pgUrl);
  try {
    if (await deps.probePostgres(target.pgUrl)) {
      return { component: target.pgComponent, state: "ok", detail: `reachable at ${where}` };
    }
    return {
      component: target.pgComponent,
      state: "down",
      detail: `not accepting connections at ${where}`,
      fixCommand: target.pgFixCommand,
    };
  } catch {
    return { component: target.pgComponent, state: "unknown", detail: `probe failed for ${where}`, fixCommand: target.pgFixCommand };
  }
}

/**
 * One row for a store's sidecar. `/health` is namespace-blind, so a healthy
 * endpoint that does NOT publish this target's namespace reports
 * `wrong-namespace`, not `ok` (a meta sidecar answering on the cold port, or
 * another Substrate on the port).
 */
async function sidecarRow(target: DoctorTarget, deps: DoctorDeps): Promise<DoctorRow> {
  const { endpoint } = target;
  try {
    if (!(await deps.isHealthy(endpoint))) {
      return {
        component: target.sidecarComponent,
        state: "down",
        detail: `not responding at ${endpoint}`,
        fixCommand: target.sidecarFixCommand,
      };
    }
    if (await deps.servesNamespace(endpoint, target.spec.namespace)) {
      return { component: target.sidecarComponent, state: "ok", detail: `serving '${target.spec.namespace}' at ${endpoint}` };
    }
    return {
      component: target.sidecarComponent,
      state: "wrong-namespace",
      detail: `healthy at ${endpoint} but does not serve the '${target.spec.namespace}' namespace`,
      fixCommand: target.sidecarFixCommand,
    };
  } catch {
    return { component: target.sidecarComponent, state: "down", detail: `probe failed for ${endpoint}`, fixCommand: target.sidecarFixCommand };
  }
}

/** One row for the dashboard HTTP server. */
async function dashboardRow(deps: DoctorDeps): Promise<DoctorRow> {
  const url = `http://localhost:${DEFAULT_DASHBOARD_PORT}/`;
  let reachable = false;
  try {
    reachable = await deps.probeHttp(url);
  } catch {
    reachable = false;
  }
  if (reachable) return { component: "dashboard", state: "ok", detail: `reachable at ${url}` };
  return { component: "dashboard", state: "down", detail: `nothing listening at ${url}`, fixCommand: "swarm dashboard preview" };
}

// --- Public entry point ---

/**
 * Collect one diagnostic row for every piece of the stack, in display order
 * (see the module doc). Brings nothing up and never throws — safe to call with
 * the entire stack down.
 */
export async function collectDoctorRows(overrides: Partial<DoctorDeps> = {}): Promise<DoctorRow[]> {
  const deps: DoctorDeps = { ...machineDeps(), ...overrides };
  const rows: DoctorRow[] = [await nodeRow(deps), runtimeRow(deps)];
  const lsof = lsofRow(deps);
  if (lsof !== null) rows.push(lsof);
  let targets: readonly DoctorTarget[] = [];
  try {
    targets = getDoctorTargets();
  } catch (err) {
    rows.push({
      component: "Substrate stack",
      state: "unknown",
      detail: `could not resolve the stack: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  for (const target of targets) {
    rows.push(await pgRow(target, deps));
    rows.push(await sidecarRow(target, deps));
  }
  rows.push(await dashboardRow(deps));
  return rows;
}

// --- helpers ---

/** Best-effort "host:port" extraction from a Postgres URL for the detail line. */
function pgHostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname || "localhost"}:${u.port || "5432"}`;
  } catch {
    return url;
  }
}
