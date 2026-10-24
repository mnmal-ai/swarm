/**
 * Project-level Substrate settings: a dedicated per-project stack and the
 * `local_only` isolation guard, read from the project's own config.
 *
 * By default every swarm project on a machine shares one Substrate stack (cold
 * sidecar 32338 on Postgres 32337, meta sidecar 32341 on Postgres 32340), so
 * one project's run can read another's content. A project opts out with a
 * `substrate` block in `.swarm/config.json` or in its domain config
 * `.swarm/domains/<project>/config.json` (the domain file wins per key):
 *
 *   "substrate": {
 *     "local_only": true,
 *     "port": 47338,
 *     "postgres_url": "postgresql://swarm:swarm@127.0.0.1:47337/swarm",
 *     "meta_port": 47341,
 *     "meta_postgres_url": "postgresql://swarm:swarm@127.0.0.1:47340/swarm_meta",
 *     "compose_file": "substrate/docker-compose.dedicated.yml",
 *     "compose_project": "swarm-project-a"
 *   }
 *
 * - The four stack keys are all-or-nothing: a project that names its own cold
 *   store but not its own meta store would still share the meta store, so a
 *   partial set is an error rather than a half-isolated stack.
 * - `compose_project` names the stack: its sidecars' directories are
 *   `~/.swarm/substrate/stacks/<compose_project>-cold|meta`. Without one the
 *   stack is named by its cold port (`swarm-dedicated-<port>`), so two
 *   dedicated projects never share a stack directory or a pid file.
 * - `compose_file` is relative to the config file that names it; swarm brings
 *   the project's Postgres up with it (as compose project `compose_project`)
 *   when it is down.
 * - `local_only` is fail-closed and additive: if the swarm-dir config or ANY
 *   domain config under .swarm/domains/ sets it, in the `substrate` block or in
 *   any other top-level object block, it is on — whichever project
 *   the invocation resolves to. swarm then refuses to start unless every
 *   endpoint its context engine would use is loopback (see `local-only.ts` in
 *   @mnmal-ai/swarm-substrate).
 * - A dedicated stack declared by a domain other than the one the invocation
 *   resolved to is an error, never a silent fall-back to the shared stack.
 *
 * The stack keys are applied by setting the SWARM_SUBSTRATE_* / SWARM_META_*
 * variables every consumer reads, so the sidecars swarm spawns inherit them.
 * An environment variable that disagrees with the project's config is an
 * error, not an override: silently following a stray SWARM_SUBSTRATE_ENDPOINT
 * back to the shared stack is exactly what a dedicated stack exists to prevent.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertLocalOnly, type EnsureSubstrateReadyOptions, LocalOnlyViolation } from "@mnmal-ai/swarm-substrate";
import type { ContextConfig } from "@mnmal-ai/swarm-types";
import { rankingEnv, resolveContextRanking, validateContextConfig } from "./cli/context-sections.js";

export interface ProjectSubstrateConfig {
  localOnly: boolean;
  /** Set when the project runs its own stack; all four fields together, and the stack's name. */
  dedicated?: {
    port: number;
    postgresUrl: string;
    metaPort: number;
    metaPostgresUrl: string;
    /** The stack's name: `compose_project`, or `swarm-dedicated-<port>`. */
    stack: string;
  };
  /** Compose file (absolute) + project name that start the dedicated Postgres. */
  compose?: { file: string; project: string };
  /** Config files that contributed a `substrate` block. */
  sources: string[];
  /** Whether the domain config enables telemetry sharing (uploads off-machine). */
  telemetrySharing: boolean;
}

export class ProjectSubstrateConfigError extends Error {
  override readonly name = "ProjectSubstrateConfigError";
}

type Raw = Record<string, unknown>;

const STACK_KEYS = ["port", "postgres_url", "meta_port", "meta_postgres_url"] as const;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

function readJson(path: string): Raw | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : null;
  } catch (err) {
    throw new ProjectSubstrateConfigError(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function substrateBlock(cfg: Raw | null, path: string): Raw | null {
  const block = cfg?.["substrate"];
  if (block === undefined) return null;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new ProjectSubstrateConfigError(`${path}: "substrate" must be an object`);
  }
  return block as Raw;
}

function port(value: unknown, key: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ProjectSubstrateConfigError(`${path}: substrate.${key} must be a port number (1-65535)`);
  }
  return value;
}

