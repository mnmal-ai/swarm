/**
 * `loadContext` — server-side query resolver for the swarm coordinator plugin.
 *
 * Collapses the legacy client-side context-loading round trips (Router.load +
 * Loader.load, several client query calls) into ONE resolver that runs inside
 * the Substrate engine. It reads the matching `SwarmRoute`, its `SwarmContent`
 * rows, and the `SwarmConfig` budget rows directly off the engine-injected
 * dataset, then delegates the budget-aware assembly to the pure helpers in
 * `./assemble.js`.
 *
 * Backend-neutral, pure data shaping: ZERO LLM calls and ZERO live HTTP. The
 * swarm rows come from `args.dataset.read(...)` — the per-call dataset handle
 * the engine injects (`ResolverArgs.dataset`); the docs namespace's rows come
 * through a {@link DocsReader} over the engine handle, and recall through a
 * {@link SwarmRecallDeps} search. The behaviour mirrors the legacy `Router` +
 * `Loader` byte-for-byte so cold-test parity holds.
 */

import {
  type SwarmContentEntity,
  type ContextTier,
  DEFAULT_RANK_LIMIT,
  type IndexedDocument,
  isLegacyScoped,
  type LoadContextFile,
  type LoadContextRequest,
  type LoadContextResponse,
  type LoadedFile,
  type LoadingPriorityEntry,
  type RouteLike,
  type SectionRanking,
  sectionLineRanges,
  selectProjectContent,
  selectProjectRoutes,
} from "@mnmal-ai/swarm-substrate-shared";
import { splitByTokens } from "@mnmal-ai/context-render";
import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver,
  WhereClause,
} from "@mnmal-ai/substrate/sdk";
import {
  assembleContext,
  assembleRouteContext,
  collectRoutePaths,
  filterByIntent,
  matchEntities,
  sectionLabel,
  type SectionUnit,
} from "./assemble.js";
import {
  type SwarmRecallDeps,
  rankSections,
  readSimilarityThreshold,
  recallSwarmContent,
  recallFor,
} from "./recall.js";

/**
 * Tier load order + required/optional flags. Structural and rarely changing, so
 * the legacy `Router.getLoadingPriority()` hardcodes it rather than storing it
 * as an entity — we mirror that here. Required tiers always load; optional
 * tiers load only while they fit the budget. `secrets` is intentionally absent
 * (it is never loaded into model context), matching the legacy list.
 */
const DEFAULT_LOADING_PRIORITY: LoadingPriorityEntry[] = [
  { tier: "core", required: true },
  { tier: "mode", required: true },
  { tier: "oversight", required: true },
  { tier: "capabilities", required: false },
  { tier: "domain", required: false },
  { tier: "skills_vetted", required: false },
  { tier: "skills_community", required: false },
];

/** Hardcoded safety net used when no budget config row is present. Mirrors the
 *  legacy `Router.getBudget` fallback. */
const DEFAULT_BUDGET_TOKENS = 15000;

/** Page size for the cursor-paginated full-table reads. Large enough to fetch a
 *  swarm's content set in a single page in practice, but we still drain the
 *  cursor so nothing is silently dropped (the "no dropped files" invariant below
 *  cannot catch rows missed by under-reading the substrate). */
const READ_PAGE_SIZE = 1000;

/**
 * Drain every row of `type` from the dataset, following the read cursor. The
 * legacy loader queried the full list in one HTTP call; `dataset.read` is paged,
 * so we loop until `hasMore` is false to preserve "read all rows" semantics.
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

/** Parse a JSON-string array field (`contentPaths`, `keywords`) into a
 *  `string[]`. Empty/missing yields `[]`; malformed JSON throws (a corrupt route
 *  row is a real error, not something to paper over). */
function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/**
 * Build the flattened `RouteLike` the assembler operates on from a stored
 * `SwarmRoute` row. Mirrors `Router.load`'s mapping: `contentPaths` (a JSON
 * string) becomes the route's single `load` group, `keywords` is parsed for
 * completeness even though context assembly does not use it.
 */
function toRouteLike(row: Row): RouteLike {
  return {
    intent: String(row.intent),
    description: typeof row.description === "string" ? row.description : "",
    keywords: parseJsonStringArray(row.keywords),
    load: { all: parseJsonStringArray(row.contentPaths) },
  };
}

