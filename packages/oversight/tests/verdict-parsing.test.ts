import { describe, it, expect } from "vitest";
import { Oversight } from "../src/index.js";
import type { ModelProvider, ExecutionResult } from "@mnmal-ai/swarm-types";

function makeProvider(output: string): ModelProvider {
  return {
    name: "anthropic",
    execute: async (): Promise<ExecutionResult> => ({
      output,
      tokens: { input: 10, output: 10 },
      latencyMs: 100,
      model: { provider: "anthropic", modelId: "test" },
    }),
  };
}

function createOversight(reviewOutput: string, arbiterOutput: string): Oversight {
  return new Oversight({
    reviewerProvider: makeProvider(reviewOutput),
    reviewerModel: "test",
    arbiterProvider: makeProvider(arbiterOutput),
    arbiterModel: "test",
  });
}

// ---------------------------------------------------------------------------
// parseReviewResponse via review()
// ---------------------------------------------------------------------------

describe("parseReviewResponse — graduated verdicts", () => {
  const validWorkerOutput = "A ".repeat(30); // 60 chars — passes pre-review validation

  it("accepts 'approved'", async () => {
    const o = createOversight(JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] }), "{}");
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("approved");
  });

  it("accepts 'rejected'", async () => {
    const o = createOversight(JSON.stringify({ verdict: "rejected", reasons: ["bad"], suggestions: [] }), "{}");
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("rejected");
  });

  it("rejects LLM-produced 'skipped' verdict (only valid as orchestrator injection)", async () => {
    // 'skipped' is set by the orchestrator's shouldSkipReview() path — it is never a valid
    // LLM response and is not in REVIEW_VERDICT_VALUES. Accepting it from raw LLM output
    // would allow adversarial worker content to bypass the reviewer.
    const o = createOversight(JSON.stringify({ verdict: "skipped", reasons: [], suggestions: [] }), "{}");
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("rejected");
  });

  it("accepts 'completed_with_notes'", async () => {
    const o = createOversight(
      JSON.stringify({ verdict: "completed_with_notes", reasons: ["deviation documented at src/foo.ts:L42"], suggestions: [] }),
      "{}",
    );
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("completed_with_notes");
    expect(result.reasons).toContain("deviation documented at src/foo.ts:L42");
  });

  it("accepts 'completed_with_deferrals'", async () => {
    const o = createOversight(
      JSON.stringify({ verdict: "completed_with_deferrals", reasons: ["Sentry read API requires auth token outside agent scope"], suggestions: [] }),
      "{}",
    );
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("completed_with_deferrals");
    expect(result.reasons).toContain("Sentry read API requires auth token outside agent scope");
  });

  it("falls back to 'rejected' for unknown verdict strings", async () => {
    const o = createOversight(JSON.stringify({ verdict: "unknown_verdict", reasons: [], suggestions: [] }), "{}");
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("rejected");
  });

  it("falls back to 'rejected' for malformed JSON", async () => {
    const o = createOversight("not json at all", "{}");
    const result = await o.review("ctx", "task", validWorkerOutput, {});
    expect(result.verdict).toBe("rejected");
    expect(result.reasons[0]).toContain("could not be parsed");
  });
});

// ---------------------------------------------------------------------------
// parseArbiterResponse via arbitrate()
// ---------------------------------------------------------------------------

describe("parseArbiterResponse — graduated verdicts", () => {
  it("accepts 'approved'", async () => {
    const o = createOversight("{}", JSON.stringify({ verdict: "approved", reasoning: "worker was right" }));
    const result = await o.arbitrate("task", "output", ["reason"]);
    expect(result.verdict).toBe("approved");
    expect(result.reasoning).toBe("worker was right");
  });

  it("accepts 'rejected'", async () => {
    const o = createOversight("{}", JSON.stringify({ verdict: "rejected", reasoning: "reviewer was right" }));
    const result = await o.arbitrate("task", "output", ["reason"]);
    expect(result.verdict).toBe("rejected");
  });

  it("accepts 'escalate'", async () => {
    const o = createOversight("{}", JSON.stringify({ verdict: "escalate", reasoning: "ambiguous" }));
    const result = await o.arbitrate("task", "output", ["reason"]);
    expect(result.verdict).toBe("escalate");
  });

  it("accepts 'completed_with_notes'", async () => {
    const o = createOversight(
      "{}",
      JSON.stringify({ verdict: "completed_with_notes", reasoning: "deviation at src/lookup.ts:L142 is by-design for synthetic seeds" }),
    );
    const result = await o.arbitrate("task", "output", ["review concern"]);
    expect(result.verdict).toBe("completed_with_notes");
    expect(result.reasoning).toContain("by-design");
  });

  it("accepts 'completed_with_deferrals'", async () => {
    const o = createOversight(
      "{}",
      JSON.stringify({ verdict: "completed_with_deferrals", reasoning: "HUMAN-DEFERRED items require Sentry auth token" }),
    );
    const result = await o.arbitrate("task", "output", ["review concern"]);
    expect(result.verdict).toBe("completed_with_deferrals");
    expect(result.reasoning).toContain("HUMAN-DEFERRED");
  });

  it("falls back to 'escalate' for unknown verdict strings", async () => {
    const o = createOversight("{}", JSON.stringify({ verdict: "mystery", reasoning: "unknown" }));
    const result = await o.arbitrate("task", "output", []);
    expect(result.verdict).toBe("escalate");
  });

  it("falls back to 'escalate' for malformed JSON", async () => {
    const o = createOversight("{}", "not json at all");
    const result = await o.arbitrate("task", "output", []);
    expect(result.verdict).toBe("escalate");
    expect(result.reasoning).toContain("Unable to parse");
  });
});