/**
 * A Postgres URL that names a host. `postgresql:///` passes a prefix check but
 * leaves compose nothing to publish, and fails later as a confusing docker
 * error; refuse it here instead. The value is not echoed: it may hold a password.
 */
function pgUrl(value: unknown, key: string, path: string): string {
  let url: URL | null = null;
  if (typeof value === "string") {
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
  }
  if (url === null || (url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hostname === "") {
    throw new ProjectSubstrateConfigError(`${path}: substrate.${key} must be a postgresql:// URL that names a host`);
  }
  return value as string;
}

/**
 * True when ANY top-level object block of a config carries `local_only: true`,
 * whatever the block is called. The guard fails closed: a block swarm does not
 * read the stack keys from (an older name, a typo) still turns isolation on.
 */
function anyBlockLocalOnly(cfg: Record<string, unknown> | null): boolean {
  if (cfg === null || typeof cfg !== "object") return false;
  return Object.values(cfg).some(
    (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>)["local_only"] === true,
  );
}

/**
 * Read the project's `substrate` settings. `project` selects the domain config
 * (`.swarm/domains/<project>/config.json`); the swarm-dir `.swarm/config.json`
 * applies to every domain in it.
 */
export function readProjectSubstrateConfig(swarmDir: string, project: string): ProjectSubstrateConfig {
  const files = [join(swarmDir, "config.json"), join(swarmDir, "domains", project, "config.json")];
  const out: ProjectSubstrateConfig = { localOnly: false, sources: [], telemetrySharing: false };

  // Fail closed across domains: another domain's local_only still applies, and
  // another domain's dedicated stack means this invocation resolved the wrong
  // project — refuse rather than run it against the shared stack.
  const domainsDir = join(swarmDir, "domains");
  const others = existsSync(domainsDir)
    ? readdirSync(domainsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== project)
        .map((d) => join(domainsDir, d.name, "config.json"))
    : [];
  for (const path of others) {
    const otherCfg = readJson(path);
    if (anyBlockLocalOnly(otherCfg)) out.localOnly = true;
    const block = substrateBlock(otherCfg, path);
    if (block === null) continue;
    if (block["local_only"] !== undefined && typeof block["local_only"] !== "boolean") {
      throw new ProjectSubstrateConfigError(`${path}: substrate.local_only must be true or false`);
    }
    if (block["local_only"] === true) {
      out.localOnly = true;
      out.sources.push(path);
    }
    if (STACK_KEYS.some((k) => block[k] !== undefined)) {
      throw new ProjectSubstrateConfigError(
        `${path} declares a dedicated Substrate, but this invocation resolved the project as '${project}'. ` +
          `Pass --project <name> (or fix .swarm/.swarm-meta.json project_name), or move the "substrate" block to ` +
          `${join(swarmDir, "config.json")} so it applies to every project in this .swarm/.`,
      );
    }
  }
  const merged: Raw = {};
  let composeBase: string | null = null;

  for (const path of files) {
    const cfg = readJson(path);
    const block = substrateBlock(cfg, path);
    if (anyBlockLocalOnly(cfg)) out.localOnly = true;
    if (path === files[1]) {
      const sharing = cfg?.["telemetry_sharing"] as { enabled?: unknown } | undefined;
      out.telemetrySharing = sharing?.enabled === true;
    }
    if (block === null) continue;
    out.sources.push(path);
    if (block["local_only"] !== undefined && typeof block["local_only"] !== "boolean") {
      throw new ProjectSubstrateConfigError(`${path}: substrate.local_only must be true or false`);
    }
    // Fail-closed: either file can turn it on; neither can turn it off.
    if (block["local_only"] === true) out.localOnly = true;
    for (const [k, v] of Object.entries(block)) {
      if (k === "local_only") continue;
      merged[k] = v;
      if (k === "compose_file") composeBase = dirname(path);
    }
  }

  const where = out.sources.join(" + ") || join(swarmDir, "config.json");
  const present = STACK_KEYS.filter((k) => merged[k] !== undefined);
  if (present.length > 0 && present.length < STACK_KEYS.length) {
    const missing = STACK_KEYS.filter((k) => merged[k] === undefined);
    throw new ProjectSubstrateConfigError(
      `${where}: a dedicated Substrate needs all of ${STACK_KEYS.map((k) => `substrate.${k}`).join(", ")} ` +
        `(missing ${missing.map((k) => `substrate.${k}`).join(", ")}) — a partial set would still share the missing store`,
    );
  }
  const composeProject = merged["compose_project"];
  if (composeProject !== undefined) {
    if (typeof composeProject !== "string" || !COMPOSE_PROJECT.test(composeProject)) {
      throw new ProjectSubstrateConfigError(
        `${where}: substrate.compose_project must be a docker compose project name (lowercase letters, digits, - and _)`,
      );
    }
    if (present.length === 0) {
      throw new ProjectSubstrateConfigError(
        `${where}: substrate.compose_project names a dedicated stack, and needs the dedicated stack keys alongside it`,
      );
    }
  }
  if (present.length === STACK_KEYS.length) {
    const coldPort = port(merged["port"], "port", where);
    out.dedicated = {
      port: coldPort,
      postgresUrl: pgUrl(merged["postgres_url"], "postgres_url", where),
      metaPort: port(merged["meta_port"], "meta_port", where),
      metaPostgresUrl: pgUrl(merged["meta_postgres_url"], "meta_postgres_url", where),
      stack: typeof composeProject === "string" ? composeProject : `swarm-dedicated-${coldPort}`,
    };
    if (out.dedicated.port === out.dedicated.metaPort) {
      throw new ProjectSubstrateConfigError(`${where}: substrate.port and substrate.meta_port must differ`);
    }
  }
  if (merged["compose_file"] !== undefined) {
    if (typeof merged["compose_file"] !== "string" || out.dedicated === undefined) {
      throw new ProjectSubstrateConfigError(
        `${where}: substrate.compose_file must be a path, and needs the dedicated stack keys alongside it`,
      );
    }
    if (typeof composeProject !== "string") {
      throw new ProjectSubstrateConfigError(
        `${where}: substrate.compose_file needs substrate.compose_project, the docker compose project its Postgres runs as`,
      );
    }
    const file = merged["compose_file"];
    out.compose = { file: isAbsolute(file) ? file : resolve(composeBase ?? swarmDir, file), project: composeProject };
  }
  return out;
}

/** Postgres host port of a URL (for the compose file's published ports). */
function pgPort(url: string): string {
  const u = new URL(url);
  return u.port === "" ? "5432" : u.port;
}

/**
 * The environment a dedicated stack runs under. Exported for tests and for
 * `docker compose` (the compose file publishes the Postgres ports it names).
 * The endpoints are set too: the endpoint chain ranks them, and a saved
 * `substrate_url`, above the ports.
 */
export function dedicatedEnv(d: NonNullable<ProjectSubstrateConfig["dedicated"]>): Record<string, string> {
  return {
    SWARM_SUBSTRATE_PORT: String(d.port),
    SWARM_SUBSTRATE_ENDPOINT: `http://127.0.0.1:${d.port}`,
    SWARM_SUBSTRATE_POSTGRES_URL: d.postgresUrl,
    SWARM_META_PORT: String(d.metaPort),
    SWARM_META_ENDPOINT: `http://127.0.0.1:${d.metaPort}`,
    SWARM_META_POSTGRES_URL: d.metaPostgresUrl,
  };
}

/** Compose-file variables for the dedicated Postgres containers. */
export function composeEnv(d: NonNullable<ProjectSubstrateConfig["dedicated"]>): Record<string, string> {
  return {
    SWARM_DEDICATED_PG_PORT: pgPort(d.postgresUrl),
    SWARM_DEDICATED_META_PG_PORT: pgPort(d.metaPostgresUrl),
  };
}

/**
 * Whether two endpoint URLs reach the same sidecar: same scheme, same port, and
 * the same host — with only localhost, 127.0.0.1 and ::1 folded together. The
 * rest of 127.0.0.0/8 stays distinct on purpose: two loopback addresses can be
 * two different services.
 */
function sameEndpoint(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const loop = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    return (
      ua.protocol === ub.protocol &&
      ua.port === ub.port &&
      (ua.hostname === ub.hostname || (loop(ua.hostname) && loop(ub.hostname)))
    );
  } catch {
    return a === b;
  }
}

