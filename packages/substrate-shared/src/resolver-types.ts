/**
 * Request/response shapes for the custom swarm resolvers:
 *   - loadContext           (query)
 *   - classifyIntent        (query)
 *   - prepareTask           (query)
 *   - persistTaskTelemetry  (mutation)
 *
 * These types are deliberately self-contained: the primitives below are
 * duplicated from `@mnmal-ai/swarm-types` rather than imported, as they were in
 * the previous engine package, so this package has no dependencies and the plugin, its
 * client and core can all depend on it without a cycle. When the canonical
 * shapes in swarm-types change, mirror them here.
 *
 * They were moved here from the previous engine package.
 */

// ---------------------------------------------------------------------------
// Semantic recall tuning
// ---------------------------------------------------------------------------

/** Default top-K for the embedding leg of every UNION. Kept small: recall
 *  augments the keyword/path baseline, it does not flood it. */
export const RECALL_TOP_K = 8;

/**
 * The `SwarmConfig.category` the recall tuning knobs live under — sibling to
 * the existing `"budget"` category the loader reads. The sidecar reads this
 * category at boot to thread tuning values into the recall resolvers.
 */
export const RECALL_CONFIG_CATEGORY = "recall";

/**
 * `SwarmConfig.key` holding the cosine-similarity cutoff forwarded to the
 * recall resolvers as their similarity threshold. A tuning task (goal-12) edits
 * the row's `value`; the sidecar reads it at boot.
 */
export const RECALL_SIMILARITY_THRESHOLD_KEY = "recall_similarity_threshold";

/**
 * Production-default cosine-similarity cutoff, also the fallback when the
 * `recall` SwarmConfig knob is absent or unparseable. 0 = no filtering —
 * byte-identical to the pre-knob unfiltered path.
 *
 * This value is goal-12's swept-and-selected default. The threshold sweep
 * (docs/plans/2026-06-02-recall-quality.md) ran a {0.0..0.7} grid over the
 * labeled fixture set and found the knob *inert* on those full-preamble
 * fixtures (every grid point scored an identical TRAIN/TEST F1), so 0.0 was
 * selected — it is a member of the F1-peak tie, the v3 RecallConfig default,
 * and the honest no-cutoff baseline. The single source of truth: the read
 * fallback (server.ts readRecallSimilarityThreshold) and the seeded plugin
 * default (plugin.ts seedRecallConfigDefault) both resolve to this constant.
 */
export const RECALL_SIMILARITY_THRESHOLD_DEFAULT = 0;

/**
 * Coerce a stored `SwarmConfig.value` (always a string in storage, but typed
 * `unknown` off the raw dataset) into a usable similarity threshold. Non-finite
 * or missing input falls back to {@link RECALL_SIMILARITY_THRESHOLD_DEFAULT} (0)
 * so a corrupt/blank knob degrades to the no-cutoff path rather than poisoning
 * recall with a NaN threshold.
 *
 * Cosine similarity is bounded by `[0, 1]` (we don't allow negative-cosine
 * matches into the recall set), so values outside that range are clamped and
 * the original out-of-range value is logged once per call — a stored `-0.5`
 * silently passing through would have allowed negative matches and a stored
 * `1.5` would have disabled all recall with no warning.
 */
export function coerceSimilarityThreshold(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return RECALL_SIMILARITY_THRESHOLD_DEFAULT;
  if (parsed < 0 || parsed > 1) {
    console.warn(
      `[recall] similarityThreshold ${parsed} is outside the cosine-similarity range [0, 1] — clamping. Set SwarmConfig.recall_similarity_threshold to a value in [0, 1].`,
    );
    return Math.max(0, Math.min(1, parsed));
  }
  return parsed;
}

/** The swarm content type the corpus is embedded under. */
export const SWARM_CONTENT_TYPE = "SwarmContent";

// ---------------------------------------------------------------------------
// Shared primitives (local copies of swarm-types equivalents)
// ---------------------------------------------------------------------------

