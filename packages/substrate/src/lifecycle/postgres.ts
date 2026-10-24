/**
 * The sidecars' Postgres: a TCP reachability probe, and bring-up through
 * docker compose — the machine-wide pair (cold on 32337, meta on 32340) from a
 * compose directory, or a project's dedicated pair from its own compose file.
 *
 * Only a compose file written for Substrate is used: one whose
 * `docker-compose.yml` names the `swarm-substrate` service. Any other compose
 * file is never brought up.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POSTGRES_TIMEOUT_MS = 10_000;
/** The service name a Substrate-era compose file declares for the cold Postgres. */
export const SUBSTRATE_COMPOSE_SERVICE = "swarm-substrate";

function log(quiet: boolean, message: string): void {
  if (!quiet) console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a postgres URL and TCP-probe the host/port to see if anything is
 * listening. Doesn't speak the Postgres protocol — just confirms a server is
 * accepting connections, for actionable "is Postgres up?" guidance before a
 * sidecar is spawned that would otherwise die quietly.
 */
export async function probePostgresReachable(
  postgresUrl: string,
  timeoutMs = 2_000,
): Promise<{ reachable: boolean; host: string; port: number }> {
  let host = "localhost";
  let port = 5432;
  try {
    const u = new URL(postgresUrl);
    if (u.hostname) host = u.hostname;
    if (u.port) port = Number(u.port) || port;
  } catch {
    // Malformed URL — cannot probe. Falling through to localhost:5432 would
    // give a false positive whenever a local Postgres happens to run there.
    return { reachable: false, host, port };
  }

  const reachable = await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port });
    const settle = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

  return { reachable, host, port };
}

/** True for Substrate's in-process store, which needs no Postgres. */
export function isMemoryStore(url: string): boolean {
  return url.trim().toLowerCase() === "memory";
}

/** ~/.swarm/infrastructure, where `swarm db setup` writes the compose files. */
export function infrastructureDir(): string {
  return join(homedir(), ".swarm", "infrastructure");
}

/** Whether `dir/docker-compose.yml` exists and declares the `swarm-substrate` service. */
export function isSubstrateComposeDir(dir: string): boolean {
  try {
    return readFileSync(join(dir, "docker-compose.yml"), "utf8").includes(SUBSTRATE_COMPOSE_SERVICE);
  } catch {
    return false;
  }
}

/**
 * Find the swarm repo root by walking up from this module looking for
 * docker-compose.yml, then the working directory.
 */
export function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "docker-compose.yml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(resolve(process.cwd(), "docker-compose.yml"))) return process.cwd();
  throw new Error("Could not find docker-compose.yml. Run this command from the swarm directory.");
}

/**
 * The directory whose compose files bring up the machine-wide Postgres pair:
 * `explicit` when given, else ~/.swarm/infrastructure, else the repo root —
 * each only when its docker-compose.yml is a Substrate-era one. Null when none is.
 */
export function resolveComposeDir(explicit?: string): string | null {
  if (explicit !== undefined) return explicit;
  if (isSubstrateComposeDir(infrastructureDir())) return infrastructureDir();
  try {
    const root = findRepoRoot();
    if (isSubstrateComposeDir(root)) return root;
  } catch {
    /* no repo checkout */
  }
  return null;
}

/** Why `docker compose` failed, for an actionable message. */
function classifyDockerFailure(err: unknown): "not-installed" | "daemon-down" | "compose-missing" | "other" {
  const msg =
    err instanceof Error
      ? `${err.message}\n${(err as NodeJS.ErrnoException).code ?? ""}\n${String((err as { stderr?: unknown }).stderr ?? "")}`
      : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("command not found") || lower.includes("not recognized") || (err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return "not-installed";
  }
  if (lower.includes("cannot connect to the docker daemon") || lower.includes("docker daemon") || lower.includes("is the docker daemon running")) {
    return "daemon-down";
  }
  if (lower.includes("no configuration file provided") || lower.includes("no such file") || lower.includes("compose.yaml") || lower.includes("compose.yml")) {
    return "compose-missing";
  }
  return "other";
}

function dockerFailureMessage(kind: ReturnType<typeof classifyDockerFailure>, composeDir: string): string {
  switch (kind) {
    case "not-installed":
      return (
        "Docker does not appear to be installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop) " +
        "or point swarm at an existing Postgres by setting SWARM_SUBSTRATE_POSTGRES_URL."
      );
    case "daemon-down":
      return (
        "The Docker daemon is not running. Start it (Docker Desktop, `colima start`, or `open -a Docker`) and retry — " +
        "or set SWARM_SUBSTRATE_POSTGRES_URL to an already-running Postgres."
      );
    case "compose-missing":
      return (
        `No docker-compose.yml found at ${composeDir}. Run \`swarm db setup\` to provision one, ` +
        "or set SWARM_SUBSTRATE_POSTGRES_URL to an external Postgres."
      );
    default:
      return (
        "Could not start Postgres via `docker compose up -d`. Check the Docker daemon and logs " +
        "(`docker compose logs`), or set SWARM_SUBSTRATE_POSTGRES_URL to an external Postgres."
      );
  }
}