/**
 * Resolve the model's context-token budget from the `SwarmConfig` budget rows.
 * Mirrors `Router.getBudget`: a `model_override:<modelId>` row wins, then a
 * `default_max_tokens` row, then the hardcoded fallback.
 */
function resolveModelBudget(modelId: string, configRows: Row[]): number {
  const budgetRows = configRows.filter((c) => c.category === "budget");
  const override = budgetRows.find((c) => c.key === `model_override:${modelId}`);
  if (override) return Number(override.value);
  const fallback = budgetRows.find((c) => c.key === "default_max_tokens");
  if (fallback) return Number(fallback.value);
  return DEFAULT_BUDGET_TOKENS;
}

/** Map a `SwarmContent` row (as returned by a recall hit) to the
 *  `SwarmContentEntity` shape the loader works with. Returns `null` when the row
 *  is missing the load-bearing `path`/`content` fields. */
function rowToContentEntity(row: Record<string, unknown>): SwarmContentEntity | null {
  const path = typeof row.path === "string" ? row.path : null;
  if (!path) return null;
  return {
    path,
    tier: typeof row.tier === "string" ? row.tier : "",
    intent: typeof row.intent === "string" ? row.intent : "",
    content: typeof row.content === "string" ? row.content : "",
    tokenEstimate:
      typeof row.tokenEstimate === "number" || typeof row.tokenEstimate === "string"
        ? row.tokenEstimate
        : 0,
    lastReviewed: typeof row.lastReviewed === "string" ? row.lastReviewed : "",
    projectId: typeof row.projectId === "string" ? row.projectId : "",
  };
}

/**
 * Phase 2 (additive): UNION the path-selected content with the top-K
 * `SwarmContent` rows most semantically similar to `prompt`. Runs ONLY when the
 * deployment wired recall deps and the caller passed a prompt; otherwise the
 * `assembled` result passes through byte-identically.
 *
 * Parity is preserved by construction: this only ever APPENDS files, never
 * removes one the path-based assembly already selected (so loadContext's
 * no-dropped-files invariant, checked on `assembled` before this runs, still
 * holds), and it only adds a file while it fits the model's token budget (so
 * the fit-budget invariant holds). Semantic files already present in the
 * path-selected set are deduped out; skill-tier rows are intent-filtered with
 * the same `filterByIntent` the path leg uses, keeping selection within-route.
 * Hits are consumed in knn-rank order (most similar first). The embeddings
 * store spans every project on the store, so hits the running project cannot
 * see (`canSee` false) are dropped first.
 */
async function augmentWithSemanticContent(
  assembled: {
    content: string;
    filesIncluded: LoadContextFile[];
    tokensUsed: number;
  },
  recall: SwarmRecallDeps,
  prompt: string,
  routeIntent: string,
  budgetTokens: number,
  canSee: (entity: SwarmContentEntity) => boolean,
): Promise<{
  content: string;
  filesIncluded: LoadContextFile[];
  tokensUsed: number;
}> {
  if (assembled.tokensUsed >= budgetTokens) return assembled;

  const hits = await recallSwarmContent(recall, prompt);
  if (hits.length === 0) return assembled;

  const includedPaths = new Set(assembled.filesIncluded.map((f) => f.path));
  const candidates: SwarmContentEntity[] = [];
  for (const hit of hits) {
    const entity = rowToContentEntity(hit.row);
    if (entity && canSee(entity) && !includedPaths.has(entity.path)) candidates.push(entity);
  }
  const eligible = filterByIntent(candidates, routeIntent);

  const extra: LoadedFile[] = [];
  let used = assembled.tokensUsed;
  for (const entity of eligible) {
    if (includedPaths.has(entity.path)) continue;
    const tokens =
      typeof entity.tokenEstimate === "string"
        ? Number(entity.tokenEstimate)
        : entity.tokenEstimate;
    if (!Number.isFinite(tokens) || tokens < 0) continue;
    if (used + tokens > budgetTokens) continue;
    extra.push({
      path: entity.path,
      tier: entity.tier as ContextTier,
      content: entity.content,
      estimatedTokens: tokens,
    });
    used += tokens;
    includedPaths.add(entity.path);
  }

  if (extra.length === 0) return assembled;

  const extraBlob = assembleContext(extra);
  return {
    content: assembled.content ? `${assembled.content}\n\n${extraBlob}` : extraBlob,
    filesIncluded: [
      ...assembled.filesIncluded,
      ...extra.map((f) => ({
        path: f.path,
        tier: f.tier,
        tokens: f.estimatedTokens,
      })),
    ],
    tokensUsed: used,
  };
}

