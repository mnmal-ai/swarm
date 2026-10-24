import { describe, it, expect, vi } from "vitest";
import { Oversight } from "../src/index.js";
import type { ExecutionResult, ModelProvider } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Mock SubstrateClient that records observe() calls (the plane surface). Mirrors
// the createMockSubstrateClient in substrate-entities.test.ts but adds observe so the
// structural feature-detection in Oversight.observePlane fires.
// ---------------------------------------------------------------------------

interface ObserveCall {
  kind: string;
  content: string;
  tags?: string[];
  confidence?: number;
}

function createMockSubstrateClient(observeImpl?: () => Promise<unknown>) {
  const observeCalls: ObserveCall[] = [];
  return {
    observeCalls,
    query: vi.fn(async () => []),
    mutate: vi.fn(async () => ({ id: 1 })),
    observe: vi.fn(async (req: ObserveCall) => {
      observeCalls.push(req);
      return observeImpl ? observeImpl() : { id: observeCalls.length };
    }),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

function createMockProvider(response: string): ModelProvider {
  return {
    name: "anthropic",
    execute: vi.fn<(input: { systemContext: string; prompt: string }, model: string) => Promise<ExecutionResult>>()
      .mockResolvedValue({
        output: response,
        tokens: { input: 100, output: 50 },
        latencyMs: 500,
        model: { provider: "anthropic", modelId: "test-model" },
      }),
  };
}

const approveJson = JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] });
const rejectJson = JSON.stringify({
  verdict: "rejected",
  reasons: ["code is incomplete", "missing tests"],
  suggestions: ["add tests"],
});
const arbiterApproveJson = JSON.stringify({ verdict: "approved", reasoning: "output is acceptable" });
const arbiterEscalateJson = JSON.stringify({ verdict: "escalate", reasoning: "needs human review" });

const validWorkerOutput =
  "This is a comprehensive worker output that exceeds the minimum character threshold and contains meaningful content about the implementation.";

