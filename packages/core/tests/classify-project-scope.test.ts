import { describe, it, expect, vi } from "vitest";
import { Swarm } from "../src/index.js";
import type { SwarmConfig, IWorkerBackend, OversightRunner, RunOptions } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Several projects can share one store. The worker's context is scoped to the
// run's project through prepareTask; the Router's classify (the reviewer's
// route in runWithOversight, and run()'s per-step fallback) must be scoped to
// the same project, not to the Router's constructor default ("", every
// project). A caller that names no project still gets that default.
// ---------------------------------------------------------------------------

const ROUTES = [
  {
    intent: "implementation",
    description: "Build it.",
    keywords: JSON.stringify(["implement"]),
    contentPaths: JSON.stringify(["core/rules.md"]),
  },
];
const CONTENT = [
  { path: "core/rules.md", tier: "core", intent: "", content: "# Rules", tokenEstimate: 2, lastReviewed: "", projectId: "acme" },
];

function makeClient() {
  return {
    query: vi.fn(async (type: string) => {
      if (type === "SwarmRoute") return ROUTES;
      if (type === "SwarmContent") return CONTENT;
      return [];
    }),
    classifyIntent: vi.fn(async () => ({ intent: "implementation", confidence: "keyword", matchedKeywords: ["implement"] })),
  };
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

function makeBackend(): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: vi.fn(async () => ({
      output: "worker completed the implementation as described",
      tokensUsed: { input: 10, output: 20 },
      latencyMs: 5,
    })),
  } as unknown as IWorkerBackend;
}

function makeSwarm(client: ReturnType<typeof makeClient>, oversight: OversightRunner): Swarm {
  const config = {
    swarmPath: "/tmp/swarm-classify-project-scope-test",
    provider: "anthropic",
    model: "test-model",
    oversight: { enabled: true, reviewerModel: "test" },
    workerBackend: makeBackend(),
  } as SwarmConfig;
  const swarm = new Swarm(config, { queryClient: client as any, oversight });
  (swarm as any).skillFetcher = { prefetch: vi.fn(async (route: unknown) => route) };
  return swarm;
}

describe("Router.classify is scoped to the run's project", () => {
  it("runWithOversight sends the run's project to classifyIntent", async () => {
    const client = makeClient();
    const oversight = makeOversight();

    await makeSwarm(client, oversight).runWithOversight("implement it", { input: "go", project: "acme" } as RunOptions);

    expect(oversight.runFullChain).toHaveBeenCalledTimes(1);
    // Twice: the worker's per-step preamble (this client has no prepareTask)
    // and the reviewer's route.
    expect(client.classifyIntent).toHaveBeenCalledTimes(2);
    for (const [request] of client.classifyIntent.mock.calls as unknown as Array<[{ projectId: string }]>) {
      expect(request.projectId).toBe("acme");
    }
  });

  it("a run that names no project still sends the Router's default", async () => {
    const client = makeClient();

    await makeSwarm(client, makeOversight()).runWithOversight("implement it", { input: "go" } as RunOptions);

    expect(client.classifyIntent).toHaveBeenCalledTimes(2);
    for (const [request] of client.classifyIntent.mock.calls as unknown as Array<[{ projectId: string }]>) {
      expect(request.projectId).toBe("");
    }
  });
});
