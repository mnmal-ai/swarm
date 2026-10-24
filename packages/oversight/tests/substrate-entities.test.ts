import { describe, it, expect, vi, beforeEach } from "vitest";
import { Oversight } from "../src/index.js";
import { TaskTelemetryBuffer } from "@mnmal-ai/swarm-substrate";
import type { ExecutionResult, ModelProvider } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Mock SubstrateClient that records mutate() calls
// ---------------------------------------------------------------------------

interface MutateCall {
  mutationName: string;
  params: Record<string, unknown>;
  fields: Record<string, unknown>;
}

function createMockSubstrateClient() {
  const calls: MutateCall[] = [];
  return {
    calls,
    query: vi.fn(async () => []),
    mutate: vi.fn(async (mutationName: string, params: Record<string, unknown>, fields: Record<string, unknown>) => {
      calls.push({ mutationName, params, fields });
      return { id: calls.length };
    }),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Mock ModelProvider
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: Substrate entity creation during oversight chain
// ---------------------------------------------------------------------------

describe("Substrate entity creation in oversight chain", () => {
  const approveJson = JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] });
  const rejectJson = JSON.stringify({ verdict: "rejected", reasons: ["code is incomplete"], suggestions: ["add tests"] });
  const arbiterApproveJson = JSON.stringify({ verdict: "approved", reasoning: "output is acceptable" });
  const arbiterEscalateJson = JSON.stringify({ verdict: "escalate", reasoning: "needs human review" });

  const validWorkerOutput = "This is a comprehensive worker output that exceeds the minimum character threshold and contains meaningful content about the implementation.";

  describe("when substrateClient IS provided", () => {
    it("creates a WorkerResult entity after initial review (approved)", async () => {
      const substrate = createMockSubstrateClient();
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-substrate-test",
      });

      // WorkerResult should have been created
      const workerResultCalls = substrate.calls.filter(c => c.mutationName === "createWorkerResult");
      expect(workerResultCalls).toHaveLength(1);
      expect(workerResultCalls[0].params).toMatchObject({
        sessionId: "sess-substrate-test",
        output: validWorkerOutput,
        // Substrate's field.number() refuses a string.
        tokenUsage: 0,
      });
      // Swarm accounts in tokens only: no dollar field on the row.
      expect(workerResultCalls[0].params).not.toHaveProperty("costUsd");
      expect(workerResultCalls[0].fields).toEqual({ id: true });
    });

    it("creates a ReviewVerdict entity after reviewer approves", async () => {
      const substrate = createMockSubstrateClient();
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-substrate-test",
      });

      const reviewVerdictCalls = substrate.calls.filter(c => c.mutationName === "createReviewVerdict");
      expect(reviewVerdictCalls).toHaveLength(1);
      expect(reviewVerdictCalls[0].params).toMatchObject({
        sessionId: "sess-substrate-test",
        verdict: "approved",
        attempt: 0,
      });
      expect(reviewVerdictCalls[0].params.workerResultId).toBeDefined();
      expect(reviewVerdictCalls[0].fields).toEqual({ id: true });
    });

    it("creates ReviewVerdict entities for each retry + final review", async () => {
      const substrate = createMockSubstrateClient();

      // First call rejects, second approves
      const reviewerProvider: ModelProvider = {
        name: "anthropic",
        execute: vi.fn()
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

      const retryOutput = "This is the improved worker output after receiving feedback from the reviewer about missing tests and documentation.";
      const onRetry = vi.fn().mockResolvedValue(retryOutput);

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-retry-test",
        onRetry,
      });

      // Should have 1 WorkerResult
      const workerResultCalls = substrate.calls.filter(c => c.mutationName === "createWorkerResult");
      expect(workerResultCalls).toHaveLength(1);

      // Should have 2 ReviewVerdict entities (initial rejection + retry approval)
      const reviewVerdictCalls = substrate.calls.filter(c => c.mutationName === "createReviewVerdict");
      expect(reviewVerdictCalls).toHaveLength(2);

      // First review: rejected, attempt 0
      expect(reviewVerdictCalls[0].params.verdict).toBe("rejected");
      expect(reviewVerdictCalls[0].params.attempt).toBe(0);

      // Second review: approved, attempt 1
      expect(reviewVerdictCalls[1].params.verdict).toBe("approved");
      expect(reviewVerdictCalls[1].params.attempt).toBe(1);
    });

    it("creates an ArbiterDecision entity when arbiter is invoked", async () => {
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
        maxRetries: 0, // no retries — go straight to arbiter
        sessionId: "sess-arbiter-test",
      });

      // Should have arbiter decision
      const arbiterCalls = substrate.calls.filter(c => c.mutationName === "createArbiterDecision");
      expect(arbiterCalls).toHaveLength(1);
      expect(arbiterCalls[0].params).toMatchObject({
        sessionId: "sess-arbiter-test",
        verdict: "approved",
        reasoning: "output is acceptable",
      });
      expect(arbiterCalls[0].params.workerResultId).toBeDefined();
      expect(arbiterCalls[0].params.reviewVerdictId).toBeDefined();
      expect(arbiterCalls[0].fields).toEqual({ id: true });
    });

    it("creates all three entity types in the full reject->arbiter flow", async () => {
      const substrate = createMockSubstrateClient();

      const oversight = new Oversight({
        reviewerProvider: createMockProvider(rejectJson),
        reviewerModel: "test-model",
        arbiterProvider: createMockProvider(arbiterEscalateJson),
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-full-chain",
      });

      expect(result.arbiterInvolved).toBe(true);
      expect(result.humanEscalation).toBe(true);

      // All three entity types should have been created
      expect(substrate.calls.filter(c => c.mutationName === "createWorkerResult")).toHaveLength(1);
      expect(substrate.calls.filter(c => c.mutationName === "createReviewVerdict")).toHaveLength(1);
      expect(substrate.calls.filter(c => c.mutationName === "createArbiterDecision")).toHaveLength(1);
    });

    it("includes timestamp in all Substrate entities", async () => {
      const substrate = createMockSubstrateClient();
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "task",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-ts-test",
      });

      for (const call of substrate.calls) {
        expect(call.params.timestamp).toBeDefined();
        expect(typeof call.params.timestamp).toBe("string");
        // Should be a valid ISO timestamp
        expect(new Date(call.params.timestamp as string).toISOString()).toBe(call.params.timestamp);
      }
    });

    it("threads authorId from runFullChain onto WorkerResult and ReviewVerdict", async () => {
      const substrate = createMockSubstrateClient();
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-author-test",
        authorId: "example-user@example.invalid",
      });

      expect(substrate.calls.find(c => c.mutationName === "createWorkerResult")?.params.authorId)
        .toBe("example-user@example.invalid");
      expect(substrate.calls.find(c => c.mutationName === "createReviewVerdict")?.params.authorId)
        .toBe("example-user@example.invalid");
    });

    it("leaves authorId undefined when runFullChain is not given one", async () => {
      const substrate = createMockSubstrateClient();
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-author-default",
      });

      expect(substrate.calls.find(c => c.mutationName === "createWorkerResult")?.params.authorId)
        .toBeUndefined();
      expect(substrate.calls.find(c => c.mutationName === "createReviewVerdict")?.params.authorId)
        .toBeUndefined();
    });
  });

  describe("when substrateClient is NOT provided (backward compatibility)", () => {
    it("oversight chain works normally without substrateClient", async () => {
      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        // No substrateClient
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-no-substrate",
      });

      expect(result.verdict).toBe("approved");
      expect(result.retryCount).toBe(0);
      expect(result.arbiterInvolved).toBe(false);
    });

    it("arbiter path works without substrateClient", async () => {
      const oversight = new Oversight({
        reviewerProvider: createMockProvider(rejectJson),
        reviewerModel: "test-model",
        arbiterProvider: createMockProvider(arbiterApproveJson),
        arbiterModel: "test-model",
        // No substrateClient
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-no-substrate-arbiter",
      });

      expect(result.verdict).toBe("approved");
      expect(result.arbiterInvolved).toBe(true);
    });

    it("retry path works without substrateClient", async () => {
      const reviewerProvider: ModelProvider = {
        name: "anthropic",
        execute: vi.fn()
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
        // No substrateClient
      });

      const retryOutput = "Improved output with tests and full documentation that addresses all reviewer concerns about completeness.";
      const onRetry = vi.fn().mockResolvedValue(retryOutput);

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-no-substrate-retry",
        onRetry,
      });

      expect(result.verdict).toBe("approved");
      expect(result.retryCount).toBe(1);
    });
  });

  describe("buffered mode (setTaskBuffer)", () => {
    it("buffers WorkerResult + ReviewVerdict instead of writing them per-row", async () => {
      const substrate = createMockSubstrateClient();
      const oversight = new Oversight({
        reviewerProvider: createMockProvider(approveJson),
        reviewerModel: "test-model",
        arbiterProvider: createMockProvider(approveJson),
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });
      const buffer = new TaskTelemetryBuffer();
      oversight.setTaskBuffer(buffer);

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-buffered",
      });

      expect(result.verdict).toBe("approved");
      // No per-row entity writes — the rows live in the buffer for the atomic flush.
      expect(substrate.calls.filter(c => c.mutationName === "createWorkerResult")).toHaveLength(0);
      expect(substrate.calls.filter(c => c.mutationName === "createReviewVerdict")).toHaveLength(0);

      expect(buffer.workerResult).toMatchObject({
        sessionId: "sess-buffered",
        output: validWorkerOutput,
        tokenUsage: 0,
      });
      expect(buffer.workerResult).not.toHaveProperty("costUsd");
      expect(buffer.reviewVerdict).toMatchObject({ verdict: "approved", attempt: 0 });
    });

    it("buffers the final (latest) verdict on retry — last write wins", async () => {
      const substrate = createMockSubstrateClient();
      const reviewerProvider: ModelProvider = {
        name: "anthropic",
        execute: vi.fn()
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
      const buffer = new TaskTelemetryBuffer();
      oversight.setTaskBuffer(buffer);

      await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 2,
        sessionId: "sess-buffered-retry",
        onRetry: vi.fn().mockResolvedValue(
          "Improved output with tests and documentation addressing reviewer feedback fully.",
        ),
      });

      // Only the final verdict survives in the single-envelope buffer.
      expect(buffer.reviewVerdict).toMatchObject({ verdict: "approved", attempt: 1 });
      expect(substrate.calls.filter(c => c.mutationName === "createReviewVerdict")).toHaveLength(0);
    });

    it("does not write a dedicated ArbiterDecision entity in buffered mode", async () => {
      const substrate = createMockSubstrateClient();
      const oversight = new Oversight({
        reviewerProvider: createMockProvider(rejectJson),
        reviewerModel: "test-model",
        arbiterProvider: createMockProvider(arbiterApproveJson),
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });
      const buffer = new TaskTelemetryBuffer();
      oversight.setTaskBuffer(buffer);

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-buffered-arbiter",
      });

      // Verdict outcome is unchanged (cold-test parity), but the exception-path
      // ArbiterDecision row has no atomic-envelope slot, so it is not written.
      expect(result.arbiterInvolved).toBe(true);
      expect(substrate.calls.filter(c => c.mutationName === "createArbiterDecision")).toHaveLength(0);
    });
  });

  describe("Substrate failure resilience", () => {
    it("oversight chain succeeds even when Substrate mutate fails", async () => {
      const substrate = createMockSubstrateClient();
      // Make mutate throw on every call
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));

      const provider = createMockProvider(approveJson);

      const oversight = new Oversight({
        reviewerProvider: provider,
        reviewerModel: "test-model",
        arbiterProvider: provider,
        arbiterModel: "test-model",
        substrateClient: substrate as any,
      });

      // Should still complete successfully — Substrate failures are non-blocking
      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement the feature",
        workerOutput: validWorkerOutput,
        maxRetries: 0,
        sessionId: "sess-substrate-fail",
      });

      expect(result.verdict).toBe("approved");
      // mutate was called but failed — that's fine
      expect(substrate.mutate).toHaveBeenCalled();
    });

    it("arbiter path succeeds even when Substrate mutate fails", async () => {
      const substrate = createMockSubstrateClient();
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));

      const oversight = new Oversight({
        reviewerProvider: createMockProvider(rejectJson),
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
        sessionId: "sess-substrate-fail-arbiter",
      });

      expect(result.verdict).toBe("approved");
      expect(result.arbiterInvolved).toBe(true);
    });
  });
});