/** One Postgres container of the machine-wide pair. */
interface PostgresContainer {
  label: string;
  /** Extra `docker compose` file args: none for the default file (cold). */
  composeArgs: readonly string[];
  /** Compose service to exec `pg_isready` in. */
  service: string;
  user: string;
  database: string;
}

/** Ports live in the compose files (32337 cold, 32340 meta); this list does not restate them. */
const POSTGRES_CONTAINERS: readonly PostgresContainer[] = [
  { label: "cold", composeArgs: [], service: SUBSTRATE_COMPOSE_SERVICE, user: "swarm", database: "swarm" },
  {
    label: "meta",
    composeArgs: ["-f", "docker-compose.meta.yml"],
    service: "swarm-meta",
    user: "swarm",
    database: "swarm_meta",
  },
];

function compose(composeDir: string, args: readonly string[], timeout: number): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: composeDir,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

/**
 * Bring up one container and poll `pg_isready` until it accepts connections.
 * A container already up is detected via `docker compose ps` and left alone.
 */
async function ensureOnePostgres(composeDir: string, container: PostgresContainer, quiet: boolean): Promise<void> {
  log(quiet, `[swarm] Checking ${container.label} Postgres...`);
  let isRunning = false;
  try {
    const output = compose(composeDir, [...container.composeArgs, "ps", "--format", "json"], 5_000);
    for (const line of output.trim().split("\n").filter(Boolean)) {
      try {
        const svc = JSON.parse(line) as { State?: string; Status?: string };
        if (svc.State === "running" || svc.Status?.startsWith("Up")) {
          isRunning = true;
          break;
        }
      } catch {
        /* non-JSON line */
      }
    }
  } catch {
    /* docker compose unavailable — the up below reports why */
  }
  if (isRunning) {
    log(quiet, `[swarm] Checking ${container.label} Postgres... running`);
    return;
  }

  log(quiet, `[swarm] Checking ${container.label} Postgres... starting...`);
  try {
    compose(composeDir, [...container.composeArgs, "up", "-d"], 30_000);
  } catch (err) {
    throw new Error(dockerFailureMessage(classifyDockerFailure(err), composeDir));
  }

  const deadline = Date.now() + POSTGRES_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      compose(
        composeDir,
        [...container.composeArgs, "exec", "-T", container.service, "pg_isready", "-U", container.user, "-d", container.database],
        3_000,
      );
      log(quiet, `[swarm] Checking ${container.label} Postgres... running`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(
    `${container.label} Postgres did not become ready within ${POSTGRES_TIMEOUT_MS / 1000} seconds. ` +
      `Check its logs with \`docker compose ${[...container.composeArgs, "logs"].join(" ")}\` in ${composeDir}, ` +
      `or set SWARM_SUBSTRATE_POSTGRES_URL to an external Postgres.`,
  );
}

/**
 * Bring up the machine-wide Postgres pair (cold, then meta) from `composeDir`
 * and resolve once both accept connections. Idempotent. Refuses a compose
 * directory whose docker-compose.yml is not a Substrate-era one.
 */
export async function ensurePostgres(composeDir: string, quiet: boolean): Promise<void> {
  if (!isSubstrateComposeDir(composeDir)) {
    throw new Error(
      `${join(composeDir, "docker-compose.yml")} has no '${SUBSTRATE_COMPOSE_SERVICE}' service (a pre-Substrate or missing file). ` +
        "Run `swarm db setup` to write the Substrate compose files, or set SWARM_SUBSTRATE_POSTGRES_URL to an external Postgres.",
    );
  }
  for (const container of POSTGRES_CONTAINERS) {
    await ensureOnePostgres(composeDir, container, quiet);
  }
}

/** A project's dedicated Postgres pair, brought up from its own compose file. */
export interface DedicatedPostgres {
  composeFile?: string;
  composeProject?: string;
  composeEnv?: Record<string, string>;
}

/**
 * Bring up a dedicated stack's Postgres when either URL is unreachable and a
 * compose file is configured:
 * `docker compose -p <project> -f <file> up -d --wait`, as argv (never through a
 * shell: the file and project come from the project's config). Resolves to
 * whether both are reachable afterwards.
 */
export async function ensureDedicatedPostgres(
  dedicated: DedicatedPostgres,
  urls: { postgresUrl: string; metaPostgresUrl: string },
  quiet: boolean,
): Promise<boolean> {
  const reachable = async (url: string) => isMemoryStore(url) || (await probePostgresReachable(url)).reachable;
  const bothUp = async () => (await reachable(urls.postgresUrl)) && (await reachable(urls.metaPostgresUrl));
  if (await bothUp()) return true;
  if (dedicated.composeFile === undefined) return false;
  const project = dedicated.composeProject ?? "swarm-dedicated";
  log(quiet, `[swarm] Starting the project's dedicated Postgres (compose project '${project}')...`);
  try {
    execFileSync("docker", ["compose", "-p", project, "-f", dedicated.composeFile, "up", "-d", "--wait"], {
      env: { ...process.env, ...(dedicated.composeEnv ?? {}) },
      stdio: quiet ? "ignore" : "inherit",
      timeout: 120_000,
    });
  } catch (err) {
    log(quiet, `[swarm] docker compose failed: ${(err as Error).message}`);
  }
  return bothUp();
}