/**
 * The `loadContext` query resolver (recall-aware factory).
 *
 * Reads route + content + budget off `args.dataset`, assembles the context via
 * the pure helper, and enforces two hard invariants (throw, never silently
 * truncate):
 *   1. `tokensUsed <= budgetTokens` — the assembled context must fit the budget.
 *      `assembleRouteContext` always loads required tiers regardless of budget,
 *      so a route whose required content alone overflows the budget is a
 *      misconfiguration we surface loudly rather than ship an over-budget blob.
 *   2. Every file the legacy loader would have included (every path that matched
 *      the route and passed intent filtering) appears in `filesIncluded` — i.e.
 *      nothing was dropped under budget pressure. Recomputed independently from
 *      the matched/intent-filtered set so it is a genuine cross-check, not a
 *      tautology against the assembler's own output.
 */
export function makeLoadContext(
  recall?: SwarmRecallDeps,
  docs?: DocsSource,
): TypedResolver<LoadContextResponse> {
  return async (
    ctx: RequestContext,
    args: ResolverArgs,
  ): Promise<LoadContextResponse> => {
    return loadContextImpl(ctx, args, recall && recallFor(recall, ctx), docs);
  };
}

/** The where-clause a docs read takes: field → predicate. */
export type DocsWhere = Record<string, { eq?: string | number | boolean | null }>;

/**
 * Reads the `swarm-docs` namespace (`Document` and `Section` rows) for a
 * request that asks for sections. The swarm namespace's resolvers are handed
 * only their own dataset, so the plugin implements this over the engine handle
 * (`./engine-recall.ts`).
 */
export interface DocsReader {
  /** The docs namespace, e.g. `swarm-docs`; section ranking searches it. */
  readonly namespace: string;
  /** Every row of `type` matching `where`, read `limit` rows a page. */
  read(type: "Document" | "Section", params: { where?: DocsWhere; limit?: number }): Promise<Row[]>;
}

/**
 * The docs reader for one request, made as the caller of `ctx`. A function,
 * because the reader goes through the engine, which only exists once the
 * plugin has started.
 */
export type DocsSource = (ctx?: Partial<RequestContext>) => Promise<DocsReader>;

/** Parse a stored `headingPath` (a JSON array of heading texts). */
function parseHeadingPath(value: unknown): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** A stored document's complete set of sections, with what the index needs of its Document. */
interface SectionSet {
  doc: { title: string; contentHash: string };
  sections: SectionUnit[];
}

/**
 * This project's documents from one source, with their sections, by path.
 * For `swarm`, sections are the on-disk `.swarm/` files as of the last sync;
 * SwarmContent rows come from the seed at run start, so both reflect the same
 * files, and a file with no usable sections loads from SwarmContent whole.
 * For `project`, they are the task checkout's documents as of the last sync.
 *
 * A file's sections are used only when they are a complete set (ordinals 0 to
 * n−1, once each) written for its Document's current `contentHash`. A sync
 * that failed part way, or a Document still pending its first write, leaves no
 * complete set, so that file loads whole (or isn't indexed) rather than in
 * part. Only the asked-for source counts: a project document at the same path
 * never stands in for a swarm file.
 */
