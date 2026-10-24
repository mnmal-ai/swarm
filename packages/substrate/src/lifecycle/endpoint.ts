/**
 * Where the swarm's Substrate sidecars are, for this invocation.
 *
 * Cold endpoint, first match wins:
 *   1. an explicit endpoint (caller-supplied)
 *   2. SWARM_SUBSTRATE_ENDPOINT (full URL)
 *   3. `substrate_url` in ~/.swarm/config.json
 *   4. SWARM_SUBSTRATE_PORT → http://localhost:<port>
 *   5. http://localhost:32338
 *
 * Meta endpoint: SWARM_META_ENDPOINT, then SWARM_META_PORT, then
 * http://localhost:32341.
 *
 * Resolution only reads: there is no port scan and nothing is written back to
 * ~/.swarm/config.json.
 */
import { readFileSync } from "node:fs";
import { resolveOllamaUrl } from "../embedder-settings.js";
import { collectLocalOnlyViolations, type LocalOnlyTargets, LocalOnlyViolation } from "../local-only.js";
import { DEFAULT_META_PORT, DEFAULT_SUBSTRATE_PORT, resolveSidecarSpecs, specFor, swarmConfigPath } from "./specs.js";

export { swarmConfigPath };

export interface ResolvedEndpoint {
  url: string;
  /** Which source in the chain won, for messages. */
  source: string;
}

/** `substrate_url` from ~/.swarm/config.json, or null. */
function readSavedSubstrateUrl(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(swarmConfigPath(), "utf-8")) as Record<string, unknown>;
    const url = cfg.substrate_url;
    if (typeof url === "string" && url.length > 0) return url;
  } catch {
    /* absent or unparseable */
  }
  return null;
}

/** The cold endpoint and the source that chose it (see the module doc for the chain). */
export function resolveSubstrateEndpointWithSource(explicit?: string): ResolvedEndpoint {
  if (explicit) return { url: explicit, source: "explicit endpoint" };
  const envEndpoint = process.env.SWARM_SUBSTRATE_ENDPOINT;
  if (envEndpoint?.length) return { url: envEndpoint, source: "SWARM_SUBSTRATE_ENDPOINT" };
  const saved = readSavedSubstrateUrl();
  if (saved) return { url: saved, source: `substrate_url in ${swarmConfigPath()}` };
  const envPort = process.env.SWARM_SUBSTRATE_PORT;
  if (envPort) return { url: `http://localhost:${envPort}`, source: "SWARM_SUBSTRATE_PORT" };
  return { url: `http://localhost:${DEFAULT_SUBSTRATE_PORT}`, source: "default" };
}

/** {@link resolveSubstrateEndpointWithSource}, URL only. */
export function resolveSubstrateEndpoint(explicit?: string): string {
  return resolveSubstrateEndpointWithSource(explicit).url;
}

/** The meta endpoint and the source that chose it. */
export function resolveMetaEndpointWithSource(): ResolvedEndpoint {
  const envEndpoint = process.env.SWARM_META_ENDPOINT;
  if (envEndpoint?.length) return { url: envEndpoint, source: "SWARM_META_ENDPOINT" };
  const envPort = process.env.SWARM_META_PORT;
  if (envPort) return { url: `http://localhost:${envPort}`, source: "SWARM_META_PORT" };
  return { url: `http://localhost:${DEFAULT_META_PORT}`, source: "default" };
}

/** {@link resolveMetaEndpointWithSource}, URL only. */
export function resolveMetaEndpoint(): string {
  return resolveMetaEndpointWithSource().url;
}

/**
 * Everything the context engine would connect to for this invocation: the cold
 * endpoint (and its source), the meta endpoint, both sidecars' Postgres, and
 * the Ollama embedder. The input to the `local_only` check. The cold Postgres
 * is the spec's, so a `postgres_url` saved in ~/.swarm/config.json is checked.
 */
export function resolveLocalOnlyTargets(explicit?: string): LocalOnlyTargets {
  const cold = resolveSubstrateEndpointWithSource(explicit);
  const specs = resolveSidecarSpecs();
  return {
    endpoint: cold.url,
    endpointSource: cold.source,
    metaEndpoint: resolveMetaEndpoint(),
    postgresUrl: specFor(specs, "cold").postgresUrl,
    metaPostgresUrl: specFor(specs, "meta").postgresUrl,
    ollamaUrl: resolveOllamaUrl(process.env),
  };
}

/**
 * Throw {@link LocalOnlyViolation} unless every target in
 * {@link resolveLocalOnlyTargets} is loopback. Callers invoke this only for a
 * `local_only` project.
 */
export function assertLocalOnly(explicit?: string): void {
  const violations = collectLocalOnlyViolations(resolveLocalOnlyTargets(explicit));
  if (violations.length > 0) throw new LocalOnlyViolation(violations);
}
