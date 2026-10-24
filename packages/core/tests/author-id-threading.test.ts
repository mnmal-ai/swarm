import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import type {
  SwarmConfig,
  ISwarmEventBus,
  IWorkerBackend,
  OversightRunner,
  RunOptions,
  TelemetryAdapter,
  TranscriptEntry,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// The CLI resolves an authorId once per session and sets it on SwarmConfig.
// Swarm is the connective tissue between that config and the telemetry/oversight
// write paths: it must thread config.authorId into every buildEvent() call and
// into the oversight runFullChain() params, so the persisted SessionEvent,
// WorkerResult, and ReviewVerdict rows all carry it. These tests lock that in.
// ---------------------------------------------------------------------------

function makeTelemetry(): TelemetryAdapter {
  return {
    name: "fake",
    kind: "telemetry",
    healthCheck: async () => ({ healthy: true }),
    flush: async () => {},
    emit: vi.fn(async () => {}),
    emitOversightEvent: vi.fn(async () => {}),
    buildEvent: vi.fn((p) => ({
      id: "evt-fake",
      timestamp: "2026-06-01T00:00:00.000Z",
      session_id: p.sessionId,
      role: p.role,
      model: { provider: p.provider, model_id: p.modelId },
      swarm_version: { commit_sha: p.swarmCommitSha },
      intent: p.intent,
      swarm_files_loaded: p.filesLoaded,
      context_tokens_used: p.contextTokensUsed,
      tokens: { input: p.inputTokens, output: p.outputTokens },
      latency_ms: p.latencyMs,
      authorId: p.authorId,
    })),
  } as unknown as TelemetryAdapter;
}

function makeOversight(): OversightRunner {
  return {
    runFullChain: vi.fn(async () => ({
      verdict: "approved" as const,
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
      rejectionReasons: [],
      totalResolutionTimeMs: 1,
    })),
  };
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

function makeConfig(authorId?: string): SwarmConfig {
  return {
    swarmPath: "/tmp/swarm-authorid-test",
    provider: "anthropic",
    model: "test-model",
    oversight: { enabled: true, reviewerModel: "test" },
    workerBackend: fakeBackend,
    authorId,
  } as SwarmConfig;
}

/** Minimal event bus that records every transcript entry it sees. */
function makeCapturingEventBus(captured: TranscriptEntry[]): ISwarmEventBus {
  return {
    emit: (event: string, payload: unknown) => {
      if (event === "transcript") captured.push(payload as TranscriptEntry);
    },
    on: () => {},
    off: () => {},
  } as unknown as ISwarmEventBus;
}

/** Stub the on-disk router/loader/skill internals so no swarm.json is needed. */
function stubSwarmInternals(swarm: Swarm): void {
  const swarmAny = swarm as any;
  const route = { intent: "implementation", description: "", load: { core: [], mode: [] }, keywords: [] };
  swarmAny.router = {
    classify: vi.fn().mockResolvedValue({ intent: "implementation", route, confidence: "exact", matchedKeywords: [] }),
    getBudget: vi.fn().mockResolvedValue(15000),
    getLoadingPriority: vi.fn().mockResolvedValue([]),
  };
  swarmAny.loader = {
    load: vi.fn().mockResolvedValue({ files: [], totalTokens: 0, budgetMax: 15000, budgetUsedPercent: 0, truncated: [] }),
    assembleContext: vi.fn().mockReturnValue(""),
    loadByPaths: vi.fn().mockResolvedValue([]),
  };
  swarmAny.skillFetcher = { prefetch: vi.fn().mockResolvedValue(route) };
}

describe("Swarm threads config.authorId into telemetry + oversight write paths", () => {
  it("passes config.authorId into buildEvent and runFullChain", async () => {
    const telemetry = makeTelemetry();
    const oversight = makeOversight();
    const swarm = new Swarm(makeConfig("alice@example.com"), { queryClient: { query: async () => [] } as any, telemetry, oversight });
    stubSwarmInternals(swarm);

    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(telemetry.buildEvent).toHaveBeenCalled();
    const builtWithAuthor = (telemetry.buildEvent as any).mock.calls.some(
      (c: any[]) => c[0].authorId === "alice@example.com",
    );
    expect(builtWithAuthor).toBe(true);

    expect(oversight.runFullChain).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "alice@example.com" }),
    );
  });

  it("stamps config.authorId onto the emitted worker TranscriptEntry", async () => {
    // The transcript is a distinct construction path from buildEvent — it must
    // carry authorId independently so every persisted transcript row is attributable.
    const telemetry = makeTelemetry();
    const oversight = makeOversight();
    const captured: TranscriptEntry[] = [];
    const swarm = new Swarm(makeConfig("alice@example.com"), {
      queryClient: { query: async () => [] } as any,
      telemetry,
      oversight,
      eventBus: makeCapturingEventBus(captured),
    });
    stubSwarmInternals(swarm);

    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    const workerTranscripts = captured.filter((t) => t.role === "worker");
    expect(workerTranscripts.length).toBeGreaterThan(0);
    for (const t of workerTranscripts) {
      expect(t.authorId).toBe("alice@example.com");
    }
  });

  it("forwards undefined when no authorId is configured (taxonomy optional)", async () => {
    const telemetry = makeTelemetry();
    const oversight = makeOversight();
    const swarm = new Swarm(makeConfig(undefined), { queryClient: { query: async () => [] } as any, telemetry, oversight });
    stubSwarmInternals(swarm);

    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    const firstBuild = (telemetry.buildEvent as any).mock.calls[0][0];
    expect(firstBuild.authorId).toBeUndefined();
    expect(oversight.runFullChain).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: undefined }),
    );
  });
});
