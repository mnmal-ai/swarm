/**
 * `local_only` — fail-closed isolation for projects whose context must never
 * leave this machine (e.g. work under NDA).
 *
 * When a project sets `substrate.local_only: true` in its config, swarm refuses
 * to start unless every endpoint its context engine would talk to is a
 * loopback address:
 *
 *   - the cold Substrate endpoint, from whichever source resolveSubstrateEndpoint
 *     used (explicit, SWARM_SUBSTRATE_ENDPOINT, the user-wide `substrate_url` in
 *     ~/.swarm/config.json, SWARM_SUBSTRATE_PORT, or the default);
 *   - the meta sidecar endpoint;
 *   - both Postgres URLs the sidecars are handed;
 *   - the Ollama URL the sidecars send content to for embedding.
 *
 * The CLI checks before it starts or contacts anything (`assertLocalOnly`), and
 * `ensureSidecar` checks again, against the stack directory it is about to boot,
 * before it spawns a sidecar (defense in depth: a stack written some other way
 * is refused too).
 */

/** Set by the CLI for a local_only project. */
export const LOCAL_ONLY_ENV = "SWARM_SUBSTRATE_LOCAL_ONLY";

export class LocalOnlyViolation extends Error {
  override readonly name = "LocalOnlyViolation";
  constructor(readonly violations: readonly string[]) {
    super(
      `substrate.local_only is set for this project, so swarm will not start:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    );
  }
}

export function isLocalOnlyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[LOCAL_ONLY_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** True for `localhost`, 127.0.0.0/8 and ::1 (bracketed or not). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) return v4.slice(1).every((o) => Number(o) <= 255);
  const mapped = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(h);
  return mapped !== null;
}

/** Host of a URL, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Null when `url` points at loopback, else a violation message naming `label`. */
export function loopbackViolation(label: string, url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  const host = hostOf(url);
  if (host === null) return `${label} is not a parseable URL (${url})`;
  return isLoopbackHost(host) ? null : `${label} points off this machine: ${url}`;
}

/** Same as {@link loopbackViolation}, but a Postgres URL of `memory` (Substrate's in-process store) is local. */
export function postgresLoopbackViolation(label: string, url: string | undefined): string | null {
  if (url?.trim().toLowerCase() === "memory") return null;
  return loopbackViolation(label, url);
}

export interface LocalOnlyTargets {
  /** Resolved cold Substrate endpoint. */
  endpoint: string;
  /** Which source in the endpoint chain chose {@link endpoint}, for the message. */
  endpointSource?: string;
  metaEndpoint: string;
  postgresUrl: string;
  metaPostgresUrl: string;
  /** The Ollama embedder URL, or `""` when no embedder runs. */
  ollamaUrl: string;
}

/** Every reason a local_only project must not start. Empty = clear to start. */
export function collectLocalOnlyViolations(targets: LocalOnlyTargets): string[] {
  const endpointLabel =
    targets.endpointSource === undefined
      ? "Substrate endpoint"
      : `Substrate endpoint (from ${targets.endpointSource})`;
  return [
    loopbackViolation(endpointLabel, targets.endpoint),
    loopbackViolation("meta sidecar endpoint", targets.metaEndpoint),
    postgresLoopbackViolation("Substrate Postgres URL", targets.postgresUrl),
    postgresLoopbackViolation("meta Postgres URL", targets.metaPostgresUrl),
    loopbackViolation("Embedder URL (ollama, SWARM_EMBEDDER_OLLAMA_URL)", targets.ollamaUrl),
  ].filter((v): v is string => v !== null);
}
