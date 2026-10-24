/**
 * SubstrateClient — HTTP client for the swarm's Substrate sidecars.
 *
 * Op-keys are fully namespaced (`<ns>/<name>`); the client adds the configured
 * namespace prefix so callers pass bare names. Defaults to the `swarm`
 * namespace; the meta store uses `swarm_meta`, the documents store `swarm-docs`.
 *
 * Substrate answers 200 with a per-frame `errors` array when it refuses a frame,
 * so every read of the envelope checks `errors` before `data`: a frame whose key
 * is missing from `data` throws {@link SubstrateFrameError} carrying the
 * server's code and message, rather than reading as empty.
 */

import { randomUUID } from "node:crypto";
import {
  docsNamespaceFor,
  OBSERVE_FIELDS,
  OBSERVE_OP_KEY,
  type ClassifyIntentRequest,
  type ClassifyIntentResponse,
  type LoadContextRequest,
  type LoadContextResponse,
  type ObserveRequest,
  type ObserveResponse,
  type PersistTaskTelemetryRequest,
  type PersistTaskTelemetryResponse,
  type PrepareTaskRequest,
  type PrepareTaskResponse,
} from "@mnmal-ai/swarm-substrate-shared";
import { HttpTransport, SubstrateHttpError } from "./transport/http-transport.js";
import type { IdempotencyKey, SubstrateResponseEnvelope } from "./transport/types.js";

// --- Public interface types ---

export interface FieldSelection {
  [field: string]: true | FieldSelection;
}

/**
 * One create-mutation in a {@link SubstrateClient.batchMutate} envelope.
 * `fields` defaults to `{ id: true }` (just the assigned id) when omitted.
 */
export interface BatchMutateOperation {
  mutationName: string;
  params: Record<string, unknown>;
  fields?: FieldSelection;
}

/**
 * Minimal query interface shared by SubstrateClient and FileQueryAdapter.
 * Router and Loader depend on this, not on SubstrateClient directly.
 */
export interface SwarmQueryClient {
  query<T>(
    typeName: string,
    params: Record<string, unknown>,
    fields: FieldSelection,
  ): Promise<T[]>;

  /**
   * Optional server-side context assembly (the `swarm/loadContext` resolver).
   * Present only on clients backed by a sidecar that serves the swarm plugin
   * (i.e. {@link SubstrateClient}). Consumers MUST feature-detect
   * (`if (client.loadContext)`) and fall back to the per-row `query`-driven
   * Router/Loader path when it is absent — `FileQueryAdapter` (file-only mode)
   * intentionally does not implement it.
   */
  loadContext?(args: LoadContextRequest): Promise<LoadContextResponse>;

  /**
   * Optional atomic telemetry persist (the `swarm/persistTaskTelemetry`
   * resolver). Same feature-detect + fall-back-to-per-row contract as
   * {@link loadContext}. When absent, callers write each telemetry row via
   * individual `mutate` calls (optionally batched through
   * {@link SubstrateClient.batchMutate}, the non-atomic fallback envelope).
   */
  persistTaskTelemetry?(
    args: PersistTaskTelemetryRequest,
  ): Promise<PersistTaskTelemetryResponse>;

  /**
   * Optional one-trip task prep (the `swarm/prepareTask` resolver):
   * classifyIntent + loadContext + complexity in a single call. Same
   * feature-detect + fall-back contract as {@link loadContext}.
   */
  prepareTask?(args: PrepareTaskRequest): Promise<PrepareTaskResponse>;
}

/** One namespace as `GET /substrate/v1/schema/<ns>` publishes it. */
export interface SubstrateNamespaceSchema {
  /**
   * Types keyed by name. Substrate publishes the custom query ops
   * (`loadContext`, `classifyIntent`, `prepareTask`) here too, beside the types.
   */
  types: Record<string, unknown>;
  /** Custom query ops, when a server publishes them separately; `{}` otherwise. */
  queries: Record<string, unknown>;
  /** Mutations keyed by name: autoCRUD plus `persistTaskTelemetry`. */
  mutations: Record<string, unknown>;
}

/**
 * The client's namespace and its documents namespace (`<ns>-docs`), as
 * published. The documents namespace is absent when the server does not serve
 * it (a meta or docs client has none).
 */
export interface SubstrateSchema {
  namespaces: Record<string, SubstrateNamespaceSchema>;
}