const ENDPOINT_KEYS = new Set(["SWARM_SUBSTRATE_ENDPOINT", "SWARM_META_ENDPOINT"]);

/**
 * Put the project's stack into `env` (process.env by default) so every
 * consumer and every sidecar swarm spawns uses it. Throws, naming the variable,
 * its value and what the project's config says, when `env` already holds a
 * different value for one of them; nothing is applied then.
 */
export function applyProjectSubstrateConfig(
  cfg: ProjectSubstrateConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cfg.dedicated !== undefined) {
    const want = dedicatedEnv(cfg.dedicated);
    const conflicts = Object.entries(want)
      .filter(([k, v]) => {
        const have = env[k];
        if (have === undefined || have === "") return false;
        return ENDPOINT_KEYS.has(k) ? !sameEndpoint(have, v) : have !== v;
      })
      .map(([k, v]) => `${k}=${env[k]} (the project's config says ${v})`);
    if (conflicts.length > 0) {
      throw new ProjectSubstrateConfigError(
        `this project runs its own Substrate (${cfg.sources.join(" + ")}), but the environment points elsewhere:\n` +
          conflicts.map((c) => `  - ${c}`).join("\n") +
          `\nUnset those variables (or change the project's config) and retry.`,
      );
    }
    Object.assign(env, want);
    env.SWARM_SUBSTRATE_DEDICATED = "1";
  }
  if (cfg.localOnly) env.SWARM_SUBSTRATE_LOCAL_ONLY = "1";
}

