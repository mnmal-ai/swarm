/**
 * Transport types for the Substrate client. Substrate's one-shot query and
 * mutate ride HTTP (`POST /substrate/v1/query`, `POST /substrate/v1/mutate`),
 * so the transport is the stateless {@link HttpTransport}; the previous
 * WebSocket transport and its subscription frames are gone.
 *
 * Self-contained by design: zero imports, so the client and the transport
 * share these shapes without a cycle.
 */

/**
 * Branded mutate de-dupe key. The client puts one beside `params` on every
 * entry of a mutate frame (`{ params, fields, idempotencyKey }`); Substrate's
 * engine caches the envelope under it, so the same frame sent again with the
 * same key returns the first answer instead of writing twice. One envelope
 * carries one key: the engine refuses an envelope whose entries disagree
 * (`idempotency_key_conflict`).
 *
 * Branded (not a bare `string`) so an op-key or arbitrary string cannot be
 * passed where a de-dupe key is required. Mint via an explicit cast at the one
 * creation site, e.g. `crypto.randomUUID() as IdempotencyKey`.
 */
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

/** One entry of a Substrate envelope's `errors` array. */
export interface SubstrateEnvelopeError {
  message: string;
  /** Usually `[<frame key>]`: which frame of the request this error belongs to. */
  path?: string[];
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Parsed response envelope from `/substrate/v1/query` or `/mutate`. Callers
 * read `data[<ns>/<op>]` after checking `errors` for that key. The index
 * signature keeps the server's meta fields (`schemaVersion`, `shapes`,
 * `_pagination`, …) reachable without widening to `any`.
 */
export interface SubstrateResponseEnvelope {
  /** Op-keyed result map: `data[<ns>/<op>]` is the row(s) or resolver object. */
  data?: Record<string, unknown>;
  errors?: SubstrateEnvelopeError[];
  [key: string]: unknown;
}

/**
 * What the client drives:
 *
 * - `query`  -> POST `/substrate/v1/query`  (list queries and the custom query ops).
 * - `mutate` -> POST `/substrate/v1/mutate` (named mutations).
 *
 * Both take the op-keyed request body the client builds
 * (`{ "<ns>/<op>": { params, fields } }`, plus `idempotencyKey` on a mutate
 * entry) and return the envelope unchanged.
 */
export interface Transport {
  query(body: unknown): Promise<SubstrateResponseEnvelope>;
  mutate(body: unknown): Promise<SubstrateResponseEnvelope>;
  /** Release resources; a no-op for stateless HTTP. */
  close(): void;
}
