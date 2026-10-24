import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSTGRES_URL } from "@mnmal-ai/swarm-substrate";

/** Valid postgres URL schemes. */
const POSTGRES_SCHEMES = ["postgresql://", "postgres://"];

export interface DbConfig {
  source: "env" | "project" | "global" | "docker";
  postgresUrl: string;
  /** Directory containing docker-compose.yml, when source is "docker". */
  dockerComposeDir?: string;
}

export interface ResolveOptions {
  /** Path to the project's .swarm directory (e.g. /my-project/.swarm) */
  swarmDir: string;
}

/** The cold store's Postgres as `swarm db setup`'s compose file publishes it. */
const DEFAULT_DOCKER_URL = DEFAULT_POSTGRES_URL;

/**
 * Validate that a URL uses a postgres scheme (postgresql:// or postgres://).
 */
function isPostgresUrl(url: string): boolean {
  return POSTGRES_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * Read a JSON config file and return the `postgres_url` field if present.
 * Returns null if the file is missing, unreadable, invalid JSON, lacks
 * the `postgres_url` field, or the URL is not a valid postgres scheme.
 */
async function readPostgresUrlFromJson(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const url = parsed["postgres_url"];
    if (typeof url === "string" && url.length > 0 && isPostgresUrl(url)) {
      return url;
    }
    if (typeof url === "string" && url.length > 0 && !isPostgresUrl(url)) {
      console.warn(`[swarm] Ignoring invalid postgres_url in ${filePath}: must start with postgresql:// or postgres://`);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a docker-compose.yml file declares the swarm-substrate service (a
 * Substrate-era swarm compose file). Prevents accidentally connecting to an
 * unrelated Postgres instance, or bringing up an older swarm's.
 */
function isSwarmDockerCompose(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes("swarm-substrate");
  } catch {
    return false;
  }
}

/**
 * Resolve the database connection configuration from a priority chain:
 *
 * 1. SWARM_SUBSTRATE_POSTGRES_URL env var      ← always wins
 * 2. .swarm/config.json → postgres_url         ← project-level override
 * 3. ~/.swarm/config.json → postgres_url       ← global setting
 * 4. ~/.swarm/infrastructure/docker-compose.yml ← CLI-managed Docker
 * 5. ./docker-compose.yml in cwd               ← dev mode (repo checkout)
 * 6. null                                      ← no database (file-only mode)
 */
export async function resolveDbConfig(options: ResolveOptions): Promise<DbConfig | null> {
  // 1. Environment variable — always wins
  const envUrl = process.env.SWARM_SUBSTRATE_POSTGRES_URL;
  if (envUrl && envUrl.length > 0) {
    if (!isPostgresUrl(envUrl) && envUrl.trim().toLowerCase() !== "memory") {
      console.warn("[swarm] SWARM_SUBSTRATE_POSTGRES_URL must start with postgresql:// or postgres:// (or be `memory`). Ignoring.");
    } else {
      return { source: "env", postgresUrl: envUrl };
    }
  }

  // 2. Project-level .swarm/config.json
  const projectConfigPath = join(options.swarmDir, "config.json");
  if (existsSync(projectConfigPath)) {
    const url = await readPostgresUrlFromJson(projectConfigPath);
    if (url !== null) {
      return { source: "project", postgresUrl: url };
    }
  }

  // 3. Global ~/.swarm/config.json
  // If the global config references the CLI-managed Docker setup, promote
  // to "docker" source so the caller gets the compose dir for bootstrap.
  const globalConfigPath = join(homedir(), ".swarm", "config.json");
  const globalDockerDir = join(homedir(), ".swarm", "infrastructure");
  const globalDockerPath = join(globalDockerDir, "docker-compose.yml");
  if (existsSync(globalConfigPath)) {
    const url = await readPostgresUrlFromJson(globalConfigPath);
    if (url !== null) {
      if (existsSync(globalDockerPath) && isSwarmDockerCompose(globalDockerPath)) {
        return { source: "docker", postgresUrl: url, dockerComposeDir: globalDockerDir };
      }
      return { source: "global", postgresUrl: url };
    }
  }

  // 4. CLI-managed Docker: ~/.swarm/infrastructure/docker-compose.yml
  // (No config.json, but the compose file exists from a prior `swarm db setup`.)
  if (existsSync(globalDockerPath) && isSwarmDockerCompose(globalDockerPath)) {
    return { source: "docker", postgresUrl: DEFAULT_DOCKER_URL, dockerComposeDir: globalDockerDir };
  }

  // 5. Dev mode: ./docker-compose.yml in cwd
  if (existsSync("docker-compose.yml") && isSwarmDockerCompose("docker-compose.yml")) {
    return { source: "docker", postgresUrl: DEFAULT_DOCKER_URL, dockerComposeDir: process.cwd() };
  }

  // 6. No database configured
  return null;
}

/**
 * Interpret an env-var value as a boolean using the project's standard
 * truthy-string convention (mirrors the `SWARM_TRACE` predicate in
 * `cli/run.ts`): a variable counts as enabled when it is set to anything
 * other than the empty string, "0", "false", or "off" (case-insensitive).
 * Merely *defining* the variable (e.g. `SWARM_FOO=`) does not enable it.
 */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

/**
 * Escape hatch that forces consumers off the WS `subscribe()` push path and
 * back onto their polling fallback, regardless of the negotiated transport.
 *
 * This exists because the dashboard poll loop is being retired incrementally
 * in favor of `subscribe()` push (goal-10). The swarm constraint is that the
 * poll fallback may never be removed without an env-flag escape hatch — so if
 * push ever misbehaves in the field, an operator can set this flag truthy and
 * every consumer falls straight back to polling without a redeploy.
 *
 * Enabled by setting EITHER `SWARM_DISABLE_SUBSCRIBE` or `SWARM_POLL_FALLBACK`
 * to a truthy string (anything but "", "0", "false", "off"). Example:
 *
 *   SWARM_DISABLE_SUBSCRIBE=1 swarm run     # skip subscribe(), poll instead
 *
 * Consumers MUST check this before calling `subscribe()` and use their polling
 * path when it returns true. Note that subscriptions are already WS-only; this
 * flag is the *manual* override on top of the automatic HTTP-transport fallback.
 */
export function forcePollFallback(): boolean {
  return isTruthyEnv(process.env.SWARM_DISABLE_SUBSCRIBE) || isTruthyEnv(process.env.SWARM_POLL_FALLBACK);
}
