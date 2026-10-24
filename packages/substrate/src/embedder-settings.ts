/**
 * Which embedder the swarm's Substrate sidecars run, from the environment.
 * The lifecycle writes the result into each stack's
 * `substrate-recall.config.json` (see `lifecycle/stacks.ts`); Substrate's
 * recall plugin reads that file at boot, so these variables take effect on the
 * next sidecar start.
 *
 *   SWARM_EMBEDDER_KIND        `ollama` (default) or `none` (no embedder, no recall config)
 *   SWARM_EMBEDDER_OLLAMA_URL  default http://127.0.0.1:11434
 *   SWARM_EMBEDDER_MODEL       default nomic-embed-text
 *   SWARM_EMBEDDER_DIMENSION   default: the model's known size, else 768
 *   SWARM_EMBEDDER_TIMEOUT_MS  per-embed timeout for ranking queries, default 15 s
 *   SWARM_EMBED_ON_WRITE=1     the project asked for stored rows to be embedded
 */

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
const DEFAULT_DIMENSION = 768;

/** Vector sizes of the Ollama embedding models swarm knows by name. Any other needs SWARM_EMBEDDER_DIMENSION. */
export const KNOWN_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  "nomic-embed-text": 768,
  "bge-m3": 1024,
  "mxbai-embed-large": 1024,
  "snowflake-arctic-embed": 1024,
  "all-minilm": 384,
};

/**
 * How long one ranking query's embed may take before it fails. A hung Ollama
 * would otherwise hold every ranking query for Substrate's own default.
 */
export const DEFAULT_EMBED_TIMEOUT_MS = 15_000;

export type EmbedderKind = "ollama" | "none";

export interface EmbedderSettings {
  /** `none` runs no embedder: the stacks get no recall config at all. */
  kind: EmbedderKind;
  baseUrl: string;
  model: string;
  dimension: number;
  /** Per-embed timeout for ranking queries. */
  timeoutMs: number;
  /** Whether the project asked for stored rows to be embedded as they are written. */
  embedOnWrite: boolean;
}

/** The Ollama URL the embedder would contact, or `""` when the kind is `none`. */
export function resolveOllamaUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (resolveEmbedderKind(env) === "none") return "";
  return env.SWARM_EMBEDDER_OLLAMA_URL || DEFAULT_OLLAMA_URL;
}

function resolveEmbedderKind(env: NodeJS.ProcessEnv): EmbedderKind {
  const raw = env.SWARM_EMBEDDER_KIND?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "ollama") return "ollama";
  if (raw === "none") return "none";
  throw new Error(`SWARM_EMBEDDER_KIND must be "ollama" or "none" (got ${JSON.stringify(env.SWARM_EMBEDDER_KIND)})`);
}

/**
 * The sidecars' embedder from the environment (see the module doc). With none
 * set it is nomic-embed-text at 768 dimensions on the local Ollama.
 */
export function resolveEmbedderSettings(env: NodeJS.ProcessEnv = process.env): EmbedderSettings {
  const kind = resolveEmbedderKind(env);
  const baseUrl = env.SWARM_EMBEDDER_OLLAMA_URL || DEFAULT_OLLAMA_URL;
  const model = env.SWARM_EMBEDDER_MODEL || DEFAULT_OLLAMA_MODEL;
  const embedOnWrite = env.SWARM_EMBED_ON_WRITE === "1";
  let dimension: number;
  if (env.SWARM_EMBEDDER_DIMENSION) {
    dimension = Number(env.SWARM_EMBEDDER_DIMENSION);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`SWARM_EMBEDDER_DIMENSION must be a positive whole number (got ${JSON.stringify(env.SWARM_EMBEDDER_DIMENSION)})`);
    }
  } else {
    const known = KNOWN_EMBEDDING_DIMENSIONS[model.replace(/:latest$/, "")];
    if (known === undefined && model !== DEFAULT_OLLAMA_MODEL && embedOnWrite) {
      throw new Error(`swarm doesn't know the dimension of embedding model '${model}'; set SWARM_EMBEDDER_DIMENSION`);
    }
    dimension = known ?? DEFAULT_DIMENSION;
  }
  let timeoutMs = DEFAULT_EMBED_TIMEOUT_MS;
  if (env.SWARM_EMBEDDER_TIMEOUT_MS) {
    timeoutMs = Number(env.SWARM_EMBEDDER_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`SWARM_EMBEDDER_TIMEOUT_MS must be a positive whole number of milliseconds (got ${JSON.stringify(env.SWARM_EMBEDDER_TIMEOUT_MS)})`);
    }
  }
  return { kind, baseUrl, model, dimension, timeoutMs, embedOnWrite };
}