// ---------------------------------------------------------------------------
// runFullChain — completed_with_notes / completed_with_deferrals short-circuit
// ---------------------------------------------------------------------------

describe("runFullChain — graduated verdict early return", () => {
  const validOutput = "A ".repeat(30);

  it("returns completed_with_notes immediately without going to arbiter", async () => {
    const o = createOversight(
      JSON.stringify({ verdict: "completed_with_notes", reasons: ["deviation at src/foo.ts:L10"], suggestions: [] }),
      JSON.stringify({ verdict: "rejected", reasoning: "should not reach arbiter" }),
    );

    const result = await o.runFullChain({
      modeContext: "ctx",
      originalTask: "task",
      workerOutput: validOutput,
      maxRetries: 2,
      sessionId: "sess-test",
    });

    expect(result.verdict).toBe("completed_with_notes");
    expect(result.arbiterInvolved).toBe(false);
    expect(result.retryCount).toBe(0);
  });

  it("returns completed_with_deferrals immediately without going to arbiter", async () => {
    const o = createOversight(
      JSON.stringify({ verdict: "completed_with_deferrals", reasons: ["HUMAN-DEFERRED: Sentry auth required"], suggestions: [] }),
      JSON.stringify({ verdict: "rejected", reasoning: "should not reach arbiter" }),
    );

    const result = await o.runFullChain({
      modeContext: "ctx",
      originalTask: "task",
      workerOutput: validOutput,
      maxRetries: 2,
      sessionId: "sess-test",
    });

    expect(result.verdict).toBe("completed_with_deferrals");
    expect(result.arbiterInvolved).toBe(false);
    expect(result.retryCount).toBe(0);
  });

  it("propagates completed_with_notes on the retry path", async () => {
    // Initial review rejects; first retry returns completed_with_notes.
    // Verifies the retry loop short-circuits on graduated success verdicts.
    let callCount = 0;
    const reviewerProvider: ModelProvider = {
      name: "anthropic",
      execute: async (): Promise<import("@mnmal-ai/swarm-types").ExecutionResult> => {
        callCount++;
        const verdict = callCount === 1 ? "rejected" : "completed_with_notes";
        return {
          output: JSON.stringify({ verdict, reasons: ["first pass rejection"], suggestions: [] }),
          tokens: { input: 10, output: 10 },
          latencyMs: 50,
          model: { provider: "anthropic", modelId: "test" },
        };
      },
    };
    const o = new Oversight({
      reviewerProvider,
      reviewerModel: "test",
      arbiterProvider: makeProvider(JSON.stringify({ verdict: "rejected", reasoning: "should not reach arbiter" })),
      arbiterModel: "test",
    });

    const result = await o.runFullChain({
      modeContext: "ctx",
      originalTask: "task",
      workerOutput: validOutput,
      maxRetries: 2,
      sessionId: "sess-retry",
      onRetry: async () => validOutput,
    });

    expect(result.verdict).toBe("completed_with_notes");
    expect(result.arbiterInvolved).toBe(false);
    expect(result.retryCount).toBe(1);
  });

  it("arbiter returns completed_with_deferrals after reviewer and retry both reject", async () => {
    // Reviewer rejects → retry also rejects → arbiter invoked → arbiter returns graduated verdict.
    // This is the most likely real-world path: a task that consistently gets rejection comments
    // but the arbiter recognises the deferrals are scope-appropriate.
    const alwaysRejectReviewer: ModelProvider = {
      name: "anthropic",
      execute: async (): Promise<import("@mnmal-ai/swarm-types").ExecutionResult> => ({
        output: JSON.stringify({ verdict: "rejected", reasons: ["partial completion observed"], suggestions: [] }),
        tokens: { input: 10, output: 10 },
        latencyMs: 50,
        model: { provider: "anthropic", modelId: "test" },
      }),
    };
    const completedWithDeferralsArbiter: ModelProvider = {
      name: "anthropic",
      execute: async (): Promise<import("@mnmal-ai/swarm-types").ExecutionResult> => ({
        output: JSON.stringify({ verdict: "completed_with_deferrals", reasoning: "remaining items require external credentials — HUMAN-DEFERRED is appropriate" }),
        tokens: { input: 10, output: 10 },
        latencyMs: 50,
        model: { provider: "anthropic", modelId: "test" },
      }),
    };
    const o = new Oversight({
      reviewerProvider: alwaysRejectReviewer,
      reviewerModel: "test",
      arbiterProvider: completedWithDeferralsArbiter,
      arbiterModel: "test",
    });

    const result = await o.runFullChain({
      modeContext: "ctx",
      originalTask: "task",
      workerOutput: validOutput,
      maxRetries: 1,
      sessionId: "sess-arb",
      onRetry: async () => validOutput,
    });

    expect(result.verdict).toBe("completed_with_deferrals");
    expect(result.arbiterInvolved).toBe(true);
    expect(result.retryCount).toBe(1);
    expect(result.humanEscalation).toBe(false);
  });
});