export interface SubstrateClientOptions {
  /**
   * Namespace prefix prepended to op-keys. Defaults to `swarm`. Use
   * `swarm_meta` for the meta-store client and `swarm-docs` for the documents
   * store.
   */
  namespace?: string;
  /**
   * Per-request timeout for query, mutate and schema reads, in milliseconds.
   * Default 30 s. (`isHealthy` always gives up after 2 s.)
   */
  timeoutMs?: number;
}

/** What {@link SubstrateClient.ingest} returns. */
export interface IngestResponse {
  accepted: number;
  typeName: string;
}

/** How long `isHealthy` waits for `/health`. */
export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * A frame Substrate refused, or one whose key came back missing from `data`.
 * `key` is the op-key (`<ns>/<name>`), `code` the server's error code
 * (`missing_key` when the server sent no error for it).
 */
export class SubstrateFrameError extends Error {
  override readonly name = "SubstrateFrameError";
  constructor(
    readonly key: string,
    readonly code: string,
    message: string,
  ) {
    super(`Substrate refused ${key} (${code}): ${message}`);
  }
}

// --- Custom-resolver field selections ---
//
// The custom resolvers return arbitrary objects; the request still carries a
// FieldSelection so the engine projects the full response shape. Each selection
// mirrors the corresponding response type in the shared package field for field
// — under-selecting would silently drop response data.

/** Every field of IndexedDocument and IndexedSection. */
const DOCUMENTS_FIELDS: FieldSelection = {
  path: true,
  source: true,
  title: true,
  tokens: true,
  contentHash: true,
  sections: {
    ordinal: true,
    headingPath: true,
    synopsis: true,
    tokens: true,
    startLine: true,
    endLine: true,
    loaded: true,
    score: true,
  },
};

/** What ranking did (context.ranking); present only when asked for with `rank`. */
const RANKING_FIELDS: FieldSelection = { status: true, candidates: true, loaded: true, tokens: true, model: true };

const LOAD_CONTEXT_FIELDS: FieldSelection = {
  content: true,
  filesIncluded: { path: true, tier: true, tokens: true },
  tokensUsed: true,
  budgetTokens: true,
  routeMatched: { intent: true, description: true },
  // Budget-truncated optional content + unseeded remote URLs. Required by the
  // Swarm.run `context:loaded` event payload (consumers like the CLI run banner
  // iterate `e.truncated`); omitting it from this selection lets the response
  // land with `truncated: undefined`, which crashes every swarm.run on
  // `e.truncated.length`. Mirrored in PREPARE_TASK_FIELDS below.
  truncated: true,
  // The budget drops in `truncated`, with tier and tokens; readers treat it as optional.
  omitted: { path: true, tier: true, tokens: true },
  // context.pull's document index, present only when asked for with `index`.
  // A field left out here never reaches swarm, whatever the resolver returns.
  documents: DOCUMENTS_FIELDS,
  ranking: RANKING_FIELDS,
};

const CLASSIFY_INTENT_FIELDS: FieldSelection = {
  intent: true,
  confidence: true,
  matchedKeywords: true,
};

/** The resolver answers `{ id: "ack", ids }`; the client wants the ids. */
const PERSIST_TASK_TELEMETRY_FIELDS: FieldSelection = {
  ids: {
    sessionEvent: true,
    transcript: true,
    workerResult: true,
    reviewVerdict: true,
  },
};

const PREPARE_TASK_FIELDS: FieldSelection = {
  intent: true,
  confidence: true,
  matchedKeywords: true,
  content: true,
  filesIncluded: { path: true, tier: true, tokens: true },
  tokensUsed: true,
  budgetTokens: true,
  routeMatched: { intent: true, description: true },
  // See LOAD_CONTEXT_FIELDS above — Swarm.run forwards `prepared.truncated`
  // straight into the `context:loaded` event payload.
  truncated: true,
  omitted: { path: true, tier: true, tokens: true },
  documents: DOCUMENTS_FIELDS,
  ranking: RANKING_FIELDS,
  complexity: true,
};

// --- Envelope reading ---

/** How many pages `query()` follows before refusing (100 rows a page by default). */
const MAX_QUERY_PAGES = 1_000;

/** The cursor of the next page for `key`, or null when the read is complete. */
function pagination(envelope: SubstrateResponseEnvelope, key: string): string | null {
  const pages = envelope._pagination as Record<string, { nextCursor?: unknown; hasMore?: unknown }> | undefined;
  const entry = pages?.[key];
  return entry?.hasMore === true && typeof entry.nextCursor === "string" && entry.nextCursor !== "" ? entry.nextCursor : null;
}

/**
 * The value for `key` in `envelope`, checking `errors` first: an error that
 * names `key` (by `path[0]`) throws; so does a key absent from `data`, with the
 * first unattributed error when there is one.
 */
