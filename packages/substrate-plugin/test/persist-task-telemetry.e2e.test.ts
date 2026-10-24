/**
 * `swarm/persistTaskTelemetry` end to end: one `POST /substrate/v1/mutate`
 * frame writes the session event, transcript, worker result and review verdict
 * inside the engine's mutate transaction, and a refused verdict write rolls
 * every row of that call back.
 *
 * The fault is a verdict missing its required `verdict` field. An undeclared
 * field on the verdict input cannot reach autoCRUD validation: the resolver
 * maps each input onto its type's declared fields (which is also how a legacy
 * `costUsd` is kept out), so a stray key is dropped, not refused. A missing
 * required field is refused by the same create validation, on the last write of
 * the call, after the other three rows have landed in the transaction.
 */
import type { PersistTaskTelemetryRequest } from "@mnmal-ai/swarm-substrate-shared";
import { describe, expect, it } from "vitest";
import { bootTestServer, type TestServer } from "./harness.js";

interface Envelope {
  data: Record<string, unknown>;
  errors?: Array<{ code?: string; message?: string; path?: string[] }>;
}

const KEY = "swarm/persistTaskTelemetry";
const TELEMETRY_TYPES = ["SessionEvent", "TranscriptEntry", "WorkerResult", "ReviewVerdict"] as const;
const AT = "2026-10-23T12:00:00.000Z";

function telemetryFor(sessionId: string): PersistTaskTelemetryRequest {
  return {
    sessionEvent: {
      eventId: `evt-${sessionId}`,
      sessionId,
      role: "worker",
      provider: "anthropic",
      modelId: "test-model",
      intent: "implementation",
      swarmFilesLoaded: '["core/rules.md"]',
      contextTokensUsed: 1234,
      inputTokens: 100,
      outputTokens: 200,
      latencyMs: 4567,
      timestamp: AT,
    },
    transcript: {
      sessionId,
      role: "worker",
      prompt: "do the thing",
      response: "did the thing",
      inputTokens: 100,
      outputTokens: 200,
      backend: "substrate",
      timestamp: AT,
    },
    workerResult: {
      sessionId,
      intent: "implementation",
      output: "the output",
      diff: "the diff",
      filesModified: '["a.ts"]',
      tokenUsage: 300,
      timestamp: AT,
    },
    reviewVerdict: {
      sessionId,
      workerResultId: "unknown-before-the-call",
      verdict: "approved",
      reasons: '["looks good"]',
      suggestions: "[]",
      attempt: 0,
      timestamp: AT,
    },
  };
}

async function persist(s: TestServer, params: unknown): Promise<Envelope> {
  const res = await s.inject({ method: "POST", url: "/substrate/v1/mutate", body: { [KEY]: { params, fields: { ids: true } } } });
  return res.json() as Envelope;
}

/** The rows of `type` written for `sessionId`, read through the autoCRUD list query. */
async function rowsFor(s: TestServer, type: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const key = `swarm/${type}`;
  const res = (
    await s.inject({
      method: "POST",
      url: "/substrate/v1/query",
      body: { [key]: { params: { where: { sessionId: { eq: sessionId } } }, fields: { id: true, sessionId: true } } },
    })
  ).json() as Envelope;
  expect(res.errors ?? []).toEqual([]);
  return res.data[key] as Array<Record<string, unknown>>;
}

async function countsFor(s: TestServer, sessionId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const type of TELEMETRY_TYPES) counts[type] = (await rowsFor(s, type, sessionId)).length;
  return counts;
}

describe("swarm/persistTaskTelemetry over the engine", () => {
  it("writes the worker result, review verdicts and session events atomically", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const res = await persist(s, telemetryFor("sess-a"));
      expect(res.errors ?? []).toEqual([]);
      const { ids } = res.data[KEY] as { ids: Record<string, string> };
      expect(ids).toEqual({
        sessionEvent: expect.any(String),
        transcript: expect.any(String),
        workerResult: expect.any(String),
        reviewVerdict: expect.any(String),
      });

      expect(await countsFor(s, "sess-a")).toEqual({ SessionEvent: 1, TranscriptEntry: 1, WorkerResult: 1, ReviewVerdict: 1 });
      const [worker] = await rowsFor(s, "WorkerResult", "sess-a");
      expect(worker?.id).toBe(ids.workerResult);

      // The verdict points at the worker result written in the same call.
      const verdicts = (
        await s.inject({
          method: "POST",
          url: "/substrate/v1/query",
          body: { "swarm/ReviewVerdict": { params: { where: { sessionId: { eq: "sess-a" } } }, fields: { workerResultId: true } } },
        })
      ).json() as Envelope;
      expect(verdicts.data["swarm/ReviewVerdict"]).toEqual([{ workerResultId: ids.workerResult }]);
    } finally {
      await s.stop();
    }
  });

  it("publishes the mutation's params and return shape in the swarm schema", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const res = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm" });
      expect(res.status).toBe(200);
      const schema = res.json() as {
        types: Record<string, unknown>;
        mutations: Record<string, { params: Record<string, unknown>; returns: { kind: string; fields: Record<string, unknown> } }>;
      };
      expect(schema.types).not.toHaveProperty("persistTaskTelemetry");
      const op = schema.mutations.persistTaskTelemetry;
      expect(Object.keys(op?.params ?? {}).sort()).toEqual(["reviewVerdict", "sessionEvent", "transcript", "workerResult"]);
      expect(op?.returns.kind).toBe("struct");
      expect(Object.keys(op?.returns.fields ?? {})).toEqual(["ids"]);
    } finally {
      await s.stop();
    }
  });

  it("a failing verdict write leaves no rows behind", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      // An earlier call's rows must survive the rollback of a later one.
      const ok = await persist(s, telemetryFor("sess-ok"));
      expect(ok.errors ?? []).toEqual([]);

      const bad = telemetryFor("sess-bad");
      const { verdict: _dropped, ...verdictWithoutVerdict } = bad.reviewVerdict!;
      const res = await persist(s, { ...bad, reviewVerdict: verdictWithoutVerdict });

      expect(res.errors).toEqual([
        expect.objectContaining({ code: "missing_required_field", path: [KEY], message: expect.stringContaining("'verdict'") }),
      ]);
      expect(res.data[KEY]).toBeUndefined();
      expect(await countsFor(s, "sess-bad")).toEqual({ SessionEvent: 0, TranscriptEntry: 0, WorkerResult: 0, ReviewVerdict: 0 });
      expect(await countsFor(s, "sess-ok")).toEqual({ SessionEvent: 1, TranscriptEntry: 1, WorkerResult: 1, ReviewVerdict: 1 });
    } finally {
      await s.stop();
    }
  });
});
