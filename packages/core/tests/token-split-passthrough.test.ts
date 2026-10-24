import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import type { SwarmConfig, IWorkerBackend, OversightRunner, RunOptions } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// A direct-execution backend reports how much of its input came from the
// prompt cache. Swarm must hand that split on in the run result, so the CLI
// can show fresh input apart from cached input on the dashboard. The input
// total itself is unchanged: the token budgets count all input.
// ---------------------------------------------------------------------------

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

function makeBackend(tokensUsed: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: async () => ({
      output: "worker completed the implementation as described",
      tokensUsed,
      latencyMs: 5,
    }),
  } as unknown as IWorkerBackend;
}

function makeSwarm(backend: IWorkerBackend): Swarm {
  const swarm = new Swarm(
    {
      swarmPath: "/tmp/swarm-token-split-test",
      provider: "anthropic",
      model: "test-model",
      oversight: { enabled: true, reviewerModel: "test" },
      workerBackend: backend,
    } as SwarmConfig,
    { queryClient: { query: async () => [] } as any, oversight: makeOversight() },
  );
  // Stub the on-disk router/loader/skill internals so no swarm.json is needed.
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
  return swarm;
}

describe("Swarm carries the backend's cache split into the run result", () => {
  it("passes cache reads and writes through beside the unchanged input total", async () => {
    const swarm = makeSwarm(makeBackend({ input: 1_000, output: 50, cacheRead: 900, cacheWrite: 60 }));

    const result = await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(result.tokensUsed).toMatchObject({ input: 1_000, output: 50, cacheRead: 900, cacheWrite: 60 });
  });

  it("leaves the split out when the backend reports none", async () => {
    const swarm = makeSwarm(makeBackend({ input: 300, output: 20 }));

    const result = await swarm.runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(result.tokensUsed.cacheRead).toBeUndefined();
    expect(result.tokensUsed.cacheWrite).toBeUndefined();
    expect(result.tokensUsed).toMatchObject({ input: 300, output: 20 });
  });
});
