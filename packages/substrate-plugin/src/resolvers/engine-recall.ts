/**
 * The swarm resolvers' reads that go through the engine handle rather than
 * the swarm namespace's own dataset:
 *
 *   - semantic recall, as `recall/Hit` frames to Substrate's recall plugin;
 *   - the docs namespace's `Document` / `Section` rows, as autoCRUD list frames.
 *
 * The engine does not exist while namespaces install, so both take a getter
 * the plugin fills in `onStart`, and read it at call time.
 *
 * Recall stays at parity with the previous resolvers' direct kNN search:
 *   - `boost: false`: a context read does not bump the hits' salience;
 *   - `lexical: false`: dense ranking only, with `score` the cosine similarity
 *     (with no lexical hits recall keeps cosine scores anyway, since none of
 *     the swarm types declares `lexical.source`; this makes it explicit);
 *   - `threshold` keeps its cosine meaning: recall drops hits scoring below it.
 */
import type { EngineHandle, PackEnvelope, RequestContext, Row } from "@mnmal-ai/substrate/sdk";
import type { DocsReader, DocsWhere } from "./load-context.js";
import type { SemanticHit, SemanticRecall } from "./recall.js";

/** The recall plugin's frame key for a semantic search. */
export const RECALL_HIT_KEY = "recall/Hit";

/** Page size for docs reads when the caller names none. */
const DOCS_PAGE_SIZE = 1000;

/** Pagination safety stop: more pages than this means a cursor that never ends. */
const MAX_DOCS_PAGES = 10_000;

function engineOrThrow(getEngine: () => EngineHandle | undefined, what: string): EngineHandle {
  const engine = getEngine();
  if (engine === undefined) throw new Error(`${what}: the engine has not started`);
  return engine;
}

/** Throw the envelope's first error for `key`, if there is one. */
function throwOnErrors(env: PackEnvelope, key: string): void {
  const errors = env.errors ?? [];
  if (errors.length === 0) return;
  const first = errors[0];
  const code = first?.code !== undefined ? `${first.code}: ` : "";
  throw new Error(`${key} failed: ${code}${first?.message ?? "unknown error"}`);
}

/**
 * A {@link SemanticRecall} that searches through the engine's `recall/Hit`
 * frame. Throws when the engine has not started, when recall refuses the
 * frame (no embedder, no recall plugin, a bad parameter) or when it answers
 * something other than a list of hits.
 */
export function makeEngineRecall(getEngine: () => EngineHandle | undefined): SemanticRecall {
  return {
    async search(args): Promise<SemanticHit[]> {
      const engine = engineOrThrow(getEngine, "swarm recall");
      // The frame surface spells the search text `to` (the HTTP route and the
      // MCP tool call it `query`, which the frame refuses).
      const params: Record<string, unknown> = {
        to: args.query,
        namespace: args.namespace,
        type: args.type,
        k: args.k,
        boost: false,
        lexical: false,
      };
      if (args.threshold !== undefined) params.threshold = args.threshold;
      if (args.where !== undefined) params.where = args.where;
      const env = await engine.query({
        frame: { [RECALL_HIT_KEY]: { params, fields: { id: true, score: true, row: args.rowFields } } },
        ctx: args.ctx ?? {},
      });
      throwOnErrors(env, RECALL_HIT_KEY);
      const hits = env.data[RECALL_HIT_KEY];
      if (!Array.isArray(hits)) {
        throw new Error(`${RECALL_HIT_KEY} answered ${hits === null ? "null" : typeof hits}, not a list of hits`);
      }
      return hits.map((hit: { id?: unknown; score?: unknown; row?: unknown }) => ({
        id: String(hit.id ?? ""),
        score: Number(hit.score),
        row: (hit.row ?? { id: String(hit.id ?? "") }) as Row,
      }));
    },
  };
}

/**
 * A {@link DocsReader} over the engine: each `read` is the docs type's autoCRUD
 * list query, followed page by page until the cursor runs out, asking for
 * `fields` (every declared field, so a SQL dataset returns whole rows).
 */
export function makeEngineDocsReader(
  getEngine: () => EngineHandle | undefined,
  namespace: string,
  fieldsByType: Record<"Document" | "Section", readonly string[]>,
  ctx: Partial<RequestContext> = {},
): DocsReader {
  return {
    namespace,
    async read(type, params: { where?: DocsWhere; limit?: number }): Promise<Row[]> {
      const engine = engineOrThrow(getEngine, `swarm docs read (${namespace}/${type})`);
      const key = `${namespace}/${type}`;
      const fields = Object.fromEntries(["id", ...fieldsByType[type]].map((f) => [f, true]));
      const rows: Row[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_DOCS_PAGES; page++) {
        const frameParams: Record<string, unknown> = { limit: params.limit ?? DOCS_PAGE_SIZE };
        if (params.where !== undefined) frameParams.where = params.where;
        if (cursor !== undefined) frameParams.cursor = cursor;
        const env = await engine.query({ frame: { [key]: { params: frameParams, fields } }, ctx });
        throwOnErrors(env, key);
        const data = env.data[key];
        if (!Array.isArray(data)) throw new Error(`${key} answered ${data === null ? "null" : typeof data}, not a list of rows`);
        rows.push(...(data as Row[]));
        const pagination = env._pagination?.[key];
        cursor = pagination?.hasMore === true ? pagination.nextCursor : undefined;
        if (cursor === undefined) return rows;
      }
      throw new Error(`${key}: more than ${MAX_DOCS_PAGES} pages; the cursor does not end`);
    },
  };
}
