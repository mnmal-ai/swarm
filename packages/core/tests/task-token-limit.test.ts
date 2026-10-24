import { describe, it, expect, vi, beforeEach } from "vitest";
import { Swarm } from "../src/index.js";
import type { SwarmConfig, IWorkerBackend, RunOptions } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// The per-task limit is in tokens: all input (cache reads and writes
// included) plus output. The API agentic loop stops when a task reaches it;
// a direct-execution backend (Claude Code) can't be stopped mid-run, so its
// result is flagged instead. Neither reports a dollar figure.
// ---------------------------------------------------------------------------

let turnTokens = { input: 400, output: 100 };

vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      execute: async () => ({ output: "", tokens: { input: 0, output: 0 }, latencyMs: 0, model: { provider: "anthropic", modelId: "m" } }),
      // Always asks for another (unknown, harmless) tool, so only a limit stops the loop.
      executeWithTools: async () => ({
        response: {},
        outputText: "working",
        inputTokens: turnTokens.input,
        outputTokens: turnTokens.output,
        stopReason: "tool_use",
        toolUseBlocks: [{ id: "tu_1", name: "no_such_tool", input: {} }],
        assistantMessage: { role: "assistant", content: "working" },
      }),
    }),
  };
});

function directBackend(tokensUsed: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: async () => ({ output: "worker completed the implementation as described", tokensUsed, latencyMs: 5, filesChanged: [], backendUsed: "claude-code" }),
  } as unknown as IWorkerBackend;
}

function makeSwarm(workerBackend?: IWorkerBackend): Swarm {
  const swarm = new Swarm(
    {
      swarmPath: "/tmp/swarm-task-token-limit-test",
      provider: "anthropic",
      model: "test-model",
      apiKey: "test-key",
      oversight: { enabled: false, reviewerModel: "test" },
      ...(workerBackend ? { workerBackend } : {}),
    } as SwarmConfig,
    { queryClient: { query: async () => [] } as any },
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
  return swarm;
}

beforeEach(() => {
  turnTokens = { input: 400, output: 100 };
});

describe("task token limit — direct-execution backend", () => {
  it("flags a result whose input (cache included) plus output reaches the limit", async () => {
    const swarm = makeSwarm(directBackend({ input: 900, output: 100, cacheRead: 800, cacheWrite: 50 }));

    const result = await swarm.run("implement it", { input: "go", taskTokenLimit: 1_000 } as RunOptions);

    expect(result.tokenLimitExceeded).toBe(true);
  });

  it("does not flag a result under the limit", async () => {
    const swarm = makeSwarm(directBackend({ input: 800, output: 100 }));

    const result = await swarm.run("implement it", { input: "go", taskTokenLimit: 1_000 } as RunOptions);

    expect(result.tokenLimitExceeded).toBe(false);
  });

  it("reports no dollar figure", async () => {
    const swarm = makeSwarm(directBackend({ input: 800, output: 100 }));

    const result = await swarm.run("implement it", { input: "go" } as RunOptions);

    expect(result).not.toHaveProperty("costUsd");
  });
});

describe("task token limit — agentic loop", () => {
  it("stops at the first turn that brings the task to its limit", async () => {
    const swarm = makeSwarm();

    // 500 tokens a turn: 500, 1,000, 1,500 — the third turn reaches 1,200.
    const result = await swarm.run("implement it", { input: "go", taskTokenLimit: 1_200, maxTurns: 10 } as RunOptions);

    expect(result.tokenLimitExceeded).toBe(true);
    expect(result.tokensUsed.input + result.tokensUsed.output).toBe(1_500);
    expect(result).not.toHaveProperty("costUsd");
  });

  it("runs to maxTurns when no limit is set", async () => {
    const swarm = makeSwarm();

    const result = await swarm.run("implement it", { input: "go", maxTurns: 4 } as RunOptions);

    expect(result.tokenLimitExceeded).toBe(false);
    expect(result.tokensUsed.input + result.tokensUsed.output).toBe(2_000);
  });
});