/** Mirror of `ContextTier` in `@mnmal-ai/swarm-types`. */
export type ContextTier =
  | "core"
  | "secrets"
  | "mode"
  | "oversight"
  | "capabilities"
  | "domain"
  | "skills_vetted"
  | "skills_community";

/** Mirror of `LoadingPriorityEntry` in `@mnmal-ai/swarm-types`. */
export interface LoadingPriorityEntry {
  tier: ContextTier;
  required: boolean;
  description?: string;
}

/**
 * The flattened route shape the assembler operates on. Mirror of `Route` in
 * `@mnmal-ai/swarm-types`. The loadContext resolver builds this from a stored
 * `SwarmRoute` entity (whose `contentPaths` / `keywords` are JSON strings).
 */
export interface RouteLike {
  intent: string;
  description: string;
  load: Record<string, string[]>;
  keywords: string[];
}

/**
 * A `SwarmContent` entity as returned from Substrate. Mirror of the `SubstrateSwarmContent`
 * shape in `packages/core/src/loader/index.ts`. `tokenEstimate` may arrive as a
 * string from the dataset layer; the assembler coerces it.
 */
export interface SwarmContentEntity {
  path: string;
  tier: string;
  intent: string;
  content: string;
  tokenEstimate: number | string;
  lastReviewed: string;
  projectId: string;
  sourceUrl?: string;
  fetchedAt?: string;
  skillName?: string;
}

/** Mirror of `LoadedFile` in `@mnmal-ai/swarm-types`. */
export interface LoadedFile {
  path: string;
  tier: ContextTier;
  content: string;
  estimatedTokens: number;
}

/** Mirror of `LoadResult` in `@mnmal-ai/swarm-types`. */
/** An optional-tier file the budget left out: what it would have cost. */
export interface OmittedFile {
  path: string;
  tier: ContextTier;
  estimatedTokens: number;
}

export interface LoadResult {
  files: LoadedFile[];
  totalTokens: number;
  budgetMax: number;
  budgetUsedPercent: number;
  truncated: string[];
  /** The budget drops in `truncated`, with their tier and size. */
  omitted?: OmittedFile[];
}

// ---------------------------------------------------------------------------
// loadContext (query)
// ---------------------------------------------------------------------------

export interface LoadContextRequest {
  intent: string;
  projectId: string;
  modelId: string;
  /**
   * The originating task prompt. Optional and additive: when supplied AND the
   * swarm plugin was wired with recall deps, `loadContext` augments the
   * path-selected content set with the top-K `SwarmContent` rows most
   * semantically similar to this prompt (deduped, budget-bounded). When absent,
   * the loader returns the byte-identical path-only result it always has —
   * existing callers (core `Swarm`) pass no prompt and see no change.
   */
  prompt?: string;
  /**
   * Fill the budget section by section from the `swarm-docs` namespace's
   * `Section` rows, for files that have them (stage 1 of the context-sections
   * spec). Ignored when the plugin has no `swarm-docs` dataset; files with no
   * stored sections load whole either way. Off unless the project turns on
   * `context.sections`.
   */
  sections?: boolean;
  /**
   * Also return the documents a session can read by section, in `documents`
   * (stage 2 of the context-sections spec). Needs `sections`; ignored without
   * it, or when the plugin has no `swarm-docs` dataset.
   */
  index?: boolean;
  /**
   * Rank this project's sections by similarity to `prompt` and add the
   * best-ranked ones the route didn't load, in rank order while they fit
   * (stage 3 of the context-sections spec). Needs `sections` and a `prompt`;
   * with no embedder, or nothing embedded yet, the context is what it would be
   * without ranking and `ranking` says why.
   */
  rank?: boolean;
  /** The most ranked sections `rank` adds; the rest stay index lines, in rank order. Default {@link DEFAULT_RANK_LIMIT}. */
  rankLimit?: number;
}

/** Ranked sections added per request unless `rankLimit` says otherwise. */
export const DEFAULT_RANK_LIMIT = 5;

