import { describe, it, expect, vi } from "vitest";
import { BenchmarkRunner } from "../src/index.js";
import type { BehavioralTest, ModelProvider, TestAssertion } from "@mnmal-ai/swarm-types";

describe("BenchmarkRunner - assertion evaluation", () => {
  const runner = new BenchmarkRunner({
    swarmPath: "/tmp/fake",
    testsPath: "/tmp/fake/tests",
  });

  const evaluate = (assertions: TestAssertion[], output: string) =>
    runner.evaluateAssertions(assertions, output);

  describe("contains", () => {
    it("should pass when output contains the value", () => {
      const results = evaluate(
        [{ type: "contains", value: "retain cycle", required: true }],
        "This code has a retain cycle due to the strong reference.",
      );
      expect(results[0].passed).toBe(true);
    });

    it("should fail when output does not contain the value", () => {
      const results = evaluate(
        [{ type: "contains", value: "retain cycle", required: true }],
        "This code looks fine.",
      );
      expect(results[0].passed).toBe(false);
    });

    it("should be case insensitive by default", () => {
      const results = evaluate(
        [{ type: "contains", value: "Retain Cycle", required: true }],
        "there is a retain cycle here",
      );
      expect(results[0].passed).toBe(true);
    });

    it("should respect case_sensitive flag", () => {
      const results = evaluate(
        [{ type: "contains", value: "Retain", case_sensitive: true, required: true }],
        "there is a retain cycle here",
      );
      expect(results[0].passed).toBe(false);
    });
  });

  describe("contains_any", () => {
    it("should pass when output contains at least one value", () => {
      const results = evaluate(
        [{ type: "contains_any", values: ["[weak self]", "capture list"], required: true }],
        "Use [weak self] in the closure.",
      );
      expect(results[0].passed).toBe(true);
    });

    it("should fail when output contains none of the values", () => {
      const results = evaluate(
        [{ type: "contains_any", values: ["[weak self]", "capture list"], required: true }],
        "This code is fine.",
      );
      expect(results[0].passed).toBe(false);
    });
  });

  describe("excludes", () => {
    it("should pass when output does not contain the value", () => {
      const results = evaluate(
        [{ type: "excludes", value: "looks good", required: true }],
        "This has a retain cycle.",
      );
      expect(results[0].passed).toBe(true);
    });

    it("should fail when output contains the excluded value", () => {
      const results = evaluate(
        [{ type: "excludes", value: "looks good", required: true }],
        "This looks good to me!",
      );
      expect(results[0].passed).toBe(false);
    });
  });

  describe("structural", () => {
    it("should detect code blocks", () => {
      const results = evaluate(
        [{ type: "structural", check: "contains_code_block", required: true }],
        "Here is the fix:\n```swift\nlet x = 1\n```\n",
      );
      expect(results[0].passed).toBe(true);
    });

    it("should fail when no code block present", () => {
      const results = evaluate(
        [{ type: "structural", check: "contains_code_block", required: true }],
        "Just use weak self.",
      );
      expect(results[0].passed).toBe(false);
    });
  });

  describe("mixed assertions", () => {
    it("should evaluate all assertions independently", () => {
      const output = "This code has a **retain cycle**. Use `[weak self]` in the closure.\n```swift\n[weak self]\n```";
      const results = evaluate(
        [
          { type: "contains", value: "retain cycle", required: true },
          { type: "contains_any", values: ["[weak self]", "capture list"], required: true },
          { type: "excludes", value: "looks good", required: true },
          { type: "structural", check: "contains_code_block", required: false },
        ],
        output,
      );

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.passed)).toBe(true);
    });
  });
});

describe("BenchmarkRunner - token usage", () => {
  const scenario = {
    scenario: {
      id: "sample-1",
      submitted_by: "example",
      date: "2026-01-01",
      category: "routing",
      plain_english: { situation: "", input: "", expected_behavior: "", failure_this_prevents: "" },
    },
    setup: { swarm_files: [], prompt: "hello" },
    assertions: [],
    run_config: { runs: 2, pass_threshold: "1/2" },
  } as unknown as BehavioralTest;

  const provider = {
    name: "anthropic",
    execute: vi.fn(async () => ({
      output: "ok",
      tokens: { input: 1_000, output: 200 },
      latencyMs: 5,
      model: { provider: "anthropic", modelId: "example-model" },
    })),
  } as unknown as ModelProvider;

  it("records each run's tokens and totals them in the report", async () => {
    const runner = new BenchmarkRunner({ swarmPath: "/tmp/fake", testsPath: "/tmp/fake/tests" } as never);
    vi.spyOn(runner, "discoverTests").mockResolvedValue([scenario]);

    const report = await runner.runSuite({ provider, model: "example-model", swarmCommitSha: "abc123" });

    expect(report.results[0].runs.map((r) => r.tokens)).toEqual([1_200, 1_200]);
    expect(report.usage.totalTokens).toBe(2_400);
  });
});
