/**
 * Shared embedding-recall helper for the swarm coordinator resolvers.
 *
 * Wraps one semantic lookup — a `SemanticRecall.search`, which the plugin
 * implements as a `recall/Hit` frame through the engine (`./engine-recall.ts`)
 * — behind a single graceful-degrade call. EVERY failure path (no embedder,
 * recall plugin absent, embedder down at query time, store error) is
 * swallowed: the helper logs a one-line warning and returns `[]`, so the
 * calling resolver falls back to its keyword/path baseline. Recall augments,
 * it never breaks, the deterministic path.
 *
 * No `args.dataset` access happens here: the resolvers hand in the recall
 * handle, and the embedder, its model and the embeddings store all live in
 * Substrate's recall plugin.
 */

import {
  SWARM_CONTENT_TYPE,
  SWARM_NAMESPACE,
  coerceSimilarityThreshold,
  RECALL_CONFIG_CATEGORY,
  RECALL_SIMILARITY_THRESHOLD_KEY,
  RECALL_TOP_K,
} from "@mnmal-ai/swarm-substrate-shared";
import type { Dataset, RequestContext, Row } from "@mnmal-ai/substrate/sdk";

/** One recalled row plus its cosine score. */
export interface SemanticHit {
  /** The row's id. */
  id: string;
  /** The row body, narrowed to `id` plus the requested `rowFields`. */
  row: Row;
  /** Cosine similarity in [0, 1] — higher is closer. */
  score: number;
}

/** A recall filter applied inside the search: field → `{ eq }` or `{ in }`, every field must match. */
export type SemanticWhere = Record<
  string,
  { eq?: string | number | boolean | null; in?: Array<string | number | boolean | null> }
>;

export interface SemanticSearchArgs {
  namespace: string;
  type: string;
  /** The text to search for. */
  query: string;
  /** Most hits to return (recall caps at 100). */
  k: number;
  /** Minimum cosine similarity a hit must reach. Absent: no cutoff. */
  threshold?: number;
  /** Restrict candidates to rows whose fields match, inside the search. */
  where?: SemanticWhere;
  /** The row fields each hit carries (`id` always), or `true` for the whole row. */
  rowFields: Record<string, true> | true;
  /** The caller's request context, so recall is policy-checked as the caller. */
  ctx?: Partial<RequestContext>;
}

/**
 * Dense semantic search over one type's stored vectors, ranked by cosine
 * similarity. Implementations throw on failure; {@link recallSwarmContent}
 * and {@link rankSections} turn a throw into their degraded result.
 */
export interface SemanticRecall {
  search(args: SemanticSearchArgs): Promise<SemanticHit[]>;
  /**
   * The embedder model the search runs under, when the implementation knows
   * it. Reported in `ranking.model`. The engine's `recall/Hit` frame does not
   * report it, so the engine-backed recall leaves it unset.
   */
  readonly model?: string;
}

/**
 * The recall handle the swarm resolvers take: a {@link SemanticRecall} plus
 * the knobs the content recall uses. Every knob is optional, so a bare
 * `SemanticRecall` is a valid `SwarmRecallDeps`.
 */
export interface SwarmRecallDeps extends SemanticRecall {
  /** Namespace the swarm types live under. Defaults to `"swarm"`. */
  namespace?: string;
  /** Max content hits to pull per recall. Defaults to RECALL_TOP_K. */
  topK?: number;
  /**
   * Minimum cosine similarity (0..1) a content hit must clear. Undefined: no
   * cutoff. The resolvers fill it per call from the `recall` category's
   * `recall_similarity_threshold` SwarmConfig row unless it is pinned here.
   */
  similarityThreshold?: number;
}

/** The `SwarmContent` fields the resolvers read off a recalled row. */
export const CONTENT_ROW_FIELDS: Record<string, true> = {
  path: true,
  tier: true,
  intent: true,
  content: true,
  tokenEstimate: true,
  lastReviewed: true,
  projectId: true,
};

/** The `Section` fields section ranking reads off a recalled row. */
export const SECTION_ROW_FIELDS: Record<string, true> = {
  projectId: true,
  source: true,
  path: true,
  ordinal: true,
  documentHash: true,
};

/**
 * `recall` with every search made as the caller of `ctx`, unless a search
 * names its own context.
 */
export function recallFor(recall: SwarmRecallDeps, ctx: Partial<RequestContext>): SwarmRecallDeps {
  return { ...recall, model: recall.model, search: (args) => recall.search({ ...args, ctx: args.ctx ?? ctx }) };
}

