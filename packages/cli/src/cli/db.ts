/**
 * swarm db — Database setup and management for Swarm.
 *
 * Subcommands:
 *   swarm db setup    Interactive database setup (Docker or connection string)
 *   swarm db status   Show database source, URL, and connectivity
 *   swarm db start    Start the CLI-managed Docker Postgres container
 *   swarm db stop     Stop the CLI-managed Docker Postgres container
 *   swarm db reset    Wipe and restart the CLI-managed Docker Postgres container
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDbConfig } from "../config.js";
import { DEFAULT_POSTGRES_URL } from "@mnmal-ai/swarm-substrate";
import type { ProjectSubstrateConfig } from "../project-substrate.js";
import { resolveSubstrateStack, stopSubstrateStack, type StopDeps } from "./substrate.js";

/**
 * Mask the password portion of a postgres URL for safe display.
 * postgresql://user:secret@host:5432/db → postgresql://user:****@host:5432/db
 */
function maskPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return url.replace(/:([^@/:]+)@/, ":****@");
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SWARM_DIR = join(homedir(), ".swarm");
const INFRA_DIR = join(SWARM_DIR, "infrastructure");
const COMPOSE_FILE = join(INFRA_DIR, "docker-compose.yml");
const META_COMPOSE_FILE = join(INFRA_DIR, "docker-compose.meta.yml");
const GLOBAL_CONFIG = join(SWARM_DIR, "config.json");
/** The cold store's Postgres, as the compose file below publishes it (the lifecycle's default). */
const DEFAULT_DOCKER_URL = DEFAULT_POSTGRES_URL;

// The cold store: the Postgres the cold Substrate sidecar (swarm, swarm-docs,
// cortext) runs on. pgvector/pgvector:pg17 so Substrate's recall can store
// vectors. Its own compose project (`name:`), so `swarm db reset`'s `down -v`
// reaches only this file's container, network and volume — never the meta
// store's. Published on loopback only. The lifecycle recognises the directory
// by the `swarm-substrate` service.
const DOCKER_COMPOSE_CONTENT = `name: swarm-substrate
services:
  swarm-substrate:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: swarm
      POSTGRES_PASSWORD: swarm
      POSTGRES_DB: swarm
    ports:
      - "127.0.0.1:32337:5432"
    volumes:
      - swarm_substrate_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U swarm -d swarm"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  swarm_substrate_data:
`;

// The meta store (swarm_meta, institutional memory): the meta sidecar's
// Postgres, brought up alongside the cold store. Never wiped by \`swarm db reset\`.
const DOCKER_COMPOSE_META_CONTENT = `name: swarm-meta
services:
  swarm-meta:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: swarm
      POSTGRES_PASSWORD: swarm
      POSTGRES_DB: swarm_meta
    ports:
      - "127.0.0.1:32340:5432"
    volumes:
      - swarm_meta_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U swarm -d swarm_meta"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  swarm_meta_data:
`;

/**
 * Write `content` to `path` only if the file is absent or its content has
 * drifted (stale). Idempotent: re-running leaves an up-to-date file untouched,
 * and backfills a missing one without clobbering unrelated infra state.
 */
function writeComposeIfAbsentOrStale(path: string, content: string): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === content) return;
    } catch {
      // Unreadable — fall through and rewrite from the canonical content.
    }
  }
  writeFileSync(path, content);
}

/**
 * Provision both Docker Compose files (cold store + meta store) into the
 * global infrastructure dir. Idempotent and backfill-safe: a re-run on an
 * existing dir that is missing only the meta file restores it. Exported so
 * the setup flow and tests can drive it directly.
 */
