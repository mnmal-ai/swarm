/**
 * swarm substrate — Manage the Substrate sidecars and their Postgres.
 *
 * Subcommands:
 *   swarm substrate start     Bring up Postgres, the runtime and both sidecars
 *   swarm substrate stop      Stop this project's sidecars (cold + meta)
 *   swarm substrate status    One line per sidecar and per Postgres
 *
 * Every subcommand acts on the stack the project it is run from uses (see
 * resolveSubstrateStack): its dedicated stack when its config declares one,
 * otherwise the shared default stack.
 */

import {
  assertLocalOnly,
  isLocalOnlyEnv,
  isManagedEndpoint,
  isMemoryStore,
  probePostgresReachable,
  resolveLocalOnlyTargets,
  resolveSidecarSpecs,
  type SidecarSpec,
  specFor,
  stackDirFor,
  stopSidecar,
  type StopSidecarResult,
  SubstrateClient,
} from "@mnmal-ai/swarm-substrate";
import {
  applyProjectSubstrateConfig,
  composeEnv,
  isolatedOptions,
  type ProjectSubstrateConfig,
} from "../project-substrate.js";
import { type DbConfig, resolveDbConfig } from "../config.js";
import { ensureProjectSubstrate, nothingRunning } from "../substrate/ready.js";

// --- ANSI helpers ---

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// --- Which stack ---

/** One sidecar of a resolved stack, and the Postgres it runs on. */
export interface StackSidecar {
  label: "cold" | "meta";
  /** Where clients reach it (the endpoint chain's answer). */
  endpoint: string;
  postgresUrl: string;
  /** The lifecycle's spec for it: port, namespace, and the stack it belongs to. */
  spec: SidecarSpec;
  /** Whether `endpoint` is the spec's own loopback sidecar — swarm's to start and stop. */
  managed: boolean;
}

/** The Substrate stack `swarm substrate` acts on for the project it is run from. */
export interface SubstrateStack {
  /** The project's own stack (the stack keys of its `substrate` config), or the machine-wide shared one. */
  kind: "dedicated" | "shared";
  /** A dedicated stack's config files, or where the shared stack's cold endpoint came from. */
  source: string;
  cold: StackSidecar;
  meta: StackSidecar;
  /** How swarm brings a dedicated stack's Postgres up: compose file, project, and the port variables it needs. */
  compose?: { file: string; project: string; env: Record<string, string> };
}

/**
 * Resolve the stack exactly as the startup path does (the main.ts preamble,
 * then ensureSubstrateReady). The project's `substrate` config is applied to
 * the environment first — idempotent after the preamble, and an error when the
 * environment points at another stack — and the endpoints then come from the
 * lifecycle's own resolvers, so the shared stack still follows
 * SWARM_SUBSTRATE_ENDPOINT, the saved `substrate_url` in ~/.swarm/config.json,
 * and SWARM_SUBSTRATE_PORT / SWARM_META_PORT. A local_only project is checked
 * again here: nothing resolved for it may point off this machine.
 */
export function resolveSubstrateStack(project?: ProjectSubstrateConfig): SubstrateStack {
  if (project !== undefined) applyProjectSubstrateConfig(project);
  if (isLocalOnlyEnv()) assertLocalOnly();
  const targets = resolveLocalOnlyTargets();
  const dedicated = project?.dedicated !== undefined || process.env.SWARM_SUBSTRATE_DEDICATED === "1";
  const coldPort = process.env.SWARM_SUBSTRATE_PORT;
  const stack = project?.dedicated?.stack ?? (dedicated && coldPort ? `swarm-dedicated-${coldPort}` : undefined);
  const specs = resolveSidecarSpecs(stack !== undefined ? { stack } : {});
  const coldSpec = specFor(specs, "cold");
  const metaSpec = specFor(specs, "meta");
  return {
    kind: dedicated ? "dedicated" : "shared",
    source:
      project?.dedicated !== undefined && project.sources.length > 0
        ? project.sources.join(" + ")
        : (targets.endpointSource ?? "default"),
    cold: {
      label: "cold",
      endpoint: targets.endpoint,
      postgresUrl: targets.postgresUrl,
      spec: coldSpec,
      managed: isManagedEndpoint(targets.endpoint, coldSpec),
    },
    meta: {
      label: "meta",
      endpoint: targets.metaEndpoint,
      postgresUrl: targets.metaPostgresUrl,
      spec: metaSpec,
      managed: isManagedEndpoint(targets.metaEndpoint, metaSpec),
    },
    ...(project?.compose !== undefined && project.dedicated !== undefined
      ? { compose: { ...project.compose, env: composeEnv(project.dedicated) } }
      : {}),
  };
}

function stackName(stack: SubstrateStack): string {
  return stack.kind === "dedicated" ? "this project's dedicated Substrate" : "the shared Substrate";
}