/**
 * The project's `context.ranking` embedder (stage 3 of the context-sections
 * spec), from its domain config, the file `swarm run` reads `context` from, so
 * the sidecar and the run never disagree; null when ranking is off. Its
 * sidecars embed sections as they are stored, so the embedder is theirs: it
 * goes into `env` (the SWARM_EMBEDDER_* variables the lifecycle reads into the
 * stacks' recall config) beside the stack variables, and an environment naming
 * another embedder is an error.
 */
export function applyProjectRanking(
  swarmDir: string,
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): { model: string; dimension: number; ollamaUrl: string; maxSections: number; timeoutMs: number } | null {
  const where = join(swarmDir, "domains", project, "config.json");
  const context = readJson(where)?.["context"];
  if (context === undefined) return null;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new ProjectSubstrateConfigError(`${where}: "context" must be an object`);
  }
  const errors = validateContextConfig(context);
  if (errors.length > 0) {
    throw new ProjectSubstrateConfigError(`Invalid context in ${where}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  const ranking = resolveContextRanking(context as ContextConfig);
  if (ranking === null) return null;
  const want = rankingEnv(ranking);
  const conflicts = Object.entries(want)
    .filter(([k, v]) => env[k] !== undefined && env[k] !== "" && env[k] !== v)
    .map(([k, v]) => `${k}=${env[k]} (the project's config says ${v})`);
  if (conflicts.length > 0) {
    throw new ProjectSubstrateConfigError(
      `this project ranks sections with ${ranking.model} (${where}), but the environment names another embedder:\n` +
        conflicts.map((c) => `  - ${c}`).join("\n") +
        `\nUnset those variables (or change context.ranking) and retry.`,
    );
  }
  Object.assign(env, want);
  return ranking;
}

/**
 * Read, apply and (for local_only) enforce the project's Substrate settings in
 * one step, returning the `isolated` options ensureSubstrateReady needs for a
 * dedicated stack (its `composeProject` names the stack's directories, with or
 * without a compose file). Throws ProjectSubstrateConfigError or
 * LocalOnlyViolation; callers print the message and exit non-zero. Shared by
 * the CLI preamble and `swarm init`, so no entry point reaches Substrate
 * without it.
 */
export async function prepareProjectSubstrate(
  swarmDir: string,
  project: string,
): Promise<{ isolated?: EnsureSubstrateReadyOptions["isolated"]; config: ProjectSubstrateConfig }> {
  const config = readProjectSubstrateConfig(swarmDir, project);
  applyProjectSubstrateConfig(config);
  // Before the local_only check, so a ranking embedder off this machine is refused.
  applyProjectRanking(swarmDir, project);
  if (config.localOnly) {
    if (config.telemetrySharing) {
      throw new LocalOnlyViolation([
        "telemetry_sharing.enabled is true in this project's config; telemetry uploads leave this machine",
      ]);
    }
    assertLocalOnly();
  }
  const isolated = isolatedOptions(config);
  return isolated === undefined ? { config } : { config, isolated };
}

/**
 * The `isolated` options ensureSubstrateReady takes for a dedicated stack: its
 * `composeProject` names the stack's directories (with or without a compose
 * file), and a compose file brings its Postgres up. Undefined for the shared stack.
 */
export function isolatedOptions(config: ProjectSubstrateConfig): EnsureSubstrateReadyOptions["isolated"] | undefined {
  if (config.dedicated === undefined) return undefined;
  return config.compose
    ? { composeFile: config.compose.file, composeProject: config.compose.project, composeEnv: composeEnv(config.dedicated) }
    : { composeProject: config.dedicated.stack };
}
