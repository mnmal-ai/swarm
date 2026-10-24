import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import type { TelemetryAdapter, OversightRunner, RunOptions } from "@mnmal-ai/swarm-types";

/**
 * Minimal mock SubstrateClient that satisfies Swarm construction.
 */
function createMockSubstrateClient() {
  return {
    query: vi.fn(async () => []),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

describe("Swarm dependency injection", () => {
  it("constructs without optional adapters", () => {
    const swarm = new Swarm(
      { swarmPath: "/tmp/test", provider: "anthropic", model: "test" },
      { queryClient: createMockSubstrateClient() as any },
    );
    expect(swarm).toBeDefined();
  });

  it("accepts telemetry adapter", () => {
    const mockTelemetry: TelemetryAdapter = {
      name: "mock",
      kind: "telemetry",
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
      emit: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      buildEvent: vi.fn().mockReturnValue({
        id: "test",
        timestamp: new Date().toISOString(),
        session_id: "test",
        role: "worker" as const,
        model: { provider: "anthropic", model_id: "test" },
        swarm_version: { commit_sha: "test" },
        intent: "test",
        swarm_files_loaded: [],
        context_tokens_used: 0,
        tokens: { input: 0, output: 0 },
        latency_ms: 0,
      }),
      emitOversightEvent: vi.fn().mockResolvedValue(undefined),
    };
    const swarm = new Swarm(
      { swarmPath: "/tmp/test", provider: "anthropic", model: "test" },
      { queryClient: createMockSubstrateClient() as any, telemetry: mockTelemetry },
    );
    expect(swarm).toBeDefined();
  });

  it("throws when runWithOversight called without oversight adapter", async () => {
    const swarm = new Swarm(
      {
        swarmPath: "/tmp/test",
        provider: "anthropic",
        model: "test",
        oversight: { enabled: true, reviewerModel: "test" },
      },
      { queryClient: createMockSubstrateClient() as any },
    );

    // Spy on run() to return a canned worker result (avoids needing real API keys)
    vi.spyOn(swarm, "run").mockResolvedValue({
      output: "test output",
      intent: "code-review",
      filesLoaded: [],
      tokensUsed: { context: 0, input: 0, output: 0 },
      latencyMs: 0,
      sessionId: "sess-test",
      telemetryEventId: "evt-test",
      backendType: "api",
    });

    await expect(
      swarm.runWithOversight("test", { input: "test" } as RunOptions),
    ).rejects.toThrow("requires an OversightRunner");
  });

  it("calls OversightRunner.runFullChain when oversight is enabled", async () => {
    const mockRunner: OversightRunner = {
      runFullChain: vi.fn().mockResolvedValue({
        verdict: "approved",
        retryCount: 0,
        arbiterInvolved: false,
        humanEscalation: false,
        rejectionReasons: [],
        totalResolutionTimeMs: 120,
      }),
    };

    const swarm = new Swarm(
      {
        swarmPath: "/tmp/test",
        provider: "anthropic",
        model: "test",
        oversight: { enabled: true, reviewerModel: "test" },
      },
      { queryClient: createMockSubstrateClient() as any, oversight: mockRunner },
    );

    vi.spyOn(swarm, "run").mockResolvedValue({
      output: "worker output for review",
      intent: "code-review",
      filesLoaded: [],
      tokensUsed: { context: 0, input: 0, output: 0 },
      latencyMs: 0,
      sessionId: "sess-test",
      telemetryEventId: "evt-test",
      backendType: "api",
    });

    // Mock private internals so the test doesn't need a real swarm.json on disk
    const swarmAny = swarm as any;
    swarmAny.router = {
      classify: vi.fn().mockResolvedValue({
        intent: "code-review",
        route: { intent: "code-review", load: { core: [], mode: [] } },
        confidence: "exact",
        matchedKeywords: ["review"],
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
      loadByPaths: vi.fn().mockResolvedValue([]),
    };
    swarmAny.skillFetcher = {
      prefetch: vi.fn().mockResolvedValue({ intent: "code-review", load: { core: [], mode: [] } }),
    };

    const result = await swarm.runWithOversight("review this code", {
      input: "test input",
    } as RunOptions);

    expect(mockRunner.runFullChain).toHaveBeenCalledOnce();
    expect(result.oversight.verdict).toBe("approved");
    expect(result.output).toBe("worker output for review");
  });

  it("returns skipped verdict when oversight is disabled (no runner needed)", async () => {
    const swarm = new Swarm(
      {
        swarmPath: "/tmp/test",
        provider: "anthropic",
        model: "test",
        // oversight not enabled
      },
      { queryClient: createMockSubstrateClient() as any },
    );

    vi.spyOn(swarm, "run").mockResolvedValue({
      output: "test output",
      intent: "code-review",
      filesLoaded: [],
      tokensUsed: { context: 0, input: 0, output: 0 },
      latencyMs: 0,
      sessionId: "sess-test",
      backendType: "api",
    });

    const result = await swarm.runWithOversight("test", { input: "test" } as RunOptions);
    expect(result.oversight.verdict).toBe("skipped");
  });
});