/** What ranking did for one request (stage 3 of the context-sections spec). */
export interface SectionRanking {
  /**
   * `ranked`: sections were ranked against the prompt. `unavailable`: the
   * sidecar has no embedder, or the embed or search failed. `no-embeddings`:
   * nothing this project stores has a vector for the sidecar's model yet.
   */
  status: "ranked" | "unavailable" | "no-embeddings";
  /** Ranked sections that were candidates: in a complete set and not already loaded. */
  candidates: number;
  /** Ranked sections whose bodies were added. */
  loaded: number;
  /** Tokens those bodies cost. */
  tokens: number;
  /** The embedder model ranking used, e.g. `bge-m3:1024`, when there was one. */
  model?: string;
}

/** One section of an indexed document, as the index and the read guard use it. */
export interface IndexedSection {
  ordinal: number;
  /** Heading texts from level 2 down; empty for the text before the first heading. */
  headingPath: string[];
  synopsis: string;
  tokens: number;
  /** 1-based, inclusive line range in the document as stored. */
  startLine: number;
  endLine: number;
  /** Whether this section's body is already in the pushed context. */
  loaded: boolean;
  /** Cosine similarity to the task, when ranking placed this section among its top results. */
  score?: number;
}

/** A stored document whose sections the session can read by line range. */
export interface IndexedDocument {
  /** Relative to the swarm folder (source "swarm") or to the task checkout (source "project"). */
  path: string;
  source: "swarm" | "project";
  title: string;
  /** Total estimated tokens of the document. */
  tokens: number;
  /** sha256 of the document as stored (the Document row's contentHash). */
  contentHash: string;
  sections: IndexedSection[];
}

/** One entry in `loadContext`'s `filesIncluded` manifest. */
export interface LoadContextFile {
  path: string;
  tier: string;
  tokens: number;
}

/** The route the loader matched, surfaced for caller observability. */
export interface RouteMatched {
  intent: string;
  description: string;
}

export interface LoadContextResponse {
  /** Assembled markdown blob, ready to feed to the LLM. Byte-equal to the
   *  legacy loader's `assembleContext()` output. */
  content: string;
  filesIncluded: LoadContextFile[];
  tokensUsed: number;
  budgetTokens: number;
  /** Null when no route matched the requested intent. */
  routeMatched: RouteMatched | null;
  /**
   * Paths the resolver intentionally left out of the assembled context because
   * including them would have overflowed the model's budget. Always empty for
   * required tiers (required tiers throw if they can't fit — see invariant 1).
   * Mirrors the legacy `LoadResult.truncated` shape so callers (Swarm.run on
   * the Substrate-backed path) can pass it through to the `context:loaded` event
   * without diverging from the file-only path's behaviour.
   *
   * Includes both budget-truncated optional content paths AND any raw remote
   * `https://` skill URLs on the route that were not pre-seeded as SwarmContent
   * entities — the resolver has no skill-fetcher equivalent, so unseeded URLs
   * surface here instead of being silently dropped (the file-only path
   * sidesteps this by calling `SkillFetcher.prefetch` before the loader runs).
   */
  truncated: string[];
  /**
   * Optional-tier files the route matched that the budget left out, with the
   * tokens each would have cost. The budget-only subset of `truncated` (which
   * also names unseeded remote URLs), with sizes, so a session's record says
   * what the model never saw. Absent from sidecars older than this field.
   */
  omitted?: LoadContextFile[];
  /**
   * The documents the session can read by section, when the request asked for
   * an index: every project document with a complete set of sections, then
   * every swarm file on the route the budget cut part of. Absent otherwise.
   */
  documents?: IndexedDocument[];
  /** What ranking did, when the request asked for it. */
  ranking?: SectionRanking;
}

// ---------------------------------------------------------------------------
// classifyIntent (query)
// ---------------------------------------------------------------------------

export interface ClassifyIntentRequest {
  prompt: string;
  projectId: string;
}

