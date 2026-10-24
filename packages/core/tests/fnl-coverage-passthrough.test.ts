import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import type { SwarmConfig, FnlCoverage, IWorkerBackend, OversightRunner, RunOptions, TelemetryAdapter } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// A direct-execution backend reports how its session's Bash commands fared
// with fnl. Swarm hands that on in the session:end event (for the run log and
// the dashboard) and in the session's telemetry record, and leaves it out
// when the backend counted nothing.
// ---------------------------------------------------------------------------

const COVERAGE: FnlCoverage = { buildCommands: 3, wrapped: 1, leftAlone: { structure: 2 }, byTool: { xcodebuild: { wrapped: 1, leftAlone: 2 } }, unanswered: 0 };

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

function makeTelemetry(): TelemetryAdapter {
  return {
    name: "fake",
    kind: "telemetry",
    healthCheck: async () => ({ healthy: true }),
    flush: async () => {},
    emit: vi.fn(async () => {}),
    emitOversightEvent: vi.fn(async () => {}),
    buildEvent: vi.fn((p) => ({ id: "evt", session_id: p.sessionId, role: p.role })),
  } as unknown as TelemetryAdapter;
}

function makeSwarm(fnlCoverage: FnlCoverage | undefined) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const eventBus = { emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }), on: () => () => {} };
  const telemetry = makeTelemetry();
  const backend = {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: async () => ({ output: "worker completed the implementation", tokensUsed: { input: 10, output: 5 }, latencyMs: 5, ...(fnlCoverage ? { fnlCoverage } : {}) }),
  } as unknown as IWorkerBackend;
  const swarm = new Swarm(
    { swarmPath: "/tmp/swarm-fnl-coverage-test", provider: "anthropic", model: "test-model", oversight: { enabled: true, reviewerModel: "test" }, workerBackend: backend } as SwarmConfig,
    { queryClient: { query: async () => [] } as any, oversight: makeOversight(), telemetry, eventBus: eventBus as any },
  );
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
  return { swarm, events, telemetry };
}

describe("Swarm carries the backend's fnl coverage", () => {
  it("into session:end and the session's telemetry record", async () => {
    const { swarm, events, telemetry } = makeSwarm(COVERAGE);
    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    const end = events.find((e) => e.type === "session:end");
    expect(end?.payload.fnl).toEqual(COVERAGE);
    expect((telemetry.buildEvent as any).mock.calls.some((c: any[]) => c[0].fnlCoverage === COVERAGE)).toBe(true);
  });

  it("leaves it out when the backend counted nothing", async () => {
    const { swarm, events, telemetry } = makeSwarm(undefined);
    await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(events.find((e) => e.type === "session:end")?.payload).not.toHaveProperty("fnl");
    expect((telemetry.buildEvent as any).mock.calls.every((c: any[]) => c[0].fnlCoverage === undefined)).toBe(true);
  });
});