function frameValue(envelope: SubstrateResponseEnvelope, key: string): unknown {
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  const own = errors.find((e) => e.path?.[0] === key);
  if (own !== undefined) throw new SubstrateFrameError(key, own.code ?? "error", own.message);
  const data = envelope.data;
  if (data === undefined || data === null || !Object.prototype.hasOwnProperty.call(data, key)) {
    const loose = errors.find((e) => e.path === undefined || e.path.length === 0);
    if (loose !== undefined) throw new SubstrateFrameError(key, loose.code ?? "error", loose.message);
    throw new SubstrateFrameError(key, "missing_key", "the response carried no data for this frame");
  }
  return data[key];
}

// --- Client ---

export class SubstrateClient {
  readonly #endpoint: string;
  readonly #namespace: string;
  readonly #transport: HttpTransport;
  #schemaCache: SubstrateSchema | null = null;

  constructor(endpoint: string, options?: SubstrateClientOptions) {
    this.#endpoint = endpoint.replace(/\/+$/, "");
    this.#namespace = options?.namespace ?? "swarm";
    this.#transport = new HttpTransport(this.#endpoint, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  // ---- Public API ----

  /** The endpoint this client talks to (trailing slashes removed). */
  get endpoint(): string {
    return this.#endpoint;
  }

  /** The namespace this client prefixes op-keys with. */
  get namespace(): string {
    return this.#namespace;
  }

  /**
   * POST /substrate/v1/query — list query for `typeName` in this client's
   * namespace. Returns an array (normalizes a single object, and a null value,
   * which Substrate answers for a frame with no rows).
   *
   * Substrate pages a list read that names no `limit` (100 rows by default) and
   * reports `_pagination[key].hasMore`. When the caller passes neither `limit`
   * nor `cursor`, this follows `nextCursor` and returns every row, as the previous engine's
   * unpaged list did; a caller that passes either gets that one page.
   */
  async query<T>(
    typeName: string,
    params: Record<string, unknown>,
    fields: FieldSelection,
  ): Promise<T[]> {
    const key = `${this.#namespace}/${typeName}`;
    const callerPages = params.limit !== undefined || params.cursor !== undefined;
    const rows: T[] = [];
    let pageParams = params;
    for (let page = 0; ; page++) {
      const envelope = await this.#transport.query({ [key]: { params: pageParams, fields } });
      const raw = frameValue(envelope, key);
      if (raw !== undefined && raw !== null) rows.push(...((Array.isArray(raw) ? raw : [raw]) as T[]));
      if (callerPages) return rows;
      const next = pagination(envelope, key);
      if (next === null) return rows;
      if (page + 1 >= MAX_QUERY_PAGES) {
        throw new SubstrateFrameError(
          key,
          "too_many_pages",
          `more than ${MAX_QUERY_PAGES} pages (${rows.length} rows so far); pass limit and cursor to page through it`,
        );
      }
      pageParams = { ...params, cursor: next };
    }
  }

  /** POST /substrate/v1/mutate — execute a named mutation in this client's namespace. */
  async mutate<T>(
    mutationName: string,
    params: Record<string, unknown>,
    fields: FieldSelection,
  ): Promise<T> {
    const key = `${this.#namespace}/${mutationName}`;
    const envelope = await this.#transport.mutate({ [key]: mutateEntry(params, fields, newIdempotencyKey()) });
    return frameValue(envelope, key) as T;
  }

  /**
   * POST /substrate/v1/query — invoke the `loadContext` query op in this
   * client's namespace and return its assembled context. It returns ONE
   * object, not a list, so it is read directly rather than via `query()`.
   */
  async loadContext(args: LoadContextRequest): Promise<LoadContextResponse> {
    const key = `${this.#namespace}/loadContext`;
    const envelope = await this.#transport.query({ [key]: { params: args, fields: LOAD_CONTEXT_FIELDS } });
    return frameValue(envelope, key) as LoadContextResponse;
  }

  /**
   * POST /substrate/v1/query — invoke the `classifyIntent` query op and return
   * the matched intent + confidence.
   *
   * `intentOverride` is the resolver's only path to `confidence: 'exact'`: when
   * supplied and it names a real route, keyword scoring is skipped. It is not on
   * the canonical {@link ClassifyIntentRequest} shape, so it is accepted as an
   * optional extra here to preserve the legacy `Router.classify` contract.
   */
  async classifyIntent(
    args: ClassifyIntentRequest & { intentOverride?: string },
  ): Promise<ClassifyIntentResponse> {
    const key = `${this.#namespace}/classifyIntent`;
    const envelope = await this.#transport.query({ [key]: { params: args, fields: CLASSIFY_INTENT_FIELDS } });
    return frameValue(envelope, key) as ClassifyIntentResponse;
  }

  /**
   * POST /substrate/v1/mutate — invoke the `persistTaskTelemetry` mutation,
   * which writes SessionEvent + TranscriptEntry + WorkerResult (+ optional
   * ReviewVerdict) inside the engine's mutate transaction. The resolver answers
   * `{ id: "ack", ids }`; this returns `{ ids }`.
   *
   * This is the preferred (atomic) telemetry path. When the server resolver is
   * unavailable, use {@link batchMutate} as the documented non-atomic fallback.
   */
  async persistTaskTelemetry(
    args: PersistTaskTelemetryRequest,
  ): Promise<PersistTaskTelemetryResponse> {
    const key = `${this.#namespace}/persistTaskTelemetry`;
    const envelope = await this.#transport.mutate({
      [key]: mutateEntry(args, PERSIST_TASK_TELEMETRY_FIELDS, newIdempotencyKey()),
    });
    const raw = frameValue(envelope, key) as { ids?: PersistTaskTelemetryResponse["ids"] } | null;
    if (raw?.ids === undefined) {
      throw new SubstrateFrameError(key, "missing_ids", "the response carried no ids");
    }
    return { ids: raw.ids };
  }

  /**
   * POST /substrate/v1/mutate — write a cheap, fire-and-forget Observation via
   * `swarm/createObservation`, mapping the ergonomic
   * `{ kind, content, tags?, confidence? }` shape onto the wire contract.
   *
   * Targets {@link OBSERVE_OP_KEY} REGARDLESS of this client's configured
   * namespace: observations always land in the swarm namespace, where the
   * drainstop later promotes high-signal ones into the context store.
   *
   * Fire-and-forget: a failure must never break the caller's hot path, so the
   * whole write is wrapped — on any error (transport, non-ok status, refused
   * frame) it is swallowed, logged (kind + message only; observation content may
   * carry PII), and `null` is returned.
   *
   * `ts` (now) and `context` ("") are filled here; `tags` rides as a
   * comma-separated string; an unset `confidence` is written as 0 ("just
   * noting"). The confidence=50 calibration anchor is seeded by the drainstop —
   * observe() never writes `isAnchor`.
   */
  async observe(request: ObserveRequest): Promise<ObserveResponse | null> {
    const params = {
      ts: new Date().toISOString(),
      kind: request.kind,
      body: request.content,
      context: "",
      confidence: request.confidence ?? 0,
      tags: (request.tags ?? []).join(","),
      ttlHours: null,
    };
    try {
      const envelope = await this.#transport.mutate({
        [OBSERVE_OP_KEY]: mutateEntry(params, OBSERVE_FIELDS, newIdempotencyKey()),
      });
      return (frameValue(envelope, OBSERVE_OP_KEY) ?? null) as ObserveResponse | null;
    } catch (error) {
      console.warn(
        `[substrate] observe() dropped an observation (kind=${request.kind}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * POST /substrate/v1/query — invoke the `prepareTask` query op, which
   * composes classifyIntent + loadContext + complexity server-side and returns
   * the whole envelope in one round trip.
   */
  async prepareTask(args: PrepareTaskRequest): Promise<PrepareTaskResponse> {
    const key = `${this.#namespace}/prepareTask`;
    const envelope = await this.#transport.query({ [key]: { params: args, fields: PREPARE_TASK_FIELDS } });
    return frameValue(envelope, key) as PrepareTaskResponse;
  }

  /**
   * POST /substrate/v1/mutate — run several named mutations in ONE request,
   * returning the `data` map keyed by the namespaced op-key
   * (`<ns>/<mutationName>`). Throws {@link SubstrateFrameError} for the first
   * operation the server refused.
   *
   * DOCUMENTED FALLBACK ONLY: the client-side batched-telemetry path for when the
   * `persistTaskTelemetry` resolver is unavailable. Prefer
   * {@link persistTaskTelemetry} whenever it exists. Op-keys must be distinct (a
   * repeated `mutationName` would collide on the same envelope key).
   */
  async batchMutate<T extends Record<string, unknown> = Record<string, unknown>>(
    operations: BatchMutateOperation[],
  ): Promise<T> {
    // One envelope = one round trip = ONE idempotency key on every entry: the
    // engine refuses an envelope whose entries carry different keys.
    const idempotencyKey = newIdempotencyKey();
    const body: Record<string, MutateEntry> = {};
    for (const op of operations) {
      body[`${this.#namespace}/${op.mutationName}`] = mutateEntry(op.params, op.fields ?? { id: true }, idempotencyKey);
    }
    const envelope = await this.#transport.mutate(body);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(body)) result[key] = frameValue(envelope, key);
    return result as T;
  }

  /**
   * GET /substrate/v1/schema/<ns> for this client's namespace and its documents
   * namespace. Cached until {@link invalidateSchema}. Throws when the server
   * does not serve this client's own namespace; the documents namespace is left
   * out when the server answers 404 for it.
   */
  async getSchema(): Promise<SubstrateSchema> {
    if (this.#schemaCache) return this.#schemaCache;
    const own = await this.#fetchNamespaceSchema(this.#namespace);
    if (own === null) {
      throw new Error(`Namespace '${this.#namespace}' not found at ${this.#endpoint} (GET /substrate/v1/schema/${this.#namespace} answered 404)`);
    }
    const namespaces: Record<string, SubstrateNamespaceSchema> = { [this.#namespace]: own };
    const docsNs = docsNamespaceFor(this.#namespace);
    const docs = await this.#fetchNamespaceSchema(docsNs);
    if (docs !== null) namespaces[docsNs] = docs;
    this.#schemaCache = { namespaces };
    return this.#schemaCache;
  }

  /** Whether this client's namespace publishes `typeName`. */
  async hasType(typeName: string): Promise<boolean> {
    const schema = await this.getSchema();
    return typeName in (schema.namespaces[this.#namespace]?.types ?? {});
  }

  invalidateSchema(): void {
    this.#schemaCache = null;
  }

  /**
   * Bulk-create entities of `typeName` through the autoCRUD `create<Type>`
   * mutation, one per row. Mode `replace` deletes all existing rows of the type
   * before inserting (use carefully).
   */
  async ingest(
    typeName: string,
    data: Record<string, unknown>[],
    mode: "create" | "extend" | "replace" = "create",
  ): Promise<IngestResponse> {
    if (mode === "replace") {
      // Don't swallow query failure — a failed read here would silently
      // turn `replace` into `extend`, dumping new rows on top of whatever
      // happens to be there.
      const existing = await this.query<{ id: string | number }>(typeName, {}, { id: true });
      const deleteErrors: string[] = [];
      for (const row of existing) {
        if (row.id !== undefined && row.id !== null) {
          try {
            await this.mutate(`delete${typeName}`, { id: row.id }, { id: true });
          } catch (err) {
            deleteErrors.push(`id=${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (deleteErrors.length > 0) {
        throw new Error(
          `replace ingest for ${typeName}: ${deleteErrors.length} delete(s) failed — ` +
            `store may be partially cleared. Re-run or use extend. First error: ${deleteErrors[0]}`,
        );
      }
    }
    let accepted = 0;
    for (const row of data) {
      await this.mutate(`create${typeName}`, row, { id: true });
      accepted++;
    }
    return { accepted, typeName };
  }

  /** Nothing to release over stateless HTTP. Idempotent, synchronous. */
  close(): void {
    this.#transport.close();
  }

  /** GET /health — sidecar liveness. False on any failure, or no answer within 2 s. */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#endpoint}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ---- Private ----

  /** One namespace's published schema, or null when the server answers 404. */
  async #fetchNamespaceSchema(ns: string): Promise<SubstrateNamespaceSchema | null> {
    let raw: SubstrateResponseEnvelope;
    try {
      raw = await this.#transport.get(`/substrate/v1/schema/${encodeURIComponent(ns)}`);
    } catch (err) {
      if (err instanceof SubstrateHttpError && err.status === 404) return null;
      throw err;
    }
    const record = (v: unknown): Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return { types: record(raw.types), queries: record(raw.queries), mutations: record(raw.mutations) };
  }
}

/** One entry of a mutate frame: the de-dupe key sits beside `params`, never inside it. */
interface MutateEntry {
  params: Record<string, unknown>;
  fields: FieldSelection;
  idempotencyKey: IdempotencyKey;
}

function mutateEntry(params: object, fields: FieldSelection, idempotencyKey: IdempotencyKey): MutateEntry {
  return { params: params as Record<string, unknown>, fields, idempotencyKey };
}

/**
 * A fresh de-dupe key for one mutate envelope. Substrate caches the envelope
 * under it, so a replay of the same request returns the first answer; distinct
 * logical writes must not collapse onto one another, so every call mints a
 * new one.
 */
function newIdempotencyKey(): IdempotencyKey {
  return randomUUID() as IdempotencyKey;
}