async function readSectionSets(
  docs: DocsReader,
  projectId: string,
  source: "swarm" | "project",
): Promise<Map<string, SectionSet>> {
  const where: DocsWhere = { projectId: { eq: projectId }, source: { eq: source } };
  const docByPath = new Map<string, SectionSet["doc"]>();
  for (const doc of await docs.read("Document", { where, limit: READ_PAGE_SIZE })) {
    // The where-clause already scopes; check again so a dataset that ignores it
    // can never mix another project's or another source's rows in.
    if (doc.projectId !== projectId || doc.source !== source || typeof doc.path !== "string") continue;
    if (typeof doc.contentHash === "string" && doc.contentHash !== "") {
      docByPath.set(doc.path, { title: typeof doc.title === "string" ? doc.title : "", contentHash: doc.contentHash });
    }
  }
  const byPath = new Map<string, SectionUnit[]>();
  for (const row of await docs.read("Section", { where, limit: READ_PAGE_SIZE })) {
    if (row.projectId !== projectId || row.source !== source || typeof row.path !== "string") continue;
    const doc = docByPath.get(row.path);
    if (doc === undefined || row.documentHash !== doc.contentHash) continue;
    const tokens = Number(row.tokens);
    if (!Number.isFinite(tokens) || tokens < 0) continue;
    const unit: SectionUnit = {
      path: row.path,
      ordinal: Number(row.ordinal),
      headingPath: parseHeadingPath(row.headingPath),
      body: typeof row.body === "string" ? row.body : "",
      tokens,
      synopsis: typeof row.synopsis === "string" ? row.synopsis : "",
      contentHash: typeof row.contentHash === "string" ? row.contentHash : "",
    };
    const list = byPath.get(unit.path) ?? [];
    list.push(unit);
    byPath.set(unit.path, list);
  }
  const sets = new Map<string, SectionSet>();
  for (const [path, list] of byPath) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    if (list.every((s, i) => s.ordinal === i)) sets.set(path, { doc: docByPath.get(path)!, sections: list });
  }
  return sets;
}

/** A request's rankLimit, or the default when it is absent or not a positive whole number. */
function rankLimitOf(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_RANK_LIMIT;
}

/** How ranking names a section: `<source>:<path>#<ordinal>`. */
const sectionKey = (source: "swarm" | "project", path: string, ordinal: number): string => `${source}:${path}#${ordinal}`;

/** What ranking added to one request's context (stage 3 of the context-sections spec). */
interface RankedFill {
  ranking: SectionRanking;
  /** The added sections' blocks, in rank order, joined as assembleContext joins files. */
  content: string;
  files: LoadContextFile[];
  tokens: number;
  /** Ordinals ranking added, per source and path. */
  loaded: { swarm: Map<string, Set<number>>; project: Map<string, Set<number>> };
  /** Every ranked section's similarity, by {@link sectionKey}, loaded or not. */
  scores: Map<string, number>;
}

/**
 * Rank the project's sections against the prompt and add the best-ranked ones
 * the route didn't load, at most `limit` of them, in rank order while they fit
 * within `maxTokens` less `reserve`, stopping at the first one that doesn't (a smaller, lower-ranked
 * section is never pulled over it). Only sections in a complete set for their
 * Document's current hash count. Each added section is its own block, named by
 * its document and heading path, so the delimiter contract with the client
 * holds and the reader sees where it came from.
 */