/** Quote a word for a copy-pasteable shell command, when it needs it. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// --- start ---

/** What start needs from the machine; injected by tests. */
export interface StartDeps {
  resolveDbConfig: (opts: { swarmDir: string }) => Promise<DbConfig | null>;
  ensure: typeof ensureProjectSubstrate;
}

const machineStartDeps = (): StartDeps => ({ resolveDbConfig, ensure: ensureProjectSubstrate });

/**
 * Bring the stack up: the compose directory comes from the db config of the
 * swarm directory the command was given (`--swarm-path`, default `.swarm`), as
 * in the startup path. Exits 1 when the stack could not be brought up.
 */
export async function substrateStart(
  project?: ProjectSubstrateConfig,
  flags: Record<string, string> = {},
  deps: StartDeps = machineStartDeps(),
): Promise<void> {
  const stack = resolveSubstrateStack(project);
  const dbConfig = await deps.resolveDbConfig({ swarmDir: flags["swarm-path"] ?? ".swarm" });
  const isolated = project !== undefined ? isolatedOptions(project) : undefined;
  const client = await deps.ensure({
    quiet: false,
    ...(dbConfig?.source === "docker" && dbConfig.dockerComposeDir !== undefined ? { dockerComposeDir: dbConfig.dockerComposeDir } : {}),
    ...(isolated !== undefined ? { isolated } : {}),
  });
  if (client === null) {
    console.error(`${RED}${stackName(stack)} is not running.${RESET} See the lines above for why.`);
    process.exit(1);
  }
  console.log(`${GREEN}${stackName(stack)} is running${RESET} (cold ${stack.cold.endpoint}, meta ${stack.meta.endpoint}).`);
}

// --- stop ---

/** What stop needs from the machine; injected by tests. */
export interface StopDeps {
  /** Stop a spec's sidecar from its stack directory's server.pid (`stopSidecar`). */
  stop(spec: SidecarSpec): Promise<StopSidecarResult>;
  log(line: string): void;
}

const machineStopDeps = (): StopDeps => ({
  stop: (spec) => stopSidecar(spec),
  log: (line) => console.log(line),
});

/**
 * Stop the stack's sidecars — the process each stack directory's server.pid
 * names, and only when it is that stack's sidecar (`stopSidecar` checks its
 * command line and working directory) — both cold and meta by default, or only
 * those `which` names. A sidecar swarm did not start for this stack (an
 * endpoint elsewhere) is never stopped. Its Postgres keeps running, with its
 * data. Returns the PIDs stopped.
 */
export async function stopSubstrateStack(
  stack: SubstrateStack,
  deps: StopDeps = machineStopDeps(),
  which: ReadonlyArray<"cold" | "meta"> = ["cold", "meta"],
): Promise<number[]> {
  deps.log(`[swarm] Stopping ${stackName(stack)}...`);
  const stopped: number[] = [];
  const ports: number[] = [];
  let unclear = false;
  for (const sidecar of which.map((name) => stack[name])) {
    if (!sidecar.managed) {
      deps.log(
        `  ${sidecar.label} sidecar: ${sidecar.endpoint} is not a sidecar swarm started for this stack ` +
          `(it runs on port ${sidecar.spec.port}); not stopping it.`,
      );
      continue;
    }
    ports.push(sidecar.spec.port);
    let result: StopSidecarResult;
    try {
      result = await deps.stop(sidecar.spec);
    } catch (err) {
      unclear = true;
      deps.log(`${RED}  ${sidecar.label} sidecar: could not stop it (${err instanceof Error ? err.message : String(err)}).${RESET}`);
      continue;
    }
    if (result.stopped) {
      if (result.pid !== null) stopped.push(result.pid);
      deps.log(`${GREEN}  ${sidecar.label} sidecar on port ${sidecar.spec.port} stopped${RESET} (PID ${result.pid})`);
    } else if (nothingRunning(result)) {
      deps.log(`${DIM}  ${sidecar.label} sidecar: not running (port ${sidecar.spec.port}).${RESET}`);
    } else {
      unclear = true;
      deps.log(`${YELLOW}  ${sidecar.label} sidecar: ${result.reason ?? "not stopped"}${RESET}`);
    }
  }
  if (stopped.length === 0 && !unclear && ports.length > 0) {
    deps.log(`Nothing of ${stackName(stack)} is running on this machine (port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}).`);
  }
  if (stack.compose !== undefined) {
    const { file, project, env } = stack.compose;
    const vars = Object.entries(env).map(([k, v]) => `${k}=${shellWord(v)}`);
    deps.log(
      `${DIM}  Its Postgres (compose project '${project}') is left running, with its data volumes. To stop it:\n` +
        `    ${[...vars, "docker compose -p", shellWord(project), "-f", shellWord(file), "stop"].join(" ")}${RESET}`,
    );
  } else {
    deps.log(`${DIM}  Postgres is left running.${RESET}`);
  }
  return stopped;
}

// --- status ---