/**
 * Mirror of `ClassificationResult.confidence` in `@mnmal-ai/swarm-types`.
 *
 * `"semantic"` is the embedding-recall tier: returned when keyword scoring
 * finds nothing but vector similarity over the `SwarmContent` corpus recovers
 * an intent the keywords missed. It ranks below `"keyword"` (which always wins
 * when any keyword matches) and above `"fallback"` — recall augments, never
 * replaces, the keyword path.
 */
export type ClassifyConfidence = "exact" | "keyword" | "semantic" | "fallback";

export interface ClassifyIntentResponse {
  intent: string;
  confidence: ClassifyConfidence;
  matchedKeywords: string[];
}

// ---------------------------------------------------------------------------
// persistTaskTelemetry (mutation)
// ---------------------------------------------------------------------------

/**
 * Create-mutation inputs for the four telemetry entity types. Fields mirror the
 * `swarm` namespace type definitions in the previous engine package minus the
 * autoCRUD-assigned `id`. Persisted atomically by the `persistTaskTelemetry`
 * resolver inside one `args.dataset.withTransaction`.
 */
export interface SessionEventInput {
  eventId: string;
  sessionId: string;
  role: string;
  provider: string;
  modelId: string;
  intent: string;
  swarmFilesLoaded: string;
  contextTokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /**
   * Author the telemetry row is attributed to — resolved once at session start
   * (env USER > git user.email > anonymous) and threaded through every write.
   * Optional: taxonomy now, enforcement deferred — a batch without authorId
   * still type-checks and persists. Indexed for future per-engineer reports.
   */
  authorId?: string;
  /**
   * The session's context record as JSON: `{budgetTokens, loaded, omitted}`,
   * each file with its tier and tokens. Absent when the session loaded no
   * swarm context.
   */
  contextDetail?: string;
  /**
   * How the session's Bash commands fared with fnl, as JSON (FnlCoverage):
   * build commands, how many fnl wrapped, the others by reason and by tool.
   * Absent when the session didn't count it.
   */
  fnlCoverage?: string;
  timestamp: string;
}

export interface TranscriptEntryInput {
  sessionId: string;
  role: string;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  /** Author attribution — see {@link SessionEventInput.authorId}. Optional. */
  authorId?: string;
  backend: string;
  timestamp: string;
}

export interface WorkerResultInput {
  sessionId: string;
  intent: string;
  output: string;
  diff: string;
  filesModified: string;
  /** Aggregate token count, retained for back-compat. The per-leg
   *  `inputTokens`/`outputTokens` below split it. */
  tokenUsage: number;
  /**
   * Provider + model that produced this result, plus the split token counts.
   * Optional so telemetry/oversight callers that don't populate them keep
   * compiling — persistTaskTelemetry fills them from the batch's SessionEvent.
   */
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Author attribution — see {@link SessionEventInput.authorId}. Optional. */
  authorId?: string;
  timestamp: string;
}

export interface ReviewVerdictInput {
  sessionId: string;
  workerResultId: string;
  verdict: string;
  reasons: string;
  suggestions: string;
  attempt: number;
  /** Author attribution — see {@link SessionEventInput.authorId}. Optional. */
  authorId?: string;
  timestamp: string;
}

export interface PersistTaskTelemetryRequest {
  sessionEvent: SessionEventInput;
  transcript: TranscriptEntryInput;
  workerResult: WorkerResultInput;
  reviewVerdict?: ReviewVerdictInput;
}

/** IDs assigned by autoCRUD to each written row. `reviewVerdict` is present only
 *  when the request carried one. */
export interface PersistTaskTelemetryResponse {
  ids: {
    sessionEvent: string;
    transcript: string;
    workerResult: string;
    reviewVerdict?: string;
  };
}

// ---------------------------------------------------------------------------
// prepareTask (query) — classifyIntent + loadContext + complexity in one trip
// ---------------------------------------------------------------------------

