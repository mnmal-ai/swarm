/**
 * `persistTaskTelemetry`: the swarm namespace's custom mutation resolver,
 * ported from the previous engine plugin.
 *
 * Collapses the four separate telemetry/oversight write round trips a task
 * would otherwise make (`createSessionEvent` + `createTranscriptEntry` +
 * `createWorkerResult` + optional `createReviewVerdict`) into ONE mutation.
 * Atomicity is the headline guarantee: if any write throws, no partial rows
 * land.
 *
 * Transaction: Substrate's engine runs every mutate frame inside one
 * transaction and hands the resolver its transaction-scoped view as
 * `args.dataset` (plugin author guide, "Custom mutation resolvers"). Every
 * write below goes through that handle, so a throw anywhere rolls back the
 * whole call. The previous engine's explicit `withTransaction` is gone: the engine owns the
 * boundary.
 *
 * Writes: each row is created with the SDK's `createResolver`, the create
 * resolver autoCRUD itself wraps, over the transaction-scoped dataset, so the
 * id (a UUID), `_metadata` stamping, field validation (undeclared fields,
 * required scalars, scalar types), the reserved `shortId` allocation and the
 * per-row `onWrite` event all match the generated `create<Type>` mutations.
 * What autoCRUD's create adds on top (crossRef edge emission and the
 * `postWrite` chain) is not run; none of the four types declares a crossRef,
 * a `postWrite` or an `embed.source`, so neither applies today.
 *
 * Validation failures surface as `ResolverFrameError`s, which the engine
 * reports under this frame's key with their own code (for example
 * `missing_required_field`) and which roll the transaction back.
 *
 * Field mapping mirrors the legacy per-row mutations:
 *   - SessionEvent     → packages/telemetry  Telemetry.emitEvent (createSessionEvent)
 *   - TranscriptEntry  → packages/telemetry  Telemetry.emitTranscript (createTranscriptEntry)
 *   - WorkerResult     → packages/oversight   (createWorkerResult)
 *   - ReviewVerdict    → packages/oversight   (createReviewVerdict)
 * Numeric fields pass through as numbers: Substrate's `field.number()` refuses
 * a string (`invalid_field_type`), where the previous engine stored the `String(...)` form.
 * Array fields (`swarmFilesLoaded`, `filesModified`, `reasons`, `suggestions`)
 * arrive pre-stringified as JSON in the request sub-objects, so they pass
 * through verbatim; re-stringifying would double-encode. Each mapper copies
 * only its type's declared fields, so a key a caller adds to an input (a
 * legacy `costUsd`, say) is dropped rather than stored or refused.
 *
 * Swarm accounts in tokens only, so this resolver writes no dollar field on
 * any row. It persists the token fields, and for WorkerResult it also copies
 * `provider`/`modelId`/`inputTokens`/`outputTokens` from the same batch's
 * SessionEvent input (the SessionEvent is the batch's single carrier of those
 * four values). The `costUsd` columns stay in the schema, nullable, so rows
 * that carry one remain readable.
 */
import type {
  PersistTaskTelemetryRequest,
  PersistTaskTelemetryResponse,
  ReviewVerdictInput,
  SessionEventInput,
  TranscriptEntryInput,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate-shared";
import {
  createResolver,
  type Dataset,
  RESERVED_AUTOCRUD_FIELDS,
  type RequestContext,
  type ResolverArgs,
  ResolverFrameError,
  type Row,
  type TypedResolver,
} from "@mnmal-ai/substrate/sdk";
import { swarmTypes } from "../types/swarm-types.js";

/** The four `swarm` types this resolver writes. */
type TelemetryTypeName = "SessionEvent" | "TranscriptEntry" | "WorkerResult" | "ReviewVerdict";

/**
 * What the resolver returns: the shared response plus the `id` every Substrate
 * mutation result carries. The id is the constant `"ack"`; the row ids are in
 * `ids`.
 */
export type PersistTaskTelemetryResult = PersistTaskTelemetryResponse & { id: "ack" };

// ---------------------------------------------------------------------------
// Input → row-field mappers
//
// Each returns the `params` object the corresponding autoCRUD `create<Type>`
// mutation would have been called with. Kept as pure functions so the mapping
// is unit-testable in isolation and visually diffable against the legacy
// call-sites it mirrors.
// ---------------------------------------------------------------------------

/** Mirror of `createSessionEvent` in packages/telemetry. */
function toSessionEventFields(input: SessionEventInput): Record<string, unknown> {
  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    role: input.role,
    provider: input.provider,
    modelId: input.modelId,
    intent: input.intent,
    // Already a JSON string in the request shape; the caller stringifies it,
    // so do NOT re-encode here.
    swarmFilesLoaded: input.swarmFilesLoaded,
    contextTokensUsed: input.contextTokensUsed,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    latencyMs: input.latencyMs,
    // Author attribution copied straight from this batch's SessionEvent input
    // (env USER > git user.email > anonymous, resolved once at session start).
    // Passed through verbatim: undefined when the caller omits it, which the
    // create resolver treats as absent; the column is nullable so an
    // unattributed row still persists.
    authorId: input.authorId,
    // JSON already; only set when the session loaded swarm context.
    ...(input.contextDetail !== undefined ? { contextDetail: input.contextDetail } : {}),
    // JSON already; only set when the session counted its fnl coverage.
    ...(input.fnlCoverage !== undefined ? { fnlCoverage: input.fnlCoverage } : {}),
    timestamp: input.timestamp,
  };
}

/** Mirror of `createTranscriptEntry` in packages/telemetry. */
function toTranscriptEntryFields(input: TranscriptEntryInput): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    role: input.role,
    prompt: input.prompt,
    response: input.response,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    backend: input.backend,
    // Author attribution, see toSessionEventFields. Read from this row's own
    // transcript input sub-object.
    authorId: input.authorId,
    timestamp: input.timestamp,
  };
}

