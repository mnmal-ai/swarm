import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Oversight } from "../src/index.js";
import type { ModelProvider } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// The reviewer/arbiter awaits an out-of-process worker by polling
// WorkerResult by sessionId. Substrate's client speaks HTTP only, so
// subscribeOrPoll never pushes: every resolution comes from the poll callback.
// These tests exercise Oversight.awaitWorkerResult, the consumer that drives it.
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-worker-123";
const WORKER_OUTPUT =
  "Out-of-process worker output that crossed the process boundary as a WorkerResult row in Substrate.";

/** A reviewer/arbiter provider is required to construct Oversight but is never
 *  called by awaitWorkerResult — a stub that throws if hit catches a regression. */
function unusedProvider(): ModelProvider {
  return {
    name: "anthropic",
    execute: vi.fn(async () => {
      throw new Error("provider must not be called while only awaiting the worker result");
    }),
  } as unknown as ModelProvider;
}

function makeOversight(client: unknown): Oversight {
  return new Oversight({
    reviewerProvider: unusedProvider(),
    reviewerModel: "test-model",
    arbiterProvider: unusedProvider(),
    arbiterModel: "test-model",
    // biome-ignore lint/suspicious/noExplicitAny: structural stub for the test
    substrateClient: client as any,
  });
}

describe("Oversight.awaitWorkerResult — cross-process worker result (poll only)", () => {
  beforeEach(() => {
    delete process.env.SWARM_DISABLE_SUBSCRIBE;
    delete process.env.SWARM_POLL_FALLBACK;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SWARM_DISABLE_SUBSCRIBE;
    delete process.env.SWARM_POLL_FALLBACK;
  });

  // Acceptance test: dispatch a worker call (its WorkerResult lands in
  // Substrate), await its session, and assert the poll delivers it.
  it("checks once before the first interval, resolves from the poll, and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const query = vi
        .fn()
        .mockResolvedValueOnce([]) // immediate check: the row has not landed yet
        .mockResolvedValue([{ sessionId: SESSION_ID, output: WORKER_OUTPUT }]);
      const oversight = makeOversight({ query });

      const pending = oversight.awaitWorkerResult({ sessionId: SESSION_ID, pollIntervalMs: 100 });

      // The first read happens at once, not one interval later.
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100); // tick 1: the row
      await expect(pending).resolves.toBe(WORKER_OUTPUT);
      expect(query).toHaveBeenCalledTimes(2);

      // Resolved → unsubscribed: later ticks read nothing.
      await vi.advanceTimersByTimeAsync(500);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes the poll to the session via where: { sessionId: { eq } }", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => [{ sessionId: SESSION_ID, output: WORKER_OUTPUT }]);
      const oversight = makeOversight({ query });

      // A row that has already landed is found by the immediate check, with
      // no interval elapsed.
      const pending = oversight.awaitWorkerResult({ sessionId: SESSION_ID, pollIntervalMs: 100 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe(WORKER_OUTPUT);
      expect(query).toHaveBeenCalledTimes(1);

      // The WhereClause grammar is operator-keyed ({ field: { eq } }) — a bare
      // { sessionId } is not an equality predicate. See WORKER_RESULT_WHERE in
      // oversight/src/index.ts.
      expect(query).toHaveBeenCalledWith(
        "WorkerResult",
        { where: { sessionId: { eq: SESSION_ID } } },
        { sessionId: true, output: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns local output via the synchronous fast-path without polling", async () => {
    const query = vi.fn();
    const oversight = makeOversight({ query });

    const output = await oversight.awaitWorkerResult({
      sessionId: SESSION_ID,
      localOutput: "in-process worker output already in hand",
    });

    expect(output).toBe("in-process worker output already in hand");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects at the deadline when no WorkerResult lands", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => []);
      const oversight = makeOversight({ query });

      const pending = oversight.awaitWorkerResult({ sessionId: SESSION_ID, pollIntervalMs: 100, timeoutMs: 350 });
      const settled = expect(pending).rejects.toThrow(/timed out after 350ms/);
      await vi.advanceTimersByTimeAsync(400);
      await settled;

      // The deadline also stops the poll.
      const calls = query.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(query.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the SWARM_* escape hatch with an immediate check before the interval", async () => {
    process.env.SWARM_DISABLE_SUBSCRIBE = "1";
    const query = vi.fn(async () => [{ sessionId: SESSION_ID, output: WORKER_OUTPUT }]);
    const oversight = makeOversight({ query });

    const output = await oversight.awaitWorkerResult({ sessionId: SESSION_ID, pollIntervalMs: 50 });

    expect(output).toBe(WORKER_OUTPUT);
    expect(query).toHaveBeenCalledTimes(1); // immediate check found the row
  });
});
