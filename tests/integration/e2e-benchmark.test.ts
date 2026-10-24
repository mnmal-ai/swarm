import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveSwarmPath } from "./helpers.js";
import { BenchmarkRunner } from "@mnmal-ai/swarm-benchmark";
import { AnthropicProvider } from "@mnmal-ai/swarm-core";

const SWARM_PATH = resolveSwarmPath();
const TESTS_PATH = path.join(SWARM_PATH, "tests", "behavioral");

// Paid: this suite calls the Anthropic API. It runs only with the separate opt-in
// SWARM_SDK_CLAUDE=1 (SWARM_SDK_E2E=1 alone never runs it); it needs no sidecar.
const RUN_CLAUDE = process.env.SWARM_SDK_CLAUDE === "1";

describe.skipIf(!RUN_CLAUDE)("E2E: Benchmark runner (paid; needs SWARM_SDK_CLAUDE=1)", () => {
  it(
    "should discover and run the retain cycle test with 4/5 pass rate",
    async () => {
      const runner = new BenchmarkRunner({
        swarmPath: SWARM_PATH,
        testsPath: TESTS_PATH,
      });

      // Discover tests
      const tests = await runner.discoverTests();
      expect(tests.length).toBeGreaterThanOrEqual(1);

      const retainCycleTest = tests.find(
        (t) => t.scenario.id === "swift-retain-cycle-detection",
      );
      expect(retainCycleTest).toBeDefined();

      // Create provider
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY must be set to run E2E tests");
      }
      const provider = new AnthropicProvider(apiKey);

      // Run the test 5 times
      const result = await runner.runTest(
        retainCycleTest!,
        provider,
        "claude-sonnet-4-5",
      );

      console.log("\n--- Benchmark Result ---");
      console.log(`Test: ${result.testId}`);
      console.log(`Pass rate: ${result.passCount}/${result.passCount + result.failCount}`);
      console.log(`Threshold: ${result.threshold}`);
      console.log(`Passed: ${result.passed}`);

      for (const run of result.runs) {
        const assertionSummary = run.assertions
          .map((a) => `${a.assertion.type}:${a.passed ? "PASS" : "FAIL"}`)
          .join(", ");
        console.log(
          `  Run ${run.run}: ${run.passed ? "PASS" : "FAIL"} (${run.latencyMs}ms) [${assertionSummary}]`,
        );
        if (!run.passed) {
          const failures = run.assertions.filter((a) => !a.passed);
          for (const f of failures) {
            console.log(`    FAILED: ${f.detail}`);
          }
        }
      }

      // Assert 4/5 threshold
      expect(result.passed).toBe(true);
      expect(result.passCount).toBeGreaterThanOrEqual(4);
    },
    { timeout: 180000 },
  );
});