export function ensureInfraComposeFiles(): void {
  if (!existsSync(INFRA_DIR)) {
    mkdirSync(INFRA_DIR, { recursive: true });
  }
  writeComposeIfAbsentOrStale(COMPOSE_FILE, DOCKER_COMPOSE_CONTENT);
  writeComposeIfAbsentOrStale(META_COMPOSE_FILE, DOCKER_COMPOSE_META_CONTENT);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readGlobalConfig(): Record<string, unknown> {
  if (existsSync(GLOBAL_CONFIG)) {
    try {
      return JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function writeGlobalConfig(patch: Record<string, unknown>): void {
  if (!existsSync(SWARM_DIR)) {
    mkdirSync(SWARM_DIR, { recursive: true, mode: 0o700 });
  }
  const existing = readGlobalConfig();
  const merged = { ...existing, ...patch };
  writeFileSync(GLOBAL_CONFIG, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // Ensure permissions are correct even if the file already existed
  chmodSync(GLOBAL_CONFIG, 0o600);
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function startDockerCompose(): void {
  execFileSync("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"], {
    stdio: "inherit",
    timeout: 60_000,
  });
}

/**
 * Check if pg_isready is available on the host.
 */
function hasPgIsready(): boolean {
  try {
    execFileSync("pg_isready", ["--version"], { stdio: "pipe", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-process TCP probe using Node's net module. No subprocess, no shell,
 * no string interpolation of untrusted input.
 */
function tcpProbe(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(port, host);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Test Postgres connectivity. Tries methods in order, each failure
 * falls through to the next:
 *   1. pg_isready on host (if installed)
 *   2. pg_isready inside Docker container (if compose file exists)
 *   3. Raw TCP probe via Node net module (always available)
 */
async function checkPostgresConnectivity(url: string): Promise<boolean> {
  // Method 1: pg_isready on host
  if (hasPgIsready()) {
    try {
      execFileSync("pg_isready", ["-d", url], { stdio: "pipe", timeout: 5_000 });
      return true;
    } catch {
      // Fall through — pg_isready failed but port may still be open
    }
  }

  // Method 2: pg_isready inside Docker container
  if (existsSync(COMPOSE_FILE)) {
    try {
      execFileSync("docker", [
        "compose", "-f", COMPOSE_FILE, "exec", "-T",
        "swarm-substrate", "pg_isready", "-U", "swarm", "-d", "swarm",
      ], { stdio: "pipe", timeout: 5_000 });
      return true;
    } catch {
      // Fall through to TCP probe — Docker may not be running
    }
  }

  // Method 3: TCP probe — in-process, no shell, no string interpolation
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port) || 5432;
    const host = parsed.hostname || "localhost";
    return await tcpProbe(host, port);
  } catch {
    return false;
  }
}

async function waitForPostgres(url: string, maxWaitMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkPostgresConnectivity(url)) return true;
    // Wait 1s before retry
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Kill sidecar helper
// ---------------------------------------------------------------------------

/**
 * Stop this project's cold Substrate sidecar, so force-sync starts a fresh one
 * after it resets the cold store. The meta sidecar is left running: its store
 * is not reset, and on the shared stack other sessions are using it. Scoped
 * like `swarm substrate stop`: the stack the project resolves to, and only the
 * process its cold stack directory's server.pid names — never another
 * project's sidecars. (A machine-wide `pkill` used to kill every project's
 * sidecars.) Returns the PIDs stopped.
 */
export async function killSidecar(project?: ProjectSubstrateConfig, deps?: StopDeps): Promise<number[]> {
  return stopSubstrateStack(resolveSubstrateStack(project), deps, ["cold"]);
}

/**
 * Wipe the cold store: `docker compose -f docker-compose.yml down -v`, then
 * `up -d`. Only the cold compose file is named, and it is its own compose
 * project, so the meta store's volume is never touched. `run` executes
 * `docker <args>`; injected by tests.
 */
export function resetColdStore(
  run: (args: string[]) => void = (args) => {
    execFileSync("docker", args, { stdio: "inherit", timeout: 60_000 });
  },
): void {
  run(["compose", "-f", COMPOSE_FILE, "down", "-v"]);
  run(["compose", "-f", COMPOSE_FILE, "up", "-d"]);
}

/**
 * The ~/.swarm/config.json patch `swarm db setup` writes for a Postgres the
 * user brings: the URL, and the Substrate sidecar's URL as `substrate_url`
 * when one was given (blank: swarm starts its own on the default port).
 */
export function connectionStringConfig(postgresUrl: string, sidecarUrl: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { postgres_url: postgresUrl, db_mode: "connection_string" };
  if (sidecarUrl.trim()) patch["substrate_url"] = sidecarUrl.trim();
  return patch;
}

// ---------------------------------------------------------------------------
// Postgres readiness (exported for use by sync --force)
// ---------------------------------------------------------------------------

export { waitForPostgres, checkPostgresConnectivity, DEFAULT_DOCKER_URL };

// ---------------------------------------------------------------------------
// DbSetupResult
// ---------------------------------------------------------------------------

export interface DbSetupResult {
  mode: "docker" | "connection_string" | "file";
  url?: string;
}

// ---------------------------------------------------------------------------
// runDbSetup — interactive DB setup flow
// ---------------------------------------------------------------------------

export async function runDbSetup(): Promise<DbSetupResult> {
  // Load clack/prompts dynamically (ESM-only)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = await import("@clack/prompts");

  console.log("");
  p.log.message("Database Setup\n─────────────\nSwarm uses PostgreSQL for typed agent communication,\ntelemetry, and institutional memory.");
  console.log("");

  const dockerAvailable = isDockerAvailable();

  const options: Array<{ value: string; label: string; hint: string }> = [];

  if (dockerAvailable) {
    options.push({
      value: "docker",
      label: "Docker (recommended)",
      hint: "starts a Postgres container automatically",
    });
  }

  options.push(
    {
      value: "connection_string",
      label: "Connection string",
      hint: "bring your own Postgres",
    },
    {
      value: "skip",
      label: "Skip for now",
      hint: "you can run `swarm db setup` later",
    },
  );

  const choice = await p.select({
    message: "How would you like to set up the database?",
    options,
  });

  if (p.isCancel(choice)) {
    p.log.warn("Database setup skipped.");
    writeGlobalConfig({ db_mode: "file" });
    return { mode: "file" };
  }

  // --- Docker path ---
  if (choice === "docker") {
    // Provision both compose files (cold store + meta store) to
    // ~/.swarm/infrastructure/. Idempotent: backfills a missing meta file on
    // re-run without clobbering an existing, up-to-date cold store.
    ensureInfraComposeFiles();

    const spinner = p.spinner();
    spinner.start("Starting Postgres container...");

    try {
      startDockerCompose();
    } catch (err) {
      spinner.stop("Failed to start container.");
      p.log.error(`docker compose failed: ${err instanceof Error ? err.message : String(err)}`);
      p.log.info("You can retry with: swarm db start");
      writeGlobalConfig({ db_mode: "file" });
      return { mode: "file" };
    }

    spinner.message("Waiting for Postgres to accept connections...");
    const ready = await waitForPostgres(DEFAULT_DOCKER_URL);

    if (ready) {
      spinner.stop("Postgres is ready.");
    } else {
      spinner.stop("Postgres started but is taking longer than expected to be ready.");
      p.log.warn("Check status with: swarm db status");
    }

    writeGlobalConfig({ postgres_url: DEFAULT_DOCKER_URL, db_mode: "docker" });
    p.log.success(`Database URL saved to ~/.swarm/config.json`);

    return { mode: "docker", url: DEFAULT_DOCKER_URL };
  }

  // --- Connection string path ---
  if (choice === "connection_string") {
    const urlInput = await p.text({
      message: "Enter your PostgreSQL connection string:",
      placeholder: "postgresql://user:password@localhost:5432/dbname",
      validate(value: string): string | undefined {
        const trimmed = value.trim();
        if (!trimmed.startsWith("postgresql://") && !trimmed.startsWith("postgres://")) {
          return "Must start with postgresql:// or postgres://";
        }
        return undefined;
      },
    });

    if (p.isCancel(urlInput)) {
      p.log.warn("Database setup skipped.");
      writeGlobalConfig({ db_mode: "file" });
      return { mode: "file" };
    }

    const url = (urlInput as string).trim();

    // Ask where the Substrate sidecar is. Blank = swarm starts one locally on
    // the default port (32338). A URL here is saved as substrate_url, which the
    // endpoint chain uses directly (and swarm never starts a sidecar for it).
    const sidecarInput = await p.text({
      message: "Where is the Substrate sidecar? (leave blank to start one locally)",
      placeholder: "http://localhost:32338",
      validate(value: string): string | undefined {
        if (!value.trim()) return undefined;
        try { new URL(value.trim()); return undefined; } catch {
          return "Must be a valid URL (e.g. http://localhost:32338)";
        }
      },
    });

    writeGlobalConfig(connectionStringConfig(url, p.isCancel(sidecarInput) ? "" : (sidecarInput as string)));
    p.log.success(`Database URL saved to ~/.swarm/config.json`);

    return { mode: "connection_string", url };
  }

  // --- Skip path ---
  writeGlobalConfig({ db_mode: "file" });
  p.log.info(
    "Database setup skipped. Swarm will run in file-only mode.\nRun `swarm db setup` at any time to configure a database.",
  );

  return { mode: "file" };
}

// ---------------------------------------------------------------------------
// runDb — CLI handler for `swarm db <subcommand>`
// ---------------------------------------------------------------------------

export async function runDb(
  positional: string[],
  _flags: Record<string, string>,
): Promise<void> {
  const subcommand = positional[0];

  // A project with its own Substrate stack (substrate.* in its config) does not
  // use the machine-wide containers these subcommands manage; resetting them
  // from here would wipe other projects' data, not this one's.
  if (
    process.env.SWARM_SUBSTRATE_DEDICATED === "1" &&
    (subcommand === "start" || subcommand === "stop" || subcommand === "reset" || subcommand === "setup")
  ) {
    console.error(
      `This project runs its own Substrate Postgres (substrate.* in its config); \`swarm db ${subcommand}\` manages the ` +
        "machine-wide containers. Use the project's compose file instead.",
    );
    process.exit(1);
  }

  switch (subcommand) {
    case "setup": {
      await runDbSetup();
      break;
    }

    case "status": {
      const dbConfig = await resolveDbConfig({ swarmDir: ".swarm" });

      console.log("");
      console.log("Database Status");
      console.log("───────────────");
      console.log("");

      if (!dbConfig) {
        console.log("  Source:  (none)");
        console.log("  Mode:    file-only");
        console.log("");
        console.log("  Run `swarm db setup` to configure a database.");
      } else {
        console.log(`  Source:  ${dbConfig.source}`);
        console.log(`  URL:     ${maskPostgresUrl(dbConfig.postgresUrl)}`);
        console.log("");

        if (await checkPostgresConnectivity(dbConfig.postgresUrl)) {
          console.log("  Status:  \x1b[32mreachable\x1b[0m");
        } else {
          console.log("  Status:  \x1b[31mnot reachable\x1b[0m");
          console.log("");
          console.log("  Postgres is not accepting connections.");
          if (dbConfig.source === "docker") {
            console.log("  Try: swarm db start");
          }
        }
      }

      console.log("");
      break;
    }

    case "start": {
      if (!existsSync(COMPOSE_FILE)) {
        console.error(
          "No CLI-managed docker-compose.yml found at ~/.swarm/infrastructure/.\n" +
          "Run `swarm db setup` to configure Docker-managed Postgres.",
        );
        process.exit(1);
      }

      console.log("Starting Postgres container...");
      try {
        execFileSync("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"], {
          stdio: "inherit",
          timeout: 60_000,
        });
        console.log("\x1b[32mPostgres container started.\x1b[0m");
      } catch (err) {
        console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      if (!existsSync(COMPOSE_FILE)) {
        console.error(
          "No CLI-managed docker-compose.yml found at ~/.swarm/infrastructure/.\n" +
          "Run `swarm db setup` to configure Docker-managed Postgres.",
        );
        process.exit(1);
      }

      console.log("Stopping Postgres container...");
      try {
        execFileSync("docker", ["compose", "-f", COMPOSE_FILE, "stop"], {
          stdio: "inherit",
          timeout: 30_000,
        });
        console.log("\x1b[32mPostgres container stopped.\x1b[0m");
      } catch (err) {
        console.error(`Failed to stop: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "reset": {
      if (!existsSync(COMPOSE_FILE)) {
        console.error(
          "No CLI-managed docker-compose.yml found at ~/.swarm/infrastructure/.\n" +
          "Run `swarm db setup` to configure Docker-managed Postgres.",
        );
        process.exit(1);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = await import("@clack/prompts");

      const confirmed = await p.confirm({
        message: "This will wipe all data in the cold store (the swarm-substrate Postgres volume); the meta store is kept. Are you sure?",
        initialValue: false,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Reset cancelled.");
        break;
      }

      console.log("Resetting the cold store's Postgres container (its volume will be wiped)...");
      try {
        resetColdStore();
        console.log("\x1b[32mCold store Postgres reset and started.\x1b[0m");
      } catch (err) {
        console.error(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.log("Usage: swarm db <command>");
      console.log("");
      console.log("Commands:");
      console.log("  setup    Interactive database setup (Docker or connection string)");
      console.log("  status   Show database source, URL, and connectivity");
      console.log("  start    Start the CLI-managed Docker Postgres container");
      console.log("  stop     Stop the CLI-managed Docker Postgres container");
      console.log("  reset    Wipe and restart the cold store's Postgres (the meta store is kept)");
      process.exit(subcommand ? 1 : 0);
    }
  }
}
