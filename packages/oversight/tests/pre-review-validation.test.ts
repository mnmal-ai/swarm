import { describe, it, expect, vi } from "vitest";
import { Oversight, validateWorkerOutput } from "../src/index.js";
import type { ExecutionResult, ModelProvider } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helper: narrow discriminated union for invalid results
// ---------------------------------------------------------------------------

function expectInvalid(result: { valid: true } | { valid: false; reason: string }): asserts result is { valid: false; reason: string } {
  expect(result.valid).toBe(false);
}

// ---------------------------------------------------------------------------
// Unit tests for validateWorkerOutput
// ---------------------------------------------------------------------------

describe("validateWorkerOutput", () => {
  it("rejects empty string output", () => {
    const result = validateWorkerOutput("");
    expectInvalid(result);
    expect(result.reason).toContain("empty output");
  });

  it("rejects whitespace-only output", () => {
    const result = validateWorkerOutput("   \n\t  \n  ");
    expectInvalid(result);
    expect(result.reason).toContain("empty output");
  });

  it("rejects very short output (< 50 chars)", () => {
    const result = validateWorkerOutput("Some short text");
    expectInvalid(result);
    expect(result.reason).toContain("too short");
    expect(result.reason).toContain("chars");
  });

  it("rejects a JSON error object", () => {
    const errorJson = JSON.stringify({ error: "Internal server error", code: 500 });
    const result = validateWorkerOutput(errorJson);
    expectInvalid(result);
    expect(result.reason).toContain("error object");
    expect(result.reason).toContain("redacted");
  });

  it("rejects a JSON error object with surrounding whitespace", () => {
    const errorJson = `  ${JSON.stringify({ error: "timeout" })}  `;
    const result = validateWorkerOutput(errorJson);
    expectInvalid(result);
    expect(result.reason).toContain("error object");
  });

  it("rejects a JSON error object with falsy error value", () => {
    // { "error": "" } is still an error object — key presence matters, not truthiness
    const errorJson = JSON.stringify({ error: "", code: 500 });
    const result = validateWorkerOutput(errorJson);
    expectInvalid(result);
    expect(result.reason).toContain("error object");
  });

  it("passes valid output (200+ chars of real text)", () => {
    const validOutput = "This is a comprehensive code review of the submitted Swift code. " +
      "The implementation correctly uses async/await patterns and follows the project's " +
      "established conventions. However, there is a potential retain cycle in the closure " +
      "passed to startObserving(). Consider using [weak self] to prevent memory leaks.";
    expect(validOutput.length).toBeGreaterThan(200);
    const result = validateWorkerOutput(validOutput);
    expect(result.valid).toBe(true);
  });

  it("passes output that is exactly 50 chars", () => {
    const output = "a".repeat(50);
    const result = validateWorkerOutput(output);
    expect(result.valid).toBe(true);
  });

  it("rejects output that is 49 chars", () => {
    const output = "a".repeat(49);
    const result = validateWorkerOutput(output);
    expectInvalid(result);
    expect(result.reason).toContain("too short");
  });

  it("passes JSON-like output that does not contain an error field", () => {
    // A JSON object without an "error" field should pass length check
    const json = JSON.stringify({ result: "success", data: "x".repeat(100) });
    const result = validateWorkerOutput(json);
    expect(result.valid).toBe(true);
  });

  it("passes a JSON object where 'error' appears only in a value, not as a key", () => {
    const json = JSON.stringify({ message: "no error key here", status: "ok", data: "x".repeat(60) });
    const result = validateWorkerOutput(json);
    expect(result.valid).toBe(true);
  });

  it("passes plain text containing the word 'error' (not JSON)", () => {
    const output = "The function handles the error case by returning null. ".repeat(3);
    const result = validateWorkerOutput(output);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseReviewResponse: parse failure now defaults to rejected
// ---------------------------------------------------------------------------

describe("parseReviewResponse defaults to rejected on parse failure", () => {
  /**
   * We test this indirectly by calling review() with a mock provider that
   * returns unparseable output. The review() method should return a
   * "rejected" verdict instead of the old "approved" default.
   */
  it("returns rejected when reviewer response is not valid JSON", async () => {
    const mockProvider: ModelProvider = {
      name: "anthropic",
      execute: vi.fn<(input: { systemContext: string; prompt: string }, model: string) => Promise<ExecutionResult>>()
        .mockResolvedValue({
          output: "This is not JSON at all — just plain text",
          tokens: { input: 100, output: 50 },
          latencyMs: 200,
          model: { provider: "anthropic", modelId: "test" },
        }),
    };

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    const result = await oversight.review("mode context", "task", "worker output ".repeat(10), {});
    expect(result.verdict).toBe("rejected");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("could not be parsed");
  });

  it("returns rejected when reviewer response is truncated JSON", async () => {
    const mockProvider: ModelProvider = {
      name: "anthropic",
      execute: vi.fn<(input: { systemContext: string; prompt: string }, model: string) => Promise<ExecutionResult>>()
        .mockResolvedValue({
          output: '{"verdict": "approved", "reasons": [',
          tokens: { input: 100, output: 50 },
          latencyMs: 200,
          model: { provider: "anthropic", modelId: "test" },
        }),
    };

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    const result = await oversight.review("mode context", "task", "worker output ".repeat(10), {});
    expect(result.verdict).toBe("rejected");
    expect(result.reasons[0]).toContain("could not be parsed");
  });
});

// ---------------------------------------------------------------------------
// Integration: runFullChain skips review for invalid worker output
// ---------------------------------------------------------------------------

describe("runFullChain pre-review validation", () => {
  function createMockProvider(reviewResponse: string): ModelProvider {
    return {
      name: "anthropic",
      execute: vi.fn<(input: { systemContext: string; prompt: string }, model: string) => Promise<ExecutionResult>>()
        .mockResolvedValue({
          output: reviewResponse,
          tokens: { input: 100, output: 50 },
          latencyMs: 200,
          model: { provider: "anthropic", modelId: "test" },
        }),
    };
  }

  it("skips review and retries when worker output is empty", async () => {
    const approveJson = JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] });
    const mockProvider = createMockProvider(approveJson);

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    // onRetry returns valid output on first retry
    const validOutput = "This is a valid worker output that is well over fifty characters long and contains useful content.";
    const onRetry = vi.fn().mockResolvedValue(validOutput);

    const result = await oversight.runFullChain({
      modeContext: "mode context",
      originalTask: "do the thing",
      workerOutput: "",  // empty — should trigger pre-review validation
      maxRetries: 2,
      sessionId: "sess-test",
      onRetry,
    });

    // Should have retried once and then been approved by the reviewer
    expect(result.verdict).toBe("approved");
    expect(result.retryCount).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The retry should have received the validation reason
    expect(onRetry).toHaveBeenCalledWith(
      [expect.stringContaining("empty output")],
      1,
    );

    // The reviewer should only have been called ONCE (for the retry output),
    // NOT for the initial empty output
    expect(mockProvider.execute).toHaveBeenCalledTimes(1);
  });

  it("skips review when worker output is whitespace-only", async () => {
    const approveJson = JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] });
    const mockProvider = createMockProvider(approveJson);

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    const validOutput = "After retry, the worker produced this valid output that is longer than fifty characters.";
    const onRetry = vi.fn().mockResolvedValue(validOutput);

    const result = await oversight.runFullChain({
      modeContext: "context",
      originalTask: "task",
      workerOutput: "   \n\t  ",
      maxRetries: 2,
      sessionId: "sess-test",
      onRetry,
    });

    expect(result.verdict).toBe("approved");
    expect(onRetry).toHaveBeenCalledWith(
      [expect.stringContaining("empty output")],
      1,
    );
    // Reviewer only called for the valid retry output, not for the whitespace
    expect(mockProvider.execute).toHaveBeenCalledTimes(1);
  });

  it("goes to arbiter when all retries produce invalid output", async () => {
    const arbiterJson = JSON.stringify({ verdict: "escalate", reasoning: "Cannot resolve" });
    const mockProvider = createMockProvider(arbiterJson);

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    // onRetry always returns empty — exhausts retries
    const onRetry = vi.fn().mockResolvedValue("");

    const result = await oversight.runFullChain({
      modeContext: "context",
      originalTask: "task",
      workerOutput: "",
      maxRetries: 2,
      sessionId: "sess-test",
      onRetry,
    });

    // Should have exhausted retries and gone to arbiter
    expect(result.retryCount).toBe(2);
    expect(result.arbiterInvolved).toBe(true);
    expect(result.humanEscalation).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2);

    // Reviewer should NOT have been called at all (all outputs were invalid)
    // Only the arbiter provider was called
    expect(mockProvider.execute).toHaveBeenCalledTimes(1); // arbiter only
  });

  it("does not skip review for valid worker output", async () => {
    const approveJson = JSON.stringify({ verdict: "approved", reasons: [], suggestions: [] });
    const mockProvider = createMockProvider(approveJson);

    const oversight = new Oversight({
      reviewerProvider: mockProvider,
      reviewerModel: "test-model",
      arbiterProvider: mockProvider,
      arbiterModel: "test-model",
    });

    const validOutput = "This is a thorough and complete worker output that exceeds the minimum character threshold and contains meaningful content.";

    const result = await oversight.runFullChain({
      modeContext: "context",
      originalTask: "task",
      workerOutput: validOutput,
      maxRetries: 2,
      sessionId: "sess-test",
    });

    // Should go through normal review path and be approved
    expect(result.verdict).toBe("approved");
    expect(result.retryCount).toBe(0);
    // Reviewer should have been called for the valid output
    expect(mockProvider.execute).toHaveBeenCalledTimes(1);
  });
});