/**
 * The `recall_similarity_threshold` SwarmConfig row (category `recall`), read
 * when the request is made so a tuning edit applies to the next request.
 * Undefined when there is no row, or when it cannot be read: recall then runs
 * with no cutoff.
 */
export async function readSimilarityThreshold(dataset: Dataset): Promise<number | undefined> {
  try {
    const { rows } = await dataset.read("SwarmConfig", { where: { category: { eq: RECALL_CONFIG_CATEGORY } } });
    const row = rows.find((r) => r.key === RECALL_SIMILARITY_THRESHOLD_KEY);
    return row === undefined ? undefined : coerceSimilarityThreshold(row.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[swarm-recall] could not read '${RECALL_SIMILARITY_THRESHOLD_KEY}', recalling with no cutoff: ${msg}`);
    return undefined;
  }
}

/**
 * Return the top-K `SwarmContent` rows most similar to `query`, ranked by
 * cosine similarity. Returns `[]` (never throws) when `recall` is absent or
 * the search fails — the caller then proceeds keyword/path-only.
 *
 * @param recall     the recall handle; `undefined` → recall disabled.
 * @param query      the task prompt to search for.
 * @param k          max hits; defaults to `recall.topK` then `RECALL_TOP_K`.
 * @param rowFields  the row fields each hit carries; defaults to every field the loader reads.
 */
export async function recallSwarmContent(
  recall: SwarmRecallDeps | undefined,
  query: string,
  k?: number,
  rowFields: Record<string, true> = CONTENT_ROW_FIELDS,
): Promise<SemanticHit[]> {
  if (!recall) return [];
  if (typeof query !== "string" || query.trim() === "") return [];

  const namespace = recall.namespace ?? SWARM_NAMESPACE;
  const limit = k ?? recall.topK ?? RECALL_TOP_K;

  try {
    return await recall.search({
      namespace,
      type: SWARM_CONTENT_TYPE,
      query,
      k: limit,
      // The configured cosine cutoff. Undefined → recall's default of 0 (no
      // cutoff), so the unfiltered path is unchanged.
      threshold: recall.similarityThreshold,
      rowFields,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Graceful degrade (constraint): keyword/path baseline still serves the
    // request. Warn once so a persistently-down embedder is visible in logs.
    console.warn(
      `[swarm-recall] semantic recall unavailable, falling back to keyword/path only: ${msg}`,
    );
    return [];
  }
}

/** Sections ranking keeps per request (stage 3 of the context-sections spec). */
export const SECTION_RANK_K = 40;
/**
 * Sections asked of recall. The search is limited to the project's own rows
 * and recall caps at 100, so swarm asks for that many and keeps the best
 * {@link SECTION_RANK_K}.
 */
export const SECTION_SEARCH_K = 100;

/** One ranked `Section` row and its cosine similarity to the task. */
export interface RankedSectionHit {
  row: Row;
  score: number;
}

/**
 * This project's sections most similar to `query`, best first, at most
 * {@link SECTION_RANK_K}. Never throws: with no recall, or when the search
 * fails (no embedder, embedder down), the status is `unavailable`; when the
 * project has no vectors yet, it is `no-embeddings`. Either way the caller
 * keeps the context it had without ranking.
 */
export async function rankSections(
  recall: SemanticRecall | undefined,
  opts: { namespace: string; projectId: string; query: string; k?: number },
): Promise<{ status: "ranked" | "unavailable" | "no-embeddings"; hits: RankedSectionHit[]; model?: string }> {
  if (!recall || opts.query.trim() === "") return { status: "unavailable", hits: [] };
  const model = recall.model;
  const withModel = model !== undefined ? { model } : {};
  try {
    const results = await recall.search({
      namespace: opts.namespace,
      type: "Section",
      query: opts.query,
      k: SECTION_SEARCH_K,
      where: { projectId: { eq: opts.projectId } },
      rowFields: SECTION_ROW_FIELDS,
    });
    // The filter already scopes to the project; check again so a recall that
    // ignores it can never mix another project's sections in.
    const hits = results
      .filter((r) => r.row.projectId === opts.projectId)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.k ?? SECTION_RANK_K)
      .map((r) => ({ row: r.row, score: r.score }));
    return hits.length > 0 ? { status: "ranked", hits, ...withModel } : { status: "no-embeddings", hits: [], ...withModel };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[swarm-recall] section ranking unavailable, keeping path order: ${msg}`);
    return { status: "unavailable", hits: [], ...withModel };
  }
}