/** What status needs from the machine; injected by tests. */
export interface StatusDeps {
  isHealthy(endpoint: string): Promise<boolean>;
  /** How many namespaces the sidecar publishes, or null when that could not be read. */
  namespaceCount(endpoint: string): Promise<number | null>;
  probePostgres(url: string): Promise<{ reachable: boolean; host: string; port: number }>;
  log(line: string): void;
}

/** Namespaces a sidecar publishes (`GET /substrate/v1/federated-schema`), or null. */
async function federatedNamespaceCount(endpoint: string): Promise<number | null> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/substrate/v1/federated-schema`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return Object.keys(body).filter((k) => !k.startsWith("_")).length;
  } catch {
    return null;
  }
}

const machineStatusDeps = (): StatusDeps => ({
  isHealthy: (endpoint) => new SubstrateClient(endpoint).isHealthy(),
  namespaceCount: federatedNamespaceCount,
  probePostgres: (url) => probePostgresReachable(url),
  log: (line) => console.log(line),
});

/**
 * Report which stack this project uses, then one line per sidecar (health and
 * how many namespaces it serves) and one per Postgres, on their real ports.
 * Postgres is shown as host:port only: its URL can carry a password.
 */
export async function reportSubstrateStack(
  stack: SubstrateStack,
  deps: StatusDeps = machineStatusDeps(),
): Promise<{ coldHealthy: boolean }> {
  const up = (ok: boolean, yes: string, no: string) => (ok ? `${GREEN}${yes}${RESET}` : `${RED}${no}${RESET}`);
  const title = (label: "cold" | "meta") => (label === "cold" ? "Cold" : "Meta");

  deps.log(
    stack.kind === "dedicated"
      ? `  Stack:           dedicated — this project's own Substrate (${stack.source})`
      : `  Stack:           shared — the default stack for projects without their own (endpoint from ${stack.source})`,
  );
  if (stack.compose !== undefined) deps.log(`  Compose project: ${stack.compose.project}`);

  let coldHealthy = false;
  for (const sidecar of [stack.cold, stack.meta]) {
    const healthy = await deps.isHealthy(sidecar.endpoint);
    if (sidecar.label === "cold") coldHealthy = healthy;
    let detail = up(healthy, "healthy", "not running");
    if (healthy) {
      const count = await deps.namespaceCount(sidecar.endpoint);
      detail += count === null ? `, ${DIM}namespaces unknown${RESET}` : `, ${count} namespace${count === 1 ? "" : "s"}`;
    }
    deps.log(`  ${title(sidecar.label)} sidecar (${sidecar.endpoint}):  ${detail}`);
  }
  for (const sidecar of [stack.cold, stack.meta]) {
    if (isMemoryStore(sidecar.postgresUrl)) {
      deps.log(`  ${title(sidecar.label)} Postgres:  ${DIM}none — the in-memory store${RESET}`);
      continue;
    }
    const pg = await deps.probePostgres(sidecar.postgresUrl);
    deps.log(`  ${title(sidecar.label)} Postgres (${pg.host}:${pg.port}):  ${up(pg.reachable, "running", "not reachable")}`);
  }
  return { coldHealthy };
}

async function substrateStatus(project?: ProjectSubstrateConfig): Promise<void> {
  const stack = resolveSubstrateStack(project);
  console.log("");
  console.log(`${BOLD}Substrate Status${RESET}`);
  console.log("");
  await reportSubstrateStack(stack);
  console.log(`  ${DIM}Stack directories: ${stackDirFor(stack.cold.spec)}, ${stackDirFor(stack.meta.spec)}${RESET}`);
  console.log("");
}

// --- Public entry point ---

/** `swarm substrate` with no or an unknown subcommand. */
export const SUBSTRATE_HELP = [
  "Usage: swarm substrate <command>",
  "",
  "Commands:",
  "  start       Start Postgres, install the Substrate runtime if needed, start both sidecars",
  "  stop        Stop this project's Substrate sidecars (cold + meta); Postgres keeps running",
  "  status      One line per sidecar (health, namespaces) and per Postgres",
].join("\n");

/**
 * Subcommands the CLI runs without its startup path (ensureSubstrateReady +
 * sync). stop and status must see the stack as it is: starting it first would
 * make stop start what it then stops, and status could never report a stack
 * that is down. The project's Substrate config is still read and applied for them.
 */
export function skipsSubstrateStartup(subcommand: string | undefined): boolean {
  return subcommand === "stop" || subcommand === "status";
}

export async function runSubstrate(
  positional: string[],
  flags: Record<string, string>,
  /** The project's Substrate config, as the CLI preamble read and applied it. */
  project?: ProjectSubstrateConfig,
): Promise<void> {
  const subcommand = positional[0];

  switch (subcommand) {
    case "start":
      await substrateStart(project, flags);
      break;
    case "stop":
      await stopSubstrateStack(resolveSubstrateStack(project));
      break;
    case "status":
      await substrateStatus(project);
      break;
    default:
      console.log(SUBSTRATE_HELP);
      process.exit(subcommand ? 1 : 0);
  }
}
