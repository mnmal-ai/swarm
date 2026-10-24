/**
 * `classifyIntent` — server-side query resolver for the swarm coordinator plugin.
 *
 * Ports the legacy `Router.classify()` keyword-scoring algorithm (see
 * `packages/core/src/router/index.ts`) into a resolver that runs inside the
 * Substrate engine, reading every `SwarmRoute` row directly off the
 * engine-injected dataset instead of the client-side query round trip.
 *
 * Backend-neutral, pure data shaping: ZERO LLM calls and ZERO live HTTP. The
 * keyword path's only I/O is `args.dataset.read(...)` — the per-call dataset
 * handle the engine injects (`ResolverArgs.dataset`). The scoring, precedence,
 * and fallback behaviour mirror `Router.classify()` exactly so cold-test parity
 * holds.
 *
 * The keyword scorer is the PRIMARY, deterministic path and is preserved
 * byte-for-byte. When the swarm plugin is wired with recall (a `recall/Hit`
 * search through the engine, see `./engine-recall.ts`), keyword-misses are
 * handed to an embedding-recall fallback that semantically matches the prompt
 * against the `SwarmContent` corpus and recovers the matched row's `intent`.
 * This is the UNION semantics the plan calls for — keyword always wins when it
 * matches; semantic only fills the gap keywords leave — so recall augments,
 * never replaces, the keyword path.
 */

import {
  type ClassifyConfidence,
  type ClassifyIntentRequest,
  type ClassifyIntentResponse,
  isLegacyScoped,
  selectProjectRoutes,
} from "@mnmal-ai/swarm-substrate-shared";
import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver,
  WhereClause,
} from "@mnmal-ai/substrate/sdk";
import { type SwarmRecallDeps, readSimilarityThreshold, recallSwarmContent, recallFor } from "./recall.js";

/**
 * Intent of the synthetic fallback route. Mirrors the `fallback` route the
 * legacy `Router.classify()` returns when no keyword matches — it is not a
 * stored `SwarmRoute`, so we name it here.
 */
const FALLBACK_INTENT = "fallback";

/** Page size for the cursor-paginated full-table read. Matches load-context.ts:
 *  large enough to fetch a swarm's route set in one page in practice, but we
 *  still drain the cursor so no route row is silently dropped. */
const READ_PAGE_SIZE = 1000;

/**
 * Drain every row of `type` from the dataset, following the read cursor. The
 * legacy router queried the full route list in one HTTP call; `dataset.read` is
 * paged, so we loop until `hasMore` is false to preserve "read all rows"
 * semantics. (Same helper shape as load-context.ts.)
 */
async function readAllRows(
  dataset: Dataset,
  type: string,
  where?: WhereClause,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const params: ReadParams = { limit: READ_PAGE_SIZE };
    if (where) params.where = where;
    if (cursor) params.cursor = cursor;
    const result = await dataset.read(type, params);
    rows.push(...result.rows);
    cursor = result.hasMore ? result.nextCursor : undefined;
  } while (cursor);
  return rows;
}

/** Parse a JSON-string array field (`keywords`) into a `string[]`. Empty/missing
 *  yields `[]`; malformed JSON throws (a corrupt route row is a real error, not
 *  something to paper over). Mirrors load-context.ts. */
function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/** The flattened route the scorer operates on: intent + parsed keyword list. */
interface ScoredRoute {
  intent: string;
  keywords: string[];
}

/**
 * Embedding-recall fallback: when keyword scoring finds nothing, semantically
 * match `prompt` against the `SwarmContent` corpus and recover an intent the
 * keywords missed. Each hit's `intent` field (a route intent, or a
 * comma-separated list for skill content) votes for its route, weighted by the
 * row's cosine score; the highest-voted REAL route wins. Returns `null` when
 * recall is disabled, errors (already swallowed to `[]` upstream), or yields no
 * hit that maps to a known route — leaving the caller on the static fallback.
 * The embeddings store spans every project on the store, so only the running
 * project's rows and legacy rows vote.
 */
async function classifyBySemanticRecall(
  recall: SwarmRecallDeps | undefined,
  prompt: string,
  validIntents: Set<string>,
  projectId: string,
): Promise<ClassifyIntentResponse | null> {
  const hits = await recallSwarmContent(recall, prompt, undefined, CLASSIFY_ROW_FIELDS);
  if (hits.length === 0) return null;

  const votes = new Map<string, number>();
  for (const hit of hits) {
    if (projectId && hit.row.projectId !== projectId && !isLegacyScoped(hit.row)) continue;
    const raw = typeof hit.row.intent === "string" ? hit.row.intent : "";
    for (const intent of raw.split(",").map((s) => s.trim())) {
      if (intent && validIntents.has(intent)) {
        votes.set(intent, (votes.get(intent) ?? 0) + hit.score);
      }
    }
  }

  let bestIntent: string | null = null;
  let bestVote = 0;
  for (const [intent, vote] of votes) {
    if (vote > bestVote) {
      bestVote = vote;
      bestIntent = intent;
    }
  }
  if (!bestIntent) return null;

  return {
    intent: bestIntent,
    confidence: "semantic" satisfies ClassifyConfidence,
    matchedKeywords: [],
  };
}

/** The `SwarmContent` fields a semantic vote reads. */
const CLASSIFY_ROW_FIELDS: Record<string, true> = { intent: true, projectId: true };

