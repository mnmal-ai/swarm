/**
 * The drainstop's frame helpers: one query or one mutation through the engine
 * handle, refusals surfaced as throws rather than as a missing `data` key.
 *
 * Every call runs as `ctx`: the caller's request context when a route
 * triggered the work, or `makeCtx(namespace, op, DRAINSTOP_IDENTITY)` for
 * scheduled and direct calls. Substrate refuses an unattributed write (an
 * identity of null throws `UnattributedWriteError` at the row write; a
 * deployment's `systemActor` is stamped by the transport, not the engine), so
 * work no caller asked for names itself with an explicit system envelope.
 */
import {
  EngineQueryError,
  type EngineHandle,
  type Identity,
  makeCtx,
  type RequestContext,
  type Row,
  selectAll,
} from "@mnmal-ai/substrate/sdk";
import type { DrainstopFailure } from "@mnmal-ai/swarm-substrate-shared";

/** Structured metric sink, the shape scheduled tasks and routes are handed. */
export type Metric = (name: string, payload?: unknown) => void;

/** One promotion or expiry that did not happen, and why. The shape lives in the shared package. */
export type { DrainstopFailure };

/** A mutation the engine refused, outside the promotion-target namespaces. */
export class FrameRefusedError extends Error {
  override readonly name = "FrameRefusedError";
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/**
 * Who the drainstop writes as when no caller asked: a system envelope with
 * read and mutate everywhere, deliberately not admin.
 */
export const DRAINSTOP_IDENTITY: Identity = {
  kind: "system",
  id: "swarm-drainstop",
  grants: { "*": ["read", "mutate"] },
};

/** The context for work no caller asked for (the schedule, direct calls). */
export function systemContext(namespace: string, operation: "query" | "mutate"): Partial<RequestContext> {
  return makeCtx(namespace, operation, DRAINSTOP_IDENTITY);
}

export function contextFor(
  ctx: Partial<RequestContext> | undefined,
  namespace: string,
  operation: "query" | "mutate",
): Partial<RequestContext> {
  return ctx ?? systemContext(namespace, operation);
}

/** The error code carried by a thrown refusal, if any. */
export function codeOf(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function failureOf(phase: string, observationId: string | null, err: unknown): DrainstopFailure {
  return { phase, observationId, code: codeOf(err), name: err instanceof Error ? err.name : null, message: messageOf(err) };
}

/**
 * Run `<ns>/<type>` as a list query and return its rows. Throws
 * `EngineQueryError` when the engine refuses the frame.
 */
export async function queryRows<T>(
  engine: EngineHandle,
  ns: string,
  type: string,
  params: Record<string, unknown>,
  fields: readonly string[],
  ctx: Partial<RequestContext> | undefined,
): Promise<T[]> {
  const key = `${ns}/${type}`;
  const env = await engine.query({
    frame: { [key]: { params, fields: selectAll(fields) } },
    ctx: contextFor(ctx, ns, "query"),
  });
  const err = env.errors?.[0];
  if (err !== undefined) throw new EngineQueryError(err.code ?? "query_failed", `${key} refused: ${err.message ?? "no message"}`);
  const data = env.data[key];
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw new EngineQueryError("unexpected_shape", `${key} answered ${typeof data}, not a list of rows`);
  return data as T[];
}

/** One page of a list query, and the cursor of the next one (undefined on the last page). */
export interface RowPage<T> {
  rows: T[];
  nextCursor: string | undefined;
}

/**
 * Run `<ns>/<type>` as a list query for one page, following `cursor` when
 * given. Throws `EngineQueryError` when the engine refuses the frame.
 */
export async function queryPage<T>(
  engine: EngineHandle,
  ns: string,
  type: string,
  params: Record<string, unknown>,
  fields: readonly string[],
  ctx: Partial<RequestContext> | undefined,
  cursor?: string,
): Promise<RowPage<T>> {
  const key = `${ns}/${type}`;
  const env = await engine.query({
    frame: { [key]: { params: cursor === undefined ? params : { ...params, cursor }, fields: selectAll(fields) } },
    ctx: contextFor(ctx, ns, "query"),
  });
  const err = env.errors?.[0];
  if (err !== undefined) throw new EngineQueryError(err.code ?? "query_failed", `${key} refused: ${err.message ?? "no message"}`);
  const data = env.data[key];
  if (data !== null && data !== undefined && !Array.isArray(data)) {
    throw new EngineQueryError("unexpected_shape", `${key} answered ${typeof data}, not a list of rows`);
  }
  const pagination = env._pagination?.[key];
  return {
    rows: (data ?? []) as T[],
    nextCursor: pagination?.hasMore === true ? pagination.nextCursor : undefined,
  };
}

/**
 * Run `<ns>/<name>` as a single-entry mutation and return its row. Throws
 * {@link FrameRefusedError} when the envelope carries an error; on a strict
 * engine (`withStrictPromotions`) a promotion target's refusal has already
 * thrown `PromotionWriteError` by then.
 */
export async function mutateOne(
  engine: EngineHandle,
  ns: string,
  name: string,
  params: Record<string, unknown>,
  ctx: Partial<RequestContext> | undefined,
  idempotencyKey?: string,
): Promise<Row> {
  const key = `${ns}/${name}`;
  const entry: { params: Record<string, unknown>; fields: Record<string, true>; idempotencyKey?: string } = {
    params,
    fields: { id: true },
  };
  if (idempotencyKey !== undefined) entry.idempotencyKey = idempotencyKey;
  const env = await engine.mutate({ frame: { [key]: entry }, ctx: contextFor(ctx, ns, "mutate") });
  const err = env.errors?.[0];
  if (err !== undefined) {
    throw new FrameRefusedError(`${key} refused (${err.code ?? "mutate_failed"}): ${err.message ?? "no message"}`, err.code ?? null);
  }
  return (env.data[key] ?? {}) as Row;
}
