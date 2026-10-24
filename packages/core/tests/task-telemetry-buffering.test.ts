import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import { TaskTelemetryBuffer } from "@mnmal-ai/swarm-substrate";
import type {
  SwarmConfig,
  SwarmEvent,
  IWorkerBackend,
  OversightRunner,
  RunOptions,
  TelemetryAdapter,
  TranscriptEntry,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Fakes that honor the buffering contract the concrete Telemetry / Oversight
// implement. The real per-row buffering is covered in those packages' tests;
// here we exercise SWARM's coordination: attach a buffer, route the worker rows
// into it, flush atomically, and fall back to per-row when the resolver is gone.
// ---------------------------------------------------------------------------

function makeBufferingTelemetry() {
  let buffer: TaskTelemetryBuffer | undefined;
  const perRow = { events: 0, transcripts: 0 };
  const adapter: TelemetryAdapter & {
    setTaskBuffer(b?: TaskTelemetryBuffer): void;
    emitTranscript(e: TranscriptEntry): Promise<void>;
  } = {
    name: "fake",
    kind: "telemetry",
    healthCheck: async () => ({ healthy: true }),
    flush: async () => {},
    emitOversightEvent: vi.fn(async () => {}),
    buildEvent: (p) => ({
      id: "evt-fake",
      timestamp: "2026-05-30T00:00:00.000Z",
      session_id: p.sessionId,
      role: p.role,
      model: { provider: p.provider, model_id: p.modelId },
      swarm_version: { commit_sha: p.swarmCommitSha },
      intent: p.intent,
      swarm_files_loaded: p.filesLoaded,
      context_tokens_used: p.contextTokensUsed,
      tokens: { input: p.inputTokens, output: p.outputTokens },
      latency_ms: p.latencyMs,
    }),
    setTaskBuffer(b) {
      buffer = b;
    },
    emit: vi.fn(async (event: SwarmEvent) => {
      if (buffer) {
        buffer.setSessionEvent({
          eventId: event.id,
          sessionId: event.session_id,
          role: event.role,
          provider: event.model?.provider ?? "",
          modelId: event.model?.model_id ?? "",
          intent: event.intent ?? "",
          swarmFilesLoaded: JSON.stringify(event.swarm_files_loaded ?? []),
          contextTokensUsed: event.context_tokens_used ?? 0,
          inputTokens: event.tokens?.input ?? 0,
          outputTokens: event.tokens?.output ?? 0,
          latencyMs: event.latency_ms ?? 0,
          timestamp: event.timestamp,
        });
        return;
      }
      perRow.events++;
    }),
    emitTranscript: vi.fn(async (entry: TranscriptEntry) => {
      if (buffer) {
        buffer.setTranscript({
          sessionId: entry.sessionId,
          role: entry.role,
          prompt: entry.prompt,
          response: entry.response,
          inputTokens: entry.tokens?.input ?? 0,
          outputTokens: entry.tokens?.output ?? 0,
          backend: entry.backend,
          timestamp: entry.timestamp,
        });
        return;
      }
      perRow.transcripts++;
    }),
  };
  return { adapter, perRow };
}

function makeBufferingOversight() {
  let buffer: TaskTelemetryBuffer | undefined;
  const perRow = { workerResults: 0, reviewVerdicts: 0 };
  const runner: OversightRunner & { setTaskBuffer(b?: TaskTelemetryBuffer): void } = {
    setTaskBuffer(b) {
      buffer = b;
    },
    runFullChain: vi.fn(async (params) => {
      if (buffer) {
        buffer.setWorkerResult({
          sessionId: params.sessionId,
          intent: "",
          output: params.workerOutput,
          diff: "",
          filesModified: "[]",
          tokenUsage: 0,
          timestamp: "2026-05-30T00:00:00.000Z",
        });
        buffer.setReviewVerdict({
          sessionId: params.sessionId,
          workerResultId: "",
          verdict: "approved",
          reasons: "[]",
          suggestions: "[]",
          attempt: 0,
          timestamp: "2026-05-30T00:00:00.000Z",
        });
      } else {
        perRow.workerResults++;
        perRow.reviewVerdicts++;
      }
      return {
        verdict: "approved" as const,
        retryCount: 0,
        arbiterInvolved: false,
        humanEscalation: false,
        rejectionReasons: [],
        totalResolutionTimeMs: 1,
      };
    }),
  };
  return { runner, perRow };
}

const fakeBackend: IWorkerBackend = {
  type: "claude-code",
  supportsDirectExecution: true,
  isAvailable: async () => true,
  execute: async () => ({
    output: "worker completed the implementation as described",
    tokensUsed: { input: 10, output: 20 },
    latencyMs: 5,
  }),
} as unknown as IWorkerBackend;

function makeConfig(): SwarmConfig {
  return {
    swarmPath: "/tmp/swarm-buffer-test",
    provider: "anthropic",
    model: "test-model",
    oversight: { enabled: true, reviewerModel: "test" },
    workerBackend: fakeBackend,
  } as SwarmConfig;
}

/** Stub the on-disk router/loader/skill internals so no swarm.json is needed. */
function stubSwarmInternals(swarm: Swarm): void {
  const swarmAny = swarm as any;
  const route = { intent: "implementation", description: "", load: { core: [], mode: [] }, keywords: [] };
  swarmAny.router = {
    classify: vi.fn().mockResolvedValue({
      intent: "implementation",
      route,
      confidence: "exact",
      matchedKeywords: [],
    }),
    getBudget: vi.fn().mockResolvedValue(15000),
    getLoadingPriority: vi.fn().mockResolvedValue([]),
  };
  swarmAny.loader = {
    load: vi.fn().mockResolvedValue({
      files: [],
      totalTokens: 0,
      budgetMax: 15000,
      budgetUsedPercent: 0,
      truncated: [],
    }),
    assembleContext: vi.fn().mockReturnValue(""),
    loadByPaths: vi.fn().mockResolvedValue([]),
  };
  swarmAny.skillFetcher = { prefetch: vi.fn().mockResolvedValue(route) };
}

describe("Swarm per-task telemetry buffering + atomic flush", () => {
  it("flushes all four buffered rows in ONE persistTaskTelemetry call", async () => {
    const persistTaskTelemetry = vi.fn(async () => ({
      ids: { sessionEvent: "1", transcript: "2", workerResult: "3", reviewVerdict: "4" },
    }));
    const queryClient = { query: vi.fn(async () => []), persistTaskTelemetry } as any;

    const { adapter } = makeBufferingTelemetry();
    const { runner } = makeBufferingOversight();

    const swarm = new Swarm(makeConfig(), { queryClient, telemetry: adapter, oversight: runner });
    stubSwarmInternals(swarm);

    const result = await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(result.oversight.verdict).toBe("approved");
    expect(persistTaskTelemetry).toHaveBeenCalledOnce();

    const req = persistTaskTelemetry.mock.calls[0][0] as any;
    expect(req.sessionEvent).toMatchObject({ sessionId: result.sessionId, role: "worker" });
    expect(req.transcript).toMatchObject({ role: "worker" });
    expect(req.workerResult).toMatchObject({
      output: "worker completed the implementation as described",
    });
    expect(req.reviewVerdict).toMatchObject({ verdict: "approved" });
  });

  it("detaches the buffer after the task (no leak into a follow-up run)", async () => {
    const persistTaskTelemetry = vi.fn(async () => ({
      ids: { sessionEvent: "1", transcript: "2", workerResult: "3" },
    }));
    const queryClient = { query: vi.fn(async () => []), persistTaskTelemetry } as any;
    const { adapter } = makeBufferingTelemetry();
    const { runner } = makeBufferingOversight();
    const setSpy = vi.spyOn(adapter, "setTaskBuffer");

    const swarm = new Swarm(makeConfig(), { queryClient, telemetry: adapter, oversight: runner });
    stubSwarmInternals(swarm);
    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    // Attached once (a buffer) then detached once (undefined).
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(setSpy.mock.calls[0][0]).toBeInstanceOf(TaskTelemetryBuffer);
    expect(setSpy.mock.calls[1][0]).toBeUndefined();
  });

  it("falls back to per-row writes when the client lacks persistTaskTelemetry", async () => {
    const queryClient = { query: vi.fn(async () => []) } as any; // no persistTaskTelemetry

    const { adapter, perRow } = makeBufferingTelemetry();
    const { runner, perRow: ovPerRow } = makeBufferingOversight();
    const setSpy = vi.spyOn(adapter, "setTaskBuffer");

    const swarm = new Swarm(makeConfig(), { queryClient, telemetry: adapter, oversight: runner });
    stubSwarmInternals(swarm);

    const result = await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(result.oversight.verdict).toBe("approved");
    // No buffer was ever attached → the adapters took the per-row path.
    expect(setSpy).not.toHaveBeenCalled();
    expect(perRow.events).toBe(1);
    expect(perRow.transcripts).toBe(1);
    expect(ovPerRow.workerResults).toBe(1);
    expect(ovPerRow.reviewVerdicts).toBe(1);
  });

  it("is non-blocking: a persistTaskTelemetry failure does not break the run", async () => {
    const persistTaskTelemetry = vi.fn(async () => {
      throw new Error("sidecar down");
    });
    const queryClient = { query: vi.fn(async () => []), persistTaskTelemetry } as any;
    const { adapter } = makeBufferingTelemetry();
    const { runner } = makeBufferingOversight();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const swarm = new Swarm(makeConfig(), { queryClient, telemetry: adapter, oversight: runner });
    stubSwarmInternals(swarm);

    const result = await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(result.oversight.verdict).toBe("approved");
    expect(persistTaskTelemetry).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("persistTaskTelemetry failed (non-blocking)"),
    );
    warnSpy.mockRestore();
  });
});