async function rankAndFill(input: {
  recall: SwarmRecallDeps | undefined;
  namespace: string;
  projectId: string;
  prompt: string;
  sets: { swarm: ReadonlyMap<string, SectionSet>; project: ReadonlyMap<string, SectionSet> };
  routeLoaded: ReadonlyMap<string, ReadonlySet<number>>;
  maxTokens: number;
  reserve: number;
  /** The most sections added; the rest stay index lines. */
  limit: number;
}): Promise<RankedFill> {
  const loaded = { swarm: new Map<string, Set<number>>(), project: new Map<string, Set<number>>() };
  const scores = new Map<string, number>();
  const ranked = await rankSections(input.recall, { namespace: input.namespace, projectId: input.projectId, query: input.prompt });
  const empty = (status: SectionRanking["status"]): RankedFill => ({
    ranking: { status, candidates: 0, loaded: 0, tokens: 0, ...(ranked.model ? { model: ranked.model } : {}) },
    content: "",
    files: [],
    tokens: 0,
    loaded,
    scores,
  });
  if (ranked.status !== "ranked") return empty(ranked.status);

  const candidates: Array<{ source: "swarm" | "project"; unit: SectionUnit; tokens: number }> = [];
  const seen = new Set<string>();
  for (const { row, score } of ranked.hits) {
    const source = row.source === "swarm" || row.source === "project" ? row.source : undefined;
    if (source === undefined || typeof row.path !== "string") continue;
    const set = input.sets[source].get(row.path);
    if (set === undefined || row.documentHash !== set.doc.contentHash) continue;
    const unit = set.sections[Number(row.ordinal)];
    if (unit === undefined || unit.ordinal !== Number(row.ordinal)) continue;
    const key = sectionKey(source, unit.path, unit.ordinal);
    if (seen.has(key)) continue;
    seen.add(key);
    scores.set(key, score);
    if (source === "swarm" && input.routeLoaded.get(unit.path)?.has(unit.ordinal)) continue;
    candidates.push({ source, unit, tokens: unit.tokens });
  }

  const { top, spent } = splitByTokens(candidates.slice(0, input.limit), { maxTokens: input.maxTokens, reserve: input.reserve });
  for (const { source, unit } of top) {
    const set = loaded[source].get(unit.path) ?? new Set<number>();
    set.add(unit.ordinal);
    loaded[source].set(unit.path, set);
  }
  return {
    ranking: { status: "ranked", candidates: candidates.length, loaded: top.length, tokens: spent, ...(ranked.model ? { model: ranked.model } : {}) },
    content: top.map(({ unit }) => `--- swarm: ${sectionLabel(unit)} (ranked) ---\n${unit.body}`).join("\n\n"),
    files: top.map(({ unit }) => ({ path: sectionLabel(unit), tier: "ranked", tokens: unit.tokens })),
    tokens: spent,
    loaded,
    scores,
  };
}

/** A section set as the index lists it, with each section's line range. */
function toIndexed(
  path: string,
  source: "swarm" | "project",
  set: SectionSet,
  loaded: ReadonlySet<number>,
  scores?: ReadonlyMap<string, number>,
): IndexedDocument {
  const ranges = sectionLineRanges(set.sections.map((s) => s.body));
  return {
    path,
    source,
    title: set.doc.title,
    tokens: set.sections.reduce((n, s) => n + s.tokens, 0),
    contentHash: set.doc.contentHash,
    sections: set.sections.map((s, i) => ({
      ordinal: s.ordinal,
      headingPath: s.headingPath,
      synopsis: s.synopsis,
      tokens: s.tokens,
      startLine: ranges[i].startLine,
      endLine: ranges[i].endLine,
      loaded: loaded.has(s.ordinal),
      ...(scores?.has(sectionKey(source, path, s.ordinal)) ? { score: scores.get(sectionKey(source, path, s.ordinal)) } : {}),
    })),
  };
}

/**
 * The path-baseline loader with no recall deps. Behaviour is byte-for-byte the
 * legacy `Loader.load` + `assembleContext`. `prepareTask`, file-only mode, and
 * the existing test suite consume this; the recall-augmented variant is built
 * per-deployment via `makeLoadContext(recall)`.
 */
export const loadContext: TypedResolver<LoadContextResponse> = makeLoadContext();