export interface PrepareTaskRequest {
  /** The task prompt to classify and assemble context for. */
  prompt: string;
  /** Project scope — substituted into {project} path placeholders. */
  projectId: string;
  /** Model id used to resolve the token budget. */
  modelId: string;
  /** Optional explicit intent override; forwarded to classifyIntent (its only
   *  path to confidence "exact"). */
  intentOverride?: string;
  /** Forwarded to loadContext; see {@link LoadContextRequest.sections}. */
  sections?: boolean;
  /** Forwarded to loadContext; see {@link LoadContextRequest.index}. */
  index?: boolean;
  /** Forwarded to loadContext; see {@link LoadContextRequest.rank}. */
  rank?: boolean;
  /** Forwarded to loadContext; see {@link LoadContextRequest.rankLimit}. */
  rankLimit?: number;
}

/**
 * The prepareTask envelope: the classifyIntent response (`intent`, `confidence`,
 * `matchedKeywords`) and the loadContext response (`content`, `filesIncluded`,
 * `tokensUsed`, `budgetTokens`, `routeMatched`) unioned, plus a derived
 * `complexity`. Every passed-through field is value-equal to what the two
 * standalone resolvers return for the same inputs — that parity is what lets a
 * thin SDK collapse three round trips into one.
 */
export interface PrepareTaskResponse {
  intent: string;
  confidence: ClassifyConfidence;
  matchedKeywords: string[];
  content: string;
  filesIncluded: LoadContextFile[];
  tokensUsed: number;
  budgetTokens: number;
  routeMatched: RouteMatched | null;
  /** Forwarded verbatim from `LoadContextResponse.truncated` — see that
   *  field's JSDoc for the budget-vs-unseeded-remote distinction. */
  truncated: string[];
  /** Forwarded verbatim from `LoadContextResponse.omitted`. */
  omitted?: LoadContextFile[];
  /** Forwarded from `LoadContextResponse.documents`, when present. */
  documents?: IndexedDocument[];
  /** Forwarded from `LoadContextResponse.ranking`, when present. */
  ranking?: SectionRanking;
  /** Bounded task-size estimate in [0, 1] for orchestrator sizing. */
  complexity: number;
}

// ---------------------------------------------------------------------------
// observe (swarm/createObservation) — cheap, fire-and-forget observation writes
// ---------------------------------------------------------------------------

/**
 * Fully-qualified op-key for the observation mutation. On Substrate the
 * `Observation` type lives in the swarm namespace (under the previous engine it sat in a
 * separate `plane` namespace). observe() targets this key REGARDLESS of the
 * client's configured namespace (the meta client is configured for
 * `swarm_meta`, the docs client for `swarm-docs`): observations always land on
 * the cold store, where the drainstop promotes them. Kept as a literal so the
 * thin client never imports the plugin.
 */
export const OBSERVE_OP_KEY = "swarm/createObservation";

/**
 * Response projection for `swarm/createObservation`. The created Observation's
 * id is all a fire-and-forget writer needs. Typed as `Record<string, true>`
 * (assignable to the client's `FieldSelection`) rather than importing
 * `FieldSelection` from the client, which would close an import cycle.
 */
export const OBSERVE_FIELDS: Record<string, true> = { id: true };

/**
 * Caller-facing shape for the client's `observe`. Ergonomic by design — the
 * client maps it onto the `createObservation` wire contract (`content` -> the
 * Observation `body` field, `tags[]` -> a comma-separated string, and the
 * always-present `ts`/`context` scalars filled in). Cheap, fire-and-forget
 * entries written by worker/reviewer/arbiter agents during execution.
 */
export interface ObserveRequest {
  /** Convention-typed kind, e.g. 'architectural' | 'concern' | 'rationale'. */
  kind: string;
  /** The observation itself (maps to the Observation `body` field). */
  content: string;
  /** Optional tags; joined to the Observation's comma-separated `tags` string. */
  tags?: string[];
  /**
   * Confidence 0-100. Omitted -> written as 0 ("just noting"). Never defaulted
   * to 50: the confidence=50 calibration anchor is library-seeded by the
   * drainstop and must not be overridden by an ordinary write.
   */
  confidence?: number;
}

/** What `swarm/createObservation` returns under {@link OBSERVE_FIELDS}. */
export interface ObserveResponse {
  id: string | number;
}
