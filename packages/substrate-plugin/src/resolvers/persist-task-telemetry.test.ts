import type {
  PersistTaskTelemetryRequest,
  ReviewVerdictInput,
  SessionEventInput,
  TranscriptEntryInput,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate-shared";
import type { Dataset, RequestContext, ResolverArgs, Row, WriteOptions } from "@mnmal-ai/substrate/sdk";
import { MemoryDataset } from "@mnmal-ai/substrate/testing";
import { describe, expect, it } from "vitest";
import { persistTaskTelemetry } from "./persist-task-telemetry.js";

// The create resolver reads `ctx.now` and `ctx.identity`; a fixed Date keeps
// `_metadata` deterministic, and an explicit system identity is required:
// Substrate's `resolveIdentity` refuses unattributed writes.
const ctx = {
  identity: { kind: "system", id: "swarm-test", grants: {} },
  namespace: "swarm",
  operation: "mutate",
  now: new Date("2026-05-30T12:00:00.000Z"),
  headers: {},
  meta: {},
} as unknown as RequestContext;

function newDataset(): MemoryDataset {
  return new MemoryDataset({ namespace: "swarm" });
}

const sessionEvent: SessionEventInput = {
  eventId: "evt-1",
  sessionId: "sess-1",
  role: "worker",
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  intent: "implementation",
  // Arrays arrive pre-stringified as JSON (the client stringifies before the call).
  swarmFilesLoaded: '["core/rules.md","core/values.md"]',
  contextTokensUsed: 1234,
  inputTokens: 100,
  outputTokens: 200,
  latencyMs: 4567,
  // Distinct per sub-object so the assertions prove each row reads authorId from
  // its OWN input, not from a shared/leaked value.
  authorId: "author-se",
  timestamp: "2026-05-30T12:00:00.000Z",
};

const transcript: TranscriptEntryInput = {
  sessionId: "sess-1",
  role: "worker",
  prompt: "do the thing",
  response: "did the thing",
  inputTokens: 100,
  outputTokens: 200,
  backend: "substrate",
  authorId: "author-te",
  timestamp: "2026-05-30T12:00:00.000Z",
};

const workerResult: WorkerResultInput = {
  sessionId: "sess-1",
  intent: "implementation",
  output: "the output",
  diff: "the diff",
  filesModified: '["a.ts","b.ts"]',
  tokenUsage: 300,
  authorId: "author-wr",
  timestamp: "2026-05-30T12:00:00.000Z",
};

const reviewVerdict: ReviewVerdictInput = {
  sessionId: "sess-1",
  // Deliberately wrong — the resolver must override this with the id of the
  // WorkerResult it creates in the same transaction.
  workerResultId: "STALE-CLIENT-GUESS",
  verdict: "approved",
  reasons: '["looks good"]',
  suggestions: '["tighten naming"]',
  attempt: 0,
  authorId: "author-rv",
  timestamp: "2026-05-30T12:00:00.000Z",
};

function argsFor(
  dataset: Dataset,
  params: Partial<PersistTaskTelemetryRequest>,
  onWrite?: ResolverArgs["onWrite"],
): ResolverArgs {
  const args: ResolverArgs = { params, dataset };
  if (onWrite) args.onWrite = onWrite;
  return args;
}

async function readAll(dataset: Dataset, type: string): Promise<Row[]> {
  const result = await dataset.read(type, { limit: 1000 });
  return result.rows;
}

describe("persistTaskTelemetry resolver", () => {
  it("writes all four rows and returns their ids when a review verdict is present", async () => {
    const dataset = newDataset();
    const res = await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult, reviewVerdict }),
    );

    expect(res.ids.sessionEvent).toBeTruthy();
    expect(res.ids.transcript).toBeTruthy();
    expect(res.ids.workerResult).toBeTruthy();
    expect(res.ids.reviewVerdict).toBeTruthy();

    expect(await readAll(dataset, "SessionEvent")).toHaveLength(1);
    expect(await readAll(dataset, "TranscriptEntry")).toHaveLength(1);
    expect(await readAll(dataset, "WorkerResult")).toHaveLength(1);
    expect(await readAll(dataset, "ReviewVerdict")).toHaveLength(1);
  });

  it("keeps numeric fields as numbers and passes JSON-array fields through verbatim", async () => {
    const dataset = newDataset();
    await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult }),
    );

    const [se] = await readAll(dataset, "SessionEvent");
    // Numerics stored as numbers: Substrate's field.number() refuses the
    // String(...) form the previous engine's createSessionEvent callers sent.
    expect(se?.contextTokensUsed).toBe(1234);
    expect(se?.inputTokens).toBe(100);
    expect(se?.outputTokens).toBe(200);
    expect(se?.latencyMs).toBe(4567);
    // Array field untouched (no double-encoding).
    expect(se?.swarmFilesLoaded).toBe('["core/rules.md","core/values.md"]');
    expect(se?.eventId).toBe("evt-1");

    const [wr] = await readAll(dataset, "WorkerResult");
    expect(wr?.tokenUsage).toBe(300);
    expect(wr?.filesModified).toBe('["a.ts","b.ts"]');

    const [te] = await readAll(dataset, "TranscriptEntry");
    expect(te?.inputTokens).toBe(100);
    expect(te?.backend).toBe("substrate");
  });

  it("persists tokens and writes no dollar field on any row", async () => {
    const dataset = newDataset();
    // A caller that still sends a legacy costUsd must not get it stored.
    await persistTaskTelemetry(
      ctx,
      argsFor(dataset, {
        sessionEvent: { ...sessionEvent, costUsd: 0.0123 } as SessionEventInput,
        transcript: { ...transcript, costUsd: 0.0123 } as TranscriptEntryInput,
        workerResult: { ...workerResult, costUsd: 0.0123 } as WorkerResultInput,
        reviewVerdict,
      }),
    );

    // SessionEvent: token fields persisted, no costUsd.
    const [se] = await readAll(dataset, "SessionEvent");
    expect(se?.inputTokens).toBe(100);
    expect(se?.outputTokens).toBe(200);
    expect(se?.contextTokensUsed).toBe(1234);
    expect(se?.costUsd).toBeUndefined();

    // WorkerResult: token fields + provider/modelId persisted, sourced from the
    // same batch's SessionEvent input (the WorkerResult fixture omits them).
    const [wr] = await readAll(dataset, "WorkerResult");
    expect(wr?.provider).toBe("anthropic");
    expect(wr?.modelId).toBe("claude-sonnet-4-6");
    expect(wr?.inputTokens).toBe(100);
    expect(wr?.outputTokens).toBe(200);
    expect(wr?.tokenUsage).toBe(300);
    expect(wr?.costUsd).toBeUndefined();

    // TranscriptEntry: tokens persisted, no costUsd.
    const [te] = await readAll(dataset, "TranscriptEntry");
    expect(te?.inputTokens).toBe(100);
    expect(te?.costUsd).toBeUndefined();
  });

  it("copies authorId from each input sub-object onto its persisted row", async () => {
    const dataset = newDataset();
    await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult, reviewVerdict }),
    );

    // Each row carries the authorId of the input it was shaped from — distinct
    // fixture values prove no value leaked across sub-objects. The WorkerResult
    // sources provider/tokens from the SessionEvent but its authorId still comes
    // from the WorkerResult input ("author-wr", not "author-se").
    const [se] = await readAll(dataset, "SessionEvent");
    expect(se?.authorId).toBe("author-se");

    const [te] = await readAll(dataset, "TranscriptEntry");
    expect(te?.authorId).toBe("author-te");

    const [wr] = await readAll(dataset, "WorkerResult");
    expect(wr?.authorId).toBe("author-wr");

    // ReviewVerdict is the oversight row this resolver emits; it carries authorId
    // for the same future per-engineer reports.
    const [rv] = await readAll(dataset, "ReviewVerdict");
    expect(rv?.authorId).toBe("author-rv");
  });

  it("persists the session's context record on the SessionEvent row", async () => {
    const dataset = newDataset();
    const contextDetail = JSON.stringify({
      budgetTokens: 14000,
      loaded: [{ path: "core/values.md", tier: "core", tokens: 600 }],
      omitted: [{ path: "capabilities/git.md", tier: "capabilities", tokens: 900 }],
    });
    await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent: { ...sessionEvent, contextDetail }, transcript, workerResult }),
    );
    const [se] = await readAll(dataset, "SessionEvent");
    expect(se?.contextDetail).toBe(contextDetail);
  });

  it("persists the session's fnl coverage on the SessionEvent row", async () => {
    const dataset = newDataset();
    const fnlCoverage = JSON.stringify({ buildCommands: 2, wrapped: 2, leftAlone: {}, byTool: { vitest: { wrapped: 2, leftAlone: 0 } }, unanswered: 0 });
    await persistTaskTelemetry(ctx, argsFor(dataset, { sessionEvent: { ...sessionEvent, fnlCoverage }, transcript, workerResult }));
    const [se] = await readAll(dataset, "SessionEvent");
    expect(se?.fnlCoverage).toBe(fnlCoverage);
  });

  it("omits authorId on rows whose input sub-object did not carry one", async () => {
    // authorId is optional taxonomy (enforcement deferred): a batch without it
    // still persists, and the column stays absent rather than coerced.
    const dataset = newDataset();
    const { authorId: _se, ...sessionEventNoAuthor } = sessionEvent;
    const { authorId: _te, ...transcriptNoAuthor } = transcript;
    const { authorId: _wr, ...workerResultNoAuthor } = workerResult;
    await persistTaskTelemetry(
      ctx,
      argsFor(dataset, {
        sessionEvent: sessionEventNoAuthor,
        transcript: transcriptNoAuthor,
        workerResult: workerResultNoAuthor,
      }),
    );

    const [se] = await readAll(dataset, "SessionEvent");
    expect(se?.authorId).toBeUndefined();
    const [te] = await readAll(dataset, "TranscriptEntry");
    expect(te?.authorId).toBeUndefined();
    const [wr] = await readAll(dataset, "WorkerResult");
    expect(wr?.authorId).toBeUndefined();
  });

  it("links the review verdict to the worker result created in the same call, ignoring the input's workerResultId", async () => {
    const dataset = newDataset();
    const res = await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult, reviewVerdict }),
    );

    const [rv] = await readAll(dataset, "ReviewVerdict");
    expect(rv?.workerResultId).toBe(res.ids.workerResult);
    expect(rv?.workerResultId).not.toBe("STALE-CLIENT-GUESS");
    expect(rv?.attempt).toBe(0);
    expect(rv?.reasons).toBe('["looks good"]');
  });

  it("allocates a reserved shortId per created row, matching AutoCRUD create", async () => {
    const dataset = newDataset();
    const res = await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult }),
    );
    // A bound shortId is what keeps lookup-by-shortId identical to autoCRUD create.
    expect(
      await dataset.getShortIdForRow("SessionEvent", res.ids.sessionEvent),
    ).not.toBeNull();
    expect(
      await dataset.getShortIdForRow("WorkerResult", res.ids.workerResult),
    ).not.toBeNull();
  });

  it("omits the reviewVerdict id and writes only three rows when no verdict is supplied", async () => {
    const dataset = newDataset();
    const res = await persistTaskTelemetry(
      ctx,
      argsFor(dataset, { sessionEvent, transcript, workerResult }),
    );

    expect(res.ids.reviewVerdict).toBeUndefined();
    expect(await readAll(dataset, "ReviewVerdict")).toHaveLength(0);
    expect(await readAll(dataset, "SessionEvent")).toHaveLength(1);
    expect(await readAll(dataset, "TranscriptEntry")).toHaveLength(1);
    expect(await readAll(dataset, "WorkerResult")).toHaveLength(1);
  });

  it("forwards onWrite once per created row", async () => {
    const dataset = newDataset();
    const events: Array<{ type: string; operation: string }> = [];
    await persistTaskTelemetry(
      ctx,
      argsFor(
        dataset,
        { sessionEvent, transcript, workerResult, reviewVerdict },
        (e) => events.push({ type: e.type, operation: e.operation }),
      ),
    );
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.operation === "create")).toBe(true);
    expect(events.map((e) => e.type).sort()).toEqual([
      "ReviewVerdict",
      "SessionEvent",
      "TranscriptEntry",
      "WorkerResult",
    ]);
  });

  it("rolls back every row when a mid-transaction write throws (atomicity)", async () => {
    const inner = newDataset();
    // Run the resolver inside a transaction, as the engine's mutate does, over
    // a view whose ReviewVerdict write (the LAST write in the sequence) throws.
    // Atomicity requires the three rows written before it to roll back,
    // leaving the store empty.
    await expect(
      inner.withTransaction((tx) =>
        persistTaskTelemetry(
          ctx,
          argsFor(faultyView(tx, "ReviewVerdict"), { sessionEvent, transcript, workerResult, reviewVerdict }),
        ),
      ),
    ).rejects.toThrow(/injected write fault/);

    expect(await readAll(inner, "SessionEvent")).toHaveLength(0);
    expect(await readAll(inner, "TranscriptEntry")).toHaveLength(0);
    expect(await readAll(inner, "WorkerResult")).toHaveLength(0);
    expect(await readAll(inner, "ReviewVerdict")).toHaveLength(0);
  });

  it("throws when a required sub-object is missing and writes nothing", async () => {
    const dataset = newDataset();
    await expect(
      persistTaskTelemetry(ctx, argsFor(dataset, { sessionEvent, transcript })),
    ).rejects.toThrow(/required/);
    expect(await readAll(dataset, "SessionEvent")).toHaveLength(0);
  });

  it("throws when args.dataset is absent", async () => {
    await expect(
      persistTaskTelemetry(ctx, {
        params: { sessionEvent, transcript, workerResult },
      }),
    ).rejects.toThrow(/args\.dataset is required/);
  });
});

/**
 * A view of a transaction-scoped `MemoryDataset` whose `write` throws for one
 * type. The fault throws from the tx-bound `write`, so the rollback path under
 * test is the dataset's real snapshot-restore, not a stubbed one.
 */
function faultyView(tx: Dataset, failOnType: string): Dataset {
  return new Proxy(tx, {
    get: (target, prop, receiver) => {
      if (prop === "write") {
        return (type: string, rows: Row[], options?: WriteOptions) => {
          if (type === failOnType) {
            throw new Error(`injected write fault for ${type}`);
          }
          return target.write(type, rows, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