async function loadContextImpl(
  ctx: RequestContext,
  args: ResolverArgs,
  recall: SwarmRecallDeps | undefined,
  docs?: DocsSource,
): Promise<LoadContextResponse> {
  const dataset = args.dataset;
  if (!dataset) {
    throw new Error(
      "loadContext: args.dataset is required — the engine must inject the per-call dataset handle",
    );
  }

  const params = (args.params ?? {}) as Partial<LoadContextRequest>;
  const { intent, modelId } = params;
  const projectId = params.projectId ?? "";
  if (!intent || !modelId) {
    throw new Error(
      `loadContext: 'intent' and 'modelId' params are required (got intent=${String(intent)}, modelId=${String(modelId)})`,
    );
  }

  // Budget rows are needed in every branch (including the no-route branch, so
  // the response still reports the real budget).
  const configRows = await readAllRows(dataset, "SwarmConfig", {
    category: { eq: "budget" },
  });
  const budgetTokens = resolveModelBudget(modelId, configRows);

  // Match the route by intent among the routes this project reads: its own
  // once it has synced any, else the legacy rows. Which set applies
  // depends on every route row, so read them all — a route table is small.
  const routeRows = selectProjectRoutes(
    await readAllRows(dataset, "SwarmRoute"),
    projectId || undefined,
  );
  const routeRow = routeRows.find((r) => r.intent === intent);
  if (!routeRow) {
    return {
      content: "",
      filesIncluded: [],
      tokensUsed: 0,
      budgetTokens,
      routeMatched: null,
      truncated: [],
      omitted: [],
    };
  }
  const route = toRouteLike(routeRow);

  // The legacy loader reads the full SwarmContent set and matches client-side
  // (including glob patterns), so we read all rows here too, then keep the ones
  // this project reads: its own row at a path, else the legacy one; never
  // another project's.
  const contentRows = await readAllRows(dataset, "SwarmContent");
  const entities = selectProjectContent(
    contentRows as unknown as SwarmContentEntity[],
    projectId || undefined,
  );

  // Stage 1 of the context-sections spec: when asked, and when this plugin
  // reads the swarm-docs namespace, fill the budget section by section.
  const docsReader = params.sections === true && projectId && docs ? await docs(ctx) : undefined;
  const swarmSets = docsReader ? await readSectionSets(docsReader, projectId, "swarm") : undefined;
  const sectionsByPath = swarmSets
    ? new Map([...swarmSets].map(([path, set]) => [path, set.sections] as const))
    : undefined;

  const assembled = assembleRouteContext({
    route,
    entities,
    budget: budgetTokens,
    priority: DEFAULT_LOADING_PRIORITY,
    projectId: projectId || undefined,
    sectionsByPath,
  });

  // Invariant 1: the assembled context must fit the model's budget.
  if (assembled.tokensUsed > budgetTokens) {
    throw new Error(
      `loadContext: assembled context (${assembled.tokensUsed} tokens) exceeds budget ` +
        `(${budgetTokens}) for intent '${intent}', model '${modelId}'. Required tiers alone ` +
        `overflow the budget — fix the budget config or the swarm content, do not truncate.`,
    );
  }

  // Invariant 2: no SILENTLY dropped files. Recompute the set the legacy loader
  // would have included (matched paths, intent-filtered, pre-budget) and assert
  // every one of them either landed in `filesIncluded` OR appears in the
  // assembler's `truncated` list. The legacy file-only path returns a non-empty
  // `truncated` for optional-tier files that exceed the budget; we surface the
  // same shape here so `Swarm.run` can forward it to the `context:loaded` event
  // verbatim. The throw stays in place for the genuine-missing case —
  // path-matched entities that vanished for any non-budget reason are still a
  // bug we want loud rather than degraded.
  const allRoutePaths = collectRoutePaths(route, projectId || undefined);
  const localPaths = allRoutePaths.filter((p) => !p.startsWith("https://"));
  const expectedPaths = filterByIntent(
    matchEntities(entities, localPaths),
    route.intent,
  ).map((e) => e.path);
  const includedPaths = new Set(assembled.filesIncluded.map((f) => f.path));
  const budgetTruncated = new Set(assembled.truncated);
  const dropped = expectedPaths.filter(
    (p) => !includedPaths.has(p) && !budgetTruncated.has(p),
  );
  if (dropped.length > 0) {
    throw new Error(
      `loadContext: ${dropped.length} file(s) the legacy loader would include were dropped for ` +
        `intent '${intent}' for non-budget reasons: ${dropped.join(", ")}. ` +
        `Budget-truncated optional files are returned in the response's truncated list; ` +
        `genuine-missing files are a configuration bug.`,
    );
  }

  // Unseeded remote skills: any raw `https://` URL on the route that did not
  // resolve to a SwarmContent entity is invisible to the assembler (the filter
  // above removes URLs before path matching). Surface them in `truncated` so
  // callers see the dropped surface rather than getting silent absence.
  // SkillFetcher on the file-only path fetches these before the loader runs;
  // the resolver has no equivalent server-side hook today.
  const seededRemotePaths = new Set(
    entities.map((e) => e.path).filter((p) => p.startsWith("https://")),
  );
  const unseededRemotes = allRoutePaths.filter(
    (p) => p.startsWith("https://") && !seededRemotePaths.has(p),
  );

  // Phase 2 (additive): when recall is wired AND the caller passed a prompt,
  // UNION the path-selected files with the top-K semantically-similar
  // SwarmContent rows, deduped + budget-bounded. Both invariants above were
  // checked on the path-only `assembled` and are preserved by construction (the
  // augmenter only appends within remaining budget). When recall/prompt are
  // absent, `final` IS `assembled` — byte-identical to the legacy loader.
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const ownPaths = new Set(
    entities.filter((e) => e.projectId === projectId).map((e) => e.path),
  );
  const canSee = (e: SwarmContentEntity): boolean =>
    !projectId || e.projectId === projectId || (isLegacyScoped(e) && !ownPaths.has(e.path));
  const loadedSections = assembled.loadedSections ?? new Map<string, Set<number>>();
  const rank = params.rank === true && docsReader !== undefined && swarmSets !== undefined;
  const projectSets = docsReader && (rank || params.index === true) ? await readSectionSets(docsReader, projectId, "project") : undefined;

  // Stage 3: rank the project's sections against the prompt and add the
  // best-ranked ones the route didn't load, leaving the index its quarter of
  // the budget. Ranking stands in for the whole-file recall below: swarm files
  // are stored by section, so a similar one arrives as its relevant sections.
  const ranked =
    rank && docsReader && swarmSets && projectSets
      ? await rankAndFill({
          recall,
          namespace: docsReader.namespace,
          projectId,
          prompt,
          sets: { swarm: swarmSets, project: projectSets },
          routeLoaded: loadedSections,
          maxTokens: Math.max(0, budgetTokens - assembled.tokensUsed),
          reserve: params.index === true ? Math.floor(budgetTokens / 4) : 0,
          limit: rankLimitOf(params.rankLimit),
        })
      : undefined;

  const final = ranked
    ? {
        content: ranked.content === "" ? assembled.content : assembled.content ? `${assembled.content}\n\n${ranked.content}` : ranked.content,
        filesIncluded: [...assembled.filesIncluded, ...ranked.files],
        tokensUsed: assembled.tokensUsed + ranked.tokens,
      }
    : recall && prompt
      ? await augmentWithSemanticContent(
          assembled,
          // The similarity cutoff is read now, so an edit to its SwarmConfig
          // row applies to this request.
          { ...recall, similarityThreshold: recall.similarityThreshold ?? (await readSimilarityThreshold(dataset)) },
          prompt,
          route.intent,
          budgetTokens,
          canSee,
        )
      : assembled;

  // Stage 2: the documents the session can read by section. Swarm files the
  // route loaded only in part (the rest is what the index offers), then every
  // project document with a complete set; each group by path. Sections ranking
  // added count as loaded, and ranked sections carry their score.
  let documents: IndexedDocument[] | undefined;
  if (params.index === true && docsReader && swarmSets && projectSets) {
    const onRoute = new Set([...assembled.filesIncluded.map((f) => f.path), ...assembled.truncated]);
    const byPath = (a: IndexedDocument, b: IndexedDocument) => a.path.localeCompare(b.path);
    const loadedFor = (source: "swarm" | "project", path: string): Set<number> =>
      new Set([...(source === "swarm" ? (loadedSections.get(path) ?? []) : []), ...(ranked?.loaded[source].get(path) ?? [])]);
    const swarmDocs: IndexedDocument[] = [];
    for (const [path, set] of swarmSets) {
      const loaded = loadedFor("swarm", path);
      if (onRoute.has(path) && loaded.size < set.sections.length) swarmDocs.push(toIndexed(path, "swarm", set, loaded, ranked?.scores));
    }
    const projectDocs = [...projectSets].map(([path, set]) => toIndexed(path, "project", set, loadedFor("project", path), ranked?.scores));
    documents = [...swarmDocs.sort(byPath), ...projectDocs.sort(byPath)];
  }

  return {
    content: final.content,
    filesIncluded: final.filesIncluded,
    tokensUsed: final.tokensUsed,
    budgetTokens,
    routeMatched: { intent: route.intent, description: route.description },
    truncated: [...assembled.truncated, ...unseededRemotes],
    omitted: assembled.omitted,
    ...(documents ? { documents } : {}),
    ...(ranked ? { ranking: ranked.ranking } : {}),
  };
}