/** Build the scorer's view of a stored `SwarmRoute` row. */
function toScoredRoute(row: Row): ScoredRoute {
  return {
    intent: String(row.intent),
    keywords: parseJsonStringArray(row.keywords),
  };
}

/**
 * The `classifyIntent` query resolver.
 *
 * Reads every `SwarmRoute` off `args.dataset` and classifies `prompt` with the
 * exact strategy `Router.classify()` uses:
 *   1. Exact override — if an `intentOverride` param is supplied and names a real
 *      route, return it with confidence "exact" and no matched keywords. (The
 *      legacy classifier's only path to "exact"; the typed request carries it as
 *      an optional field on top of `{prompt, projectId}`.)
 *   2. Keyword scoring — score each route by how many of its keywords appear
 *      (case-insensitive substring) in the prompt. The highest-scoring route
 *      wins; ties resolve to the FIRST such route in dataset order, because the
 *      comparison is strictly-greater (`matched.length > bestScore`), exactly as
 *      the legacy loop does. A route with score > 0 returns confidence "keyword"
 *      and the keywords that drove the decision.
 *   3. Fallback — no keyword matched: return the `fallback` intent with
 *      confidence "fallback" and an empty `matchedKeywords`.
 */
export function makeClassifyIntent(
  recall?: SwarmRecallDeps,
): TypedResolver<ClassifyIntentResponse> {
  return async (
    ctx: RequestContext,
    args: ResolverArgs,
  ): Promise<ClassifyIntentResponse> => {
    return classifyIntentImpl(args, recall && recallFor(recall, ctx));
  };
}

/**
 * The keyword-baseline resolver with no recall deps. Behaviour is byte-for-byte
 * the legacy `Router.classify()` keyword path. `prepareTask`, file-only mode,
 * and the existing test suite consume this; the recall-augmented variant is
 * built per-deployment via `makeClassifyIntent(recall)`.
 */
export const classifyIntent: TypedResolver<ClassifyIntentResponse> =
  makeClassifyIntent();

async function classifyIntentImpl(
  args: ResolverArgs,
  recall: SwarmRecallDeps | undefined,
): Promise<ClassifyIntentResponse> {
  const dataset = args.dataset;
  if (!dataset) {
    throw new Error(
      "classifyIntent: args.dataset is required — the engine must inject the per-call dataset handle",
    );
  }

  // `intentOverride` is not on the canonical ClassifyIntentRequest shape but is
  // part of Router.classify's contract (the only path to "exact"); read it
  // optionally so callers that pin an intent keep byte-for-byte parity.
  const params = (args.params ?? {}) as Partial<ClassifyIntentRequest> & {
    intentOverride?: string;
  };
  const { prompt, intentOverride } = params;
  const projectId = params.projectId ?? "";
  if (typeof prompt !== "string") {
    throw new Error(
      `classifyIntent: 'prompt' param is required (got ${String(prompt)})`,
    );
  }

  // Read every route. Like load-context.ts, the legacy code read the full list,
  // so we drain the cursor rather than depend on a single page. Then keep the
  // routes this project reads: its own once it has synced any, else the legacy
  // rows — never another project's.
  const routeRows = selectProjectRoutes(
    await readAllRows(dataset, "SwarmRoute"),
    projectId || undefined,
  );
  const routes = routeRows.map(toScoredRoute);

  // 1. Exact override — skip classification when a named intent matches a route.
  if (intentOverride) {
    const route = routes.find((r) => r.intent === intentOverride);
    if (route) {
      return {
        intent: route.intent,
        confidence: "exact" satisfies ClassifyConfidence,
        matchedKeywords: [],
      };
    }
  }

  // 2. Keyword scoring. Strictly-greater comparison preserves first-route
  //    precedence on ties, matching the legacy loop.
  const promptLower = prompt.toLowerCase();
  let bestIntent: string | null = null;
  let bestScore = 0;
  let bestKeywords: string[] = [];

  for (const route of routes) {
    const matched: string[] = [];
    for (const keyword of route.keywords) {
      if (promptLower.includes(keyword.toLowerCase())) {
        matched.push(keyword);
      }
    }
    if (matched.length > bestScore) {
      bestScore = matched.length;
      bestIntent = route.intent;
      bestKeywords = matched;
    }
  }

  if (bestIntent && bestScore > 0) {
    return {
      intent: bestIntent,
      confidence: "keyword" satisfies ClassifyConfidence,
      matchedKeywords: bestKeywords,
    };
  }

  // 3. Semantic recall — no keyword matched. When the deployment wired recall
  //    deps, try to recover an intent by vector-matching the prompt against the
  //    SwarmContent corpus. Disabled / errored / no-match → null, and we drop
  //    to the static fallback below. This is the UNION's embedding leg: it runs
  //    ONLY after the keyword leg comes up empty, so the keyword path is never
  //    replaced (it is byte-for-byte preserved above). The similarity cutoff is
  //    read now, so an edit to its SwarmConfig row applies to this request.
  const validIntents = new Set(routes.map((r) => r.intent));
  const tuned = recall && {
    ...recall,
    similarityThreshold: recall.similarityThreshold ?? (await readSimilarityThreshold(dataset)),
  };
  const semantic = await classifyBySemanticRecall(tuned, prompt, validIntents, projectId);
  if (semantic) return semantic;

  // 4. Fallback — neither keyword nor semantic recall matched.
  return {
    intent: FALLBACK_INTENT,
    confidence: "fallback" satisfies ClassifyConfidence,
    matchedKeywords: [],
  };
}