describe("plane observations for reviewer + arbiter roles", () => {
  it("observes the reviewer approval tagged role 'reviewer' with no rejection reasons", async () => {
    const substrate = createMockSubstrateClient();
    const oversight = new Oversight({
      reviewerProvider: createMockProvider(approveJson),
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterApproveJson),
      arbiterModel: "test-model",
      substrateClient: substrate as any,
    });

    await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 0,
      sessionId: "sess-obs-approve",
    });

    const reviewerObs = substrate.observeCalls.filter((c) => c.tags?.includes("reviewer"));
    expect(reviewerObs).toHaveLength(1);
    expect(reviewerObs[0].tags).toEqual(["reviewer", "verdict"]);
    expect(reviewerObs[0].kind).toBe("lifecycle");
    expect(reviewerObs[0].content).toBe("reviewer approved");
    // Approvals are lower signal than rejections.
    expect(reviewerObs[0].confidence).toBe(55);
    // A clean approval needs no arbiter, so no arbiter observation.
    expect(substrate.observeCalls.filter((c) => c.tags?.includes("arbiter"))).toHaveLength(0);
  });

  it("observes a reviewer rejection as a 'concern' with its reasons and higher confidence", async () => {
    const substrate = createMockSubstrateClient();
    const oversight = new Oversight({
      reviewerProvider: createMockProvider(rejectJson),
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterApproveJson),
      arbiterModel: "test-model",
      substrateClient: substrate as any,
    });

    await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 0, // straight to arbiter
      sessionId: "sess-obs-reject",
    });

    const reviewerObs = substrate.observeCalls.filter((c) => c.tags?.includes("reviewer"));
    expect(reviewerObs).toHaveLength(1);
    expect(reviewerObs[0].kind).toBe("concern");
    expect(reviewerObs[0].confidence).toBe(70);
    expect(reviewerObs[0].content).toContain("reviewer rejected");
    expect(reviewerObs[0].content).toContain("code is incomplete");

    // Arbiter ran (reject -> arbiter): observed as a resolution.
    const arbiterObs = substrate.observeCalls.filter((c) => c.tags?.includes("arbiter"));
    expect(arbiterObs).toHaveLength(1);
    expect(arbiterObs[0].tags).toEqual(["arbiter", "resolution"]);
    expect(arbiterObs[0].kind).toBe("lifecycle");
    expect(arbiterObs[0].content).toBe("arbiter approved: output is acceptable");
    expect(arbiterObs[0].confidence).toBe(70);
  });

  it("escalation is the highest-signal arbiter observation ('concern', confidence 80)", async () => {
    const substrate = createMockSubstrateClient();
    const oversight = new Oversight({
      reviewerProvider: createMockProvider(rejectJson),
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterEscalateJson),
      arbiterModel: "test-model",
      substrateClient: substrate as any,
    });

    await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 0,
      sessionId: "sess-obs-escalate",
    });

    const arbiterObs = substrate.observeCalls.filter((c) => c.tags?.includes("arbiter"));
    expect(arbiterObs).toHaveLength(1);
    expect(arbiterObs[0].kind).toBe("concern");
    expect(arbiterObs[0].confidence).toBe(80);
    expect(arbiterObs[0].content).toBe("arbiter escalate: needs human review");
  });

  it("emits one reviewer observation per review attempt (initial + retry)", async () => {
    const substrate = createMockSubstrateClient();
    const reviewerProvider: ModelProvider = {
      name: "anthropic",
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          output: rejectJson,
          tokens: { input: 100, output: 50 },
          latencyMs: 500,
          model: { provider: "anthropic", modelId: "test" },
        })
        .mockResolvedValueOnce({
          output: approveJson,
          tokens: { input: 100, output: 50 },
          latencyMs: 500,
          model: { provider: "anthropic", modelId: "test" },
        }),
    };
    const oversight = new Oversight({
      reviewerProvider,
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterApproveJson),
      arbiterModel: "test-model",
      substrateClient: substrate as any,
    });

    await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 2,
      sessionId: "sess-obs-retry",
      onRetry: vi.fn().mockResolvedValue(
        "Improved output with tests and documentation that addresses reviewer feedback fully.",
      ),
    });

    const reviewerObs = substrate.observeCalls.filter((c) => c.tags?.includes("reviewer"));
    expect(reviewerObs).toHaveLength(2);
    expect(reviewerObs[0].content).toContain("reviewer rejected");
    expect(reviewerObs[1].content).toBe("reviewer approved");
    // Approval ended the chain; no arbiter.
    expect(substrate.observeCalls.filter((c) => c.tags?.includes("arbiter"))).toHaveLength(0);
  });

  it("a rejecting observe() never breaks the oversight flow (fire-and-forget)", async () => {
    const substrate = createMockSubstrateClient(() => Promise.reject(new Error("plane down")));
    const oversight = new Oversight({
      reviewerProvider: createMockProvider(approveJson),
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterApproveJson),
      arbiterModel: "test-model",
      substrateClient: substrate as any,
    });

    const result = await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 0,
      sessionId: "sess-obs-failsafe",
    });

    // The verdict is unaffected by the failing plane write.
    expect(result.verdict).toBe("approved");
    expect(substrate.observe).toHaveBeenCalled();
  });

  it("no observations when the client has no observe() helper (file-only mode)", async () => {
    // A client lacking observe — structural feature-detection must skip silently.
    const legacyClient = {
      query: vi.fn(async () => []),
      mutate: vi.fn(async () => ({ id: 1 })),
      propose: vi.fn(),
      getSchema: vi.fn(),
      hasType: vi.fn(),
      invalidateSchema: vi.fn(),
      isHealthy: vi.fn(async () => true),
    };
    const oversight = new Oversight({
      reviewerProvider: createMockProvider(rejectJson),
      reviewerModel: "test-model",
      arbiterProvider: createMockProvider(arbiterEscalateJson),
      arbiterModel: "test-model",
      substrateClient: legacyClient as any,
    });

    const result = await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "implement the feature",
      workerOutput: validWorkerOutput,
      maxRetries: 0,
      sessionId: "sess-obs-legacy",
    });

    expect(result.arbiterInvolved).toBe(true);
  });
});
