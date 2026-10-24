import { describe, expect, it } from "vitest";
import { createMockSubstrateClient } from "./helpers.js";

/**
 * Atomicity gate for the `persistTaskTelemetry` resolver.
 *
 * The resolver wraps all four telemetry writes (SessionEvent + TranscriptEntry
 * + WorkerResult + optional ReviewVerdict) in a single transaction, so a throw
 * mid-batch must leave NO partial rows. The happy path must create every entity
 * in one call with zero per-row `mutate()` chatter. These mirror the unit-level
 * resolver tests at the integration seam, through the shared mock client.
 */

function makeBatch(withVerdict: boolean) {
  const sessionEvent = {
    eventId: "evt-1",
    sessionId: "sess-1",
    role: "worker",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    intent: "implementation",
    swarmFilesLoaded: "[]",
    contextTokensUsed: 100,
    inputTokens: 10,
    outputTokens: 20,
    latencyMs: 5,
    timestamp: "2026-05-30T00:00:00.000Z",
  };
  const transcript = {
    sessionId: "sess-1",
    role: "worker",
    prompt: "do the thing",
    response: "did the thing",
    inputTokens: 10,
    outputTokens: 20,
    backend: "substrate",
    timestamp: "2026-05-30T00:00:00.000Z",
  };
  const workerResult = {
    sessionId: "sess-1",
    intent: "implementation",
    output: "the output",
    diff: "",
    filesModified: "[]",
    tokenUsage: 30,
    timestamp: "2026-05-30T00:00:00.000Z",
  };
  const reviewVerdict = {
    sessionId: "sess-1",
    workerResultId: "",
    verdict: "approved",
    reasons: "[]",
    suggestions: "[]",
    attempt: 0,
    timestamp: "2026-05-30T00:00:00.000Z",
  };
  return withVerdict
    ? { sessionEvent, transcript, workerResult, reviewVerdict }
    : { sessionEvent, transcript, workerResult };
}

describe("persistTaskTelemetry batch atomicity (integration)", () => {
  it("happy path: one atomic call creates all 4 entities", async () => {
    const client = createMockSubstrateClient({ telemetry: {} });
    const persist = client.persistTaskTelemetry;
    if (!persist) throw new Error("expected persistTaskTelemetry to be exposed");

    const res = await persist(makeBatch(true));

    expect(res.ids.sessionEvent).toBeTruthy();
    expect(res.ids.transcript).toBeTruthy();
    expect(res.ids.workerResult).toBeTruthy();
    expect(res.ids.reviewVerdict).toBeTruthy();

    const store = client.telemetryStore;
    expect(store?.SessionEvent).toHaveLength(1);
    expect(store?.TranscriptEntry).toHaveLength(1);
    expect(store?.WorkerResult).toHaveLength(1);
    expect(store?.ReviewVerdict).toHaveLength(1);

    // One resolver round trip, zero per-row mutate() chatter.
    expect(client.persistTaskTelemetry).toHaveBeenCalledTimes(1);
    expect(client.mutate).not.toHaveBeenCalled();
  });

  it("a throw mid-persistTaskTelemetry lands NO partial rows (atomicity)", async () => {
    const client = createMockSubstrateClient({ telemetry: { failOn: "workerResult" } });

    await expect(
      client.persistTaskTelemetry?.(makeBatch(true)),
    ).rejects.toThrow(/workerResult/);

    // SessionEvent + TranscriptEntry were staged before the failure on
    // WorkerResult, yet the transaction committed nothing — the store is empty.
    const store = client.telemetryStore;
    expect(store?.SessionEvent).toHaveLength(0);
    expect(store?.TranscriptEntry).toHaveLength(0);
    expect(store?.WorkerResult).toHaveLength(0);
    expect(store?.ReviewVerdict).toHaveLength(0);
  });

  it("commits the three required entities when no review verdict is present", async () => {
    const client = createMockSubstrateClient({ telemetry: {} });
    const persist = client.persistTaskTelemetry;
    if (!persist) throw new Error("expected persistTaskTelemetry to be exposed");

    const res = await persist(makeBatch(false));

    expect(res.ids.reviewVerdict).toBeUndefined();
    const store = client.telemetryStore;
    expect(store?.SessionEvent).toHaveLength(1);
    expect(store?.TranscriptEntry).toHaveLength(1);
    expect(store?.WorkerResult).toHaveLength(1);
    expect(store?.ReviewVerdict).toHaveLength(0);
  });

  it("throws and writes nothing when a required sub-object is missing", async () => {
    const client = createMockSubstrateClient({ telemetry: {} });
    const full = makeBatch(true);
    const partial = { sessionEvent: full.sessionEvent, transcript: full.transcript };

    await expect(
      client.persistTaskTelemetry?.(partial),
    ).rejects.toThrow(/required/);

    expect(client.telemetryStore?.SessionEvent).toHaveLength(0);
  });
});