/**
 * Mirror of `createWorkerResult` in packages/oversight, with the row's
 * `provider`/`modelId`/`inputTokens`/`outputTokens` sourced from the same
 * batch's SessionEvent input: the SessionEvent is the batch's single carrier of
 * those four values, and the legacy WorkerResult create-call never received
 * them. `tokenUsage` (the legacy aggregate) is kept for back-compat.
 */
function toWorkerResultFields(input: WorkerResultInput, sessionEvent: SessionEventInput): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    intent: input.intent,
    output: input.output,
    diff: input.diff,
    // Pre-stringified JSON array in the request shape, passed through verbatim.
    filesModified: input.filesModified,
    tokenUsage: input.tokenUsage,
    provider: sessionEvent.provider,
    modelId: sessionEvent.modelId,
    inputTokens: sessionEvent.inputTokens,
    outputTokens: sessionEvent.outputTokens,
    // Author attribution, see toSessionEventFields. Read from the WorkerResult
    // input's OWN sub-object (not the SessionEvent that sources provider/tokens):
    // each row carries the authorId of the input it was shaped from.
    authorId: input.authorId,
    timestamp: input.timestamp,
  };
}

/**
 * Mirror of `createReviewVerdict` in packages/oversight.
 *
 * `workerResultId` is the id of the WorkerResult created earlier in THIS
 * call, not the value carried on the request sub-object. The legacy oversight
 * flow set it from the row it had just created; the client cannot know that id
 * ahead of an atomic single-call persist, so the resolver supplies it. Any
 * `workerResultId` on the input is intentionally ignored: a review verdict
 * written in this call always refers to the worker result written in the same
 * call.
 */
function toReviewVerdictFields(input: ReviewVerdictInput, workerResultId: string): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    workerResultId,
    verdict: input.verdict,
    // Pre-stringified JSON arrays in the request shape, passed through verbatim.
    reasons: input.reasons,
    suggestions: input.suggestions,
    attempt: input.attempt,
    // Author attribution, see toSessionEventFields. Read from this row's own
    // reviewVerdict input sub-object, for the same future per-engineer reports.
    authorId: input.authorId,
    timestamp: input.timestamp,
  };
}

/**
 * Create one row of `typeName` on the transaction-scoped dataset, returning the
 * created row (with its allocated `id` and `shortId`).
 *
 * The field set is the type's declared fields plus `RESERVED_AUTOCRUD_FIELDS`,
 * exactly what `defineNamespace` hands the generated `create<Type>`, so the
 * validation and the reserved `shortId` allocation both match the per-row
 * mutations (a caller cannot set `shortId`). `onWrite` is forwarded so the
 * engine announces each created row to subscribers once the transaction
 * commits; a rolled-back transaction announces nothing.
 */
async function createRow(
  dataset: Dataset,
  ctx: RequestContext,
  parentArgs: ResolverArgs,
  typeName: TelemetryTypeName,
  fields: Record<string, unknown>,
): Promise<Row> {
  const resolver = createResolver(typeName, dataset, {
    fields: { ...swarmTypes[typeName].fields, ...RESERVED_AUTOCRUD_FIELDS },
  });
  const childArgs: ResolverArgs = { params: fields, dataset };
  if (parentArgs.onWrite) childArgs.onWrite = parentArgs.onWrite;
  return resolver(ctx, childArgs);
}

/**
 * The `persistTaskTelemetry` mutation resolver.
 *
 * Writes SessionEvent + TranscriptEntry + WorkerResult (+ optional
 * ReviewVerdict) through `args.dataset`. The WorkerResult is created before the
 * ReviewVerdict so the verdict can reference its id. Returns the allocated ids;
 * `ids.reviewVerdict` is present only when the request carried one.
 */
export const persistTaskTelemetry: TypedResolver<PersistTaskTelemetryResult> = async (
  ctx: RequestContext,
  args: ResolverArgs,
): Promise<PersistTaskTelemetryResult> => {
  const dataset = args.dataset;
  if (!dataset) {
    throw new Error(
      "persistTaskTelemetry: args.dataset is required — the engine must inject the transaction-scoped dataset handle",
    );
  }

  const req = (args.params ?? {}) as Partial<PersistTaskTelemetryRequest>;
  const { sessionEvent, transcript, workerResult, reviewVerdict } = req;
  if (!sessionEvent || !transcript || !workerResult) {
    throw new ResolverFrameError(
      "missing_param",
      "persistTaskTelemetry: 'sessionEvent', 'transcript', and 'workerResult' params are all required",
    );
  }

  const sessionEventRow = await createRow(dataset, ctx, args, "SessionEvent", toSessionEventFields(sessionEvent));
  const transcriptRow = await createRow(dataset, ctx, args, "TranscriptEntry", toTranscriptEntryFields(transcript));
  const workerResultRow = await createRow(
    dataset,
    ctx,
    args,
    "WorkerResult",
    toWorkerResultFields(workerResult, sessionEvent),
  );

  const ids: PersistTaskTelemetryResponse["ids"] = {
    sessionEvent: String(sessionEventRow.id),
    transcript: String(transcriptRow.id),
    workerResult: String(workerResultRow.id),
  };

  if (reviewVerdict) {
    const reviewVerdictRow = await createRow(
      dataset,
      ctx,
      args,
      "ReviewVerdict",
      toReviewVerdictFields(reviewVerdict, String(workerResultRow.id)),
    );
    ids.reviewVerdict = String(reviewVerdictRow.id);
  }

  return { id: "ack", ids };
};
