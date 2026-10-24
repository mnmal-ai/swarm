/**
 * The sidecars the lifecycle manages: one Substrate process per store, each
 * with its own Postgres. The cold stack serves `swarm` and `swarm-docs` (and
 * loads cortext, the context store the drainstop promotes into); the meta
 * stack serves `swarm_meta`.
 *
 * `SIDECAR_SPECS` holds the machine-wide defaults; {@link resolveSidecarSpecs}
 * applies the environment (`SWARM_SUBSTRATE_PORT`, `SWARM_SUBSTRATE_POSTGRES_URL`,
 * `SWARM_META_PORT`, `SWARM_META_POSTGRES_URL`), the `postgres_url` that
 * `swarm db setup` saves in ~/.swarm/config.json, and, for a project's
 * dedicated stack, its compose project name.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SWARM_META_NAMESPACE, SWARM_NAMESPACE } from "@mnmal-ai/swarm-substrate-shared";

export const DEFAULT_SUBSTRATE_PORT = 32338;
export const DEFAULT_META_PORT = 32341;
export const DEFAULT_POSTGRES_URL = "postgresql://swarm:swarm@localhost:32337/swarm";
export const DEFAULT_META_POSTGRES_URL = "postgresql://swarm:swarm@localhost:32340/swarm_meta";

export interface SidecarSpec {
  /** Which store: `cold` (swarm, swarm-docs, cortext) or `meta` (swarm_meta). */
  label: "cold" | "meta";
  /** TCP port the sidecar listens on (always on 127.0.0.1). */
  port: number;
  /** The namespace this sidecar serves, as clients address it (`swarm`, `swarm_meta`). */
  namespace: string;
  /** The swarm plugin's `scope` for this sidecar. */
  scope: "cold" | "meta";
  /** `SUBSTRATE_DATABASE_URL` for this sidecar: a Postgres URL, or `memory`. */
  postgresUrl: string;
  /**
   * Where `postgresUrl` came from, for messages: the environment variable, the
   * saved `postgres_url in <path>`, or `default`. Set by {@link resolveSidecarSpecs}.
   */
  postgresUrlSource?: string;
  /**
   * Compose file that provisions this sidecar's Postgres, when it differs from
   * the default `docker-compose.yml`. The cold store uses the default file; the
   * meta store has its own.
   */
  postgresComposeFile?: string;
  /**
   * The dedicated stack this sidecar belongs to (the project's compose project
   * name), or undefined for the machine-wide shared stack. It names the stack
   * directory: `<stack>-<label>` rather than `<label>`.
   */
  stack?: string;
}

/** The machine-wide two-sidecar topology, before the environment is applied. */
export const SIDECAR_SPECS: readonly SidecarSpec[] = [
  {
    label: "cold",
    port: DEFAULT_SUBSTRATE_PORT,
    namespace: SWARM_NAMESPACE,
    scope: "cold",
    postgresUrl: DEFAULT_POSTGRES_URL,
  },
  {
    label: "meta",
    port: DEFAULT_META_PORT,
    namespace: SWARM_META_NAMESPACE,
    scope: "meta",
    postgresUrl: DEFAULT_META_POSTGRES_URL,
    postgresComposeFile: "docker-compose.meta.yml",
  },
];

/** Path to the user-wide swarm config (resolved per call, so a HOME change applies). */
export function swarmConfigPath(): string {
  return join(homedir(), ".swarm", "config.json");
}

/**
 * `postgres_url` from ~/.swarm/config.json, honoured only when the same file
 * says `db_mode: "connection_string"`: the Postgres the user gave
 * `swarm db setup` ("bring your own"). In docker mode, or with no mode, the
 * URL is ignored and the compose default applies, so a config copied from
 * another installation cannot point swarm at that installation's Postgres (a
 * loopback URL `local_only` would not catch). Null when the file is absent or
 * unparseable, the mode is not connection_string, or the value is not a
 * postgres:// URL.
 */
export function readSavedPostgresUrl(path: string = swarmConfigPath()): string | null {
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (cfg.db_mode !== "connection_string") return null;
    const url = cfg.postgres_url;
    if (typeof url === "string" && /^postgres(ql)?:\/\//.test(url.trim())) return url.trim();
  } catch {
    /* absent or unparseable */
  }
  return null;
}

function portFrom(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a TCP port (got ${JSON.stringify(raw)})`);
  }
  return port;
}

/** The cold store's Postgres URL and where it came from (see {@link resolveSidecarSpecs}). */
function coldPostgres(env: NodeJS.ProcessEnv, dedicated: boolean, fallback: string): { url: string; source: string } {
  if (env.SWARM_SUBSTRATE_POSTGRES_URL) return { url: env.SWARM_SUBSTRATE_POSTGRES_URL, source: "SWARM_SUBSTRATE_POSTGRES_URL" };
  if (!dedicated) {
    const path = swarmConfigPath();
    const saved = readSavedPostgresUrl(path);
    if (saved !== null) return { url: saved, source: `postgres_url in ${path}` };
  }
  return { url: fallback, source: "default" };
}

/**
 * {@link SIDECAR_SPECS} with the environment applied. The cold sidecar's port
 * comes from `SWARM_SUBSTRATE_PORT`, its Postgres from, first match wins:
 *   1. `SWARM_SUBSTRATE_POSTGRES_URL` (a project's `substrate.postgres_url`
 *      arrives here too: the CLI applies it to the environment, and refuses an
 *      environment that disagrees);
 *   2. `postgres_url` in ~/.swarm/config.json when its `db_mode` is
 *      `connection_string` (`swarm db setup`'s bring-your-own Postgres), except
 *      for a dedicated stack, which never takes machine-wide settings;
 *   3. the docker-compose default.
 * The meta sidecar's port and Postgres come from `SWARM_META_PORT` /
 * `SWARM_META_POSTGRES_URL`. `stack` marks both as one project's dedicated stack.
 */
export function resolveSidecarSpecs(opts: { env?: NodeJS.ProcessEnv; stack?: string } = {}): SidecarSpec[] {
  const env = opts.env ?? process.env;
  return SIDECAR_SPECS.map((spec) => {
    let resolved: SidecarSpec;
    if (spec.label === "cold") {
      const pg = coldPostgres(env, opts.stack !== undefined, spec.postgresUrl);
      resolved = {
        ...spec,
        port: portFrom(env.SWARM_SUBSTRATE_PORT, "SWARM_SUBSTRATE_PORT", spec.port),
        postgresUrl: pg.url,
        postgresUrlSource: pg.source,
      };
    } else {
      resolved = {
        ...spec,
        port: portFrom(env.SWARM_META_PORT, "SWARM_META_PORT", spec.port),
        postgresUrl: env.SWARM_META_POSTGRES_URL || spec.postgresUrl,
        postgresUrlSource: env.SWARM_META_POSTGRES_URL ? "SWARM_META_POSTGRES_URL" : "default",
      };
    }
    if (opts.stack !== undefined) resolved.stack = opts.stack;
    return resolved;
  });
}

/** The spec for `label` in `specs`. */
export function specFor(specs: readonly SidecarSpec[], label: SidecarSpec["label"]): SidecarSpec {
  const spec = specs.find((s) => s.label === label);
  if (spec === undefined) throw new Error(`no ${label} sidecar spec`);
  return spec;
}

/** The URL the lifecycle probes a sidecar on: the loopback address it binds. */
export function sidecarUrl(spec: Pick<SidecarSpec, "port">): string {
  return `http://127.0.0.1:${spec.port}`;
}
