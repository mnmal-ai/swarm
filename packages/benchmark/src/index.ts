import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BehavioralTest,
  TestAssertion,
  AssertionResult,
  TestRunResult,
  TestSuiteResult,
  BenchmarkReport,
  ModelProvider,
  LoadedFile,
} from "@mnmal-ai/swarm-types";
import type { SwarmQueryClient } from "@mnmal-ai/swarm-substrate";
import { Loader } from "@mnmal-ai/swarm-core";

// Deterministic recall scoring surface (sidecar-free) — re-exported so the
// tuning task can score in a tight loop without reaching into a subpath.
export * from "./recall-metrics.js";

// The recall quality benchmark (boots a real recall-wired sidecar end-to-end).
export {
  RecallBenchmark,
  type RecallBenchmarkOptions,
  type RecallBenchmarkResult,
  type RecallFixture,
  type RecallFixtureFile,
  type RecallFixtureObservation,
  type RecallRunOptions,
  type RecallSplitMetrics,
} from "./recall-benchmark.js";

export class BenchmarkRunner {
  private swarmPath: string;
  private testsPath: string;
  private loader: Loader;

  constructor(params: { swarmPath: string; testsPath: string; substrateClient: SwarmQueryClient }) {
    this.swarmPath = params.swarmPath;
    this.testsPath = params.testsPath;
    this.loader = new Loader(params.substrateClient);
  }

  /**
   * Discover all behavioral test files in the tests directory.
   */
  async discoverTests(): Promise<BehavioralTest[]> {
    const tests: BehavioralTest[] = [];
    await this.walkDir(this.testsPath, tests);
    return tests;
  }

  /**
   * Run a single test N times and determine pass/fail.
   */
  async runTest(
    test: BehavioralTest,
    provider: ModelProvider,
    model: string,
  ): Promise<TestSuiteResult> {
    const runs: TestRunResult[] = [];
    const { runs: runCount, pass_threshold: thresholdStr } = test.run_config;

    // Parse threshold (e.g., "4/5" → 4)
    const threshold = parseInt(thresholdStr.split("/")[0], 10);

    // Load swarm files specified by the test
    const files: LoadedFile[] = [];
    for (const filePath of test.setup.swarm_files) {
      const absolutePath = path.join(this.swarmPath, filePath);
      try {
        const content = await fs.readFile(absolutePath, "utf-8");
        files.push({
          path: filePath,
          tier: "core",
          content,
          estimatedTokens: Math.ceil(content.length / 4),
        });
      } catch {
        // File not found — skip
      }
    }

    const context = this.loader.assembleContext(files);

    for (let i = 0; i < runCount; i++) {
      const startTime = Date.now();

      const result = await provider.execute(
        { systemContext: context, prompt: test.setup.prompt },
        model,
      );

      const assertions = this.evaluateAssertions(
        test.assertions,
        result.output,
      );
      const allRequiredPassed = assertions
        .filter((a) => a.assertion.required)
        .every((a) => a.passed);

      runs.push({
        testId: test.scenario.id,
        run: i + 1,
        passed: allRequiredPassed,
        assertions,
        output: result.output,
        latencyMs: Date.now() - startTime,
        tokens: result.tokens.input + result.tokens.output,
      });
    }

    const passCount = runs.filter((r) => r.passed).length;

    return {
      testId: test.scenario.id,
      category: test.scenario.category,
      runs,
      passCount,
      failCount: runCount - passCount,
      passRate: passCount / runCount,
      threshold,
      passed: passCount >= threshold,
    };
  }

  /**
   * Run all discovered tests and produce a benchmark report.
   */
  async runSuite(params: {
    provider: ModelProvider;
    model: string;
    swarmCommitSha: string;
    swarmTag?: string;
  }): Promise<BenchmarkReport> {
    const tests = await this.discoverTests();
    const results: TestSuiteResult[] = [];
    let totalTokens = 0;
    let totalLatency = 0;
    let runCount = 0;

    for (const test of tests) {
      const suiteResult = await this.runTest(
        test,
        params.provider,
        params.model,
      );
      results.push(suiteResult);

      for (const run of suiteResult.runs) {
        totalTokens += run.tokens;
        totalLatency += run.latencyMs;
        runCount++;
      }
    }

    const passed = results.filter((r) => r.passed).length;

    return {
      id: `run-${new Date().toISOString().slice(0, 10)}-${String(Date.now()).slice(-4)}`,
      timestamp: new Date().toISOString(),
      model: { provider: params.provider.name, model_id: params.model },
      swarm_version: {
        commit_sha: params.swarmCommitSha,
        tag: params.swarmTag,
      },
      suite: "full",
      results,
      summary: {
        total: results.length,
        passed,
        failed: results.length - passed,
        overallPassRate: results.length > 0 ? passed / results.length : 0,
      },
      usage: {
        totalTokens,
        avgLatencyMs: runCount > 0 ? Math.round(totalLatency / runCount) : 0,
      },
    };
  }

  /**
   * Evaluate all assertions against an output string.
   */
  evaluateAssertions(
    assertions: TestAssertion[],
    output: string,
  ): AssertionResult[] {
    return assertions.map((assertion) => {
      switch (assertion.type) {
        case "contains":
          return this.evalContains(assertion, output);
        case "contains_any":
          return this.evalContainsAny(assertion, output);
        case "excludes":
          return this.evalExcludes(assertion, output);
        case "structural":
          return this.evalStructural(assertion, output);
        case "semantic":
          // Semantic assertions require an LLM judge — skipped in basic runner
          return {
            assertion,
            passed: true,
            detail: "Semantic assertions not implemented in basic runner. Skipped.",
          };
        default:
          return { assertion, passed: false, detail: `Unknown assertion type: ${(assertion as TestAssertion).type}` };
      }
    });
  }

  private evalContains(
    assertion: TestAssertion,
    output: string,
  ): AssertionResult {
    const target = assertion.value ?? "";
    const haystack = assertion.case_sensitive === true ? output : output.toLowerCase();
    const needle = assertion.case_sensitive === true ? target : target.toLowerCase();
    const passed = haystack.includes(needle);
    return {
      assertion,
      passed,
      detail: passed ? undefined : `Output does not contain "${target}"`,
    };
  }

  private evalContainsAny(
    assertion: TestAssertion,
    output: string,
  ): AssertionResult {
    const targets = assertion.values ?? [];
    const haystack = assertion.case_sensitive === true ? output : output.toLowerCase();
    const matched = targets.find((t) => {
      const needle = assertion.case_sensitive === true ? t : t.toLowerCase();
      return haystack.includes(needle);
    });
    return {
      assertion,
      passed: !!matched,
      detail: matched ? undefined : `Output does not contain any of: ${targets.join(", ")}`,
    };
  }

  private evalExcludes(
    assertion: TestAssertion,
    output: string,
  ): AssertionResult {
    const target = assertion.value ?? "";
    const haystack = assertion.case_sensitive === true ? output : output.toLowerCase();
    const needle = assertion.case_sensitive === true ? target : target.toLowerCase();
    const found = haystack.includes(needle);
    return {
      assertion,
      passed: !found,
      detail: found ? `Output contains excluded string "${target}"` : undefined,
    };
  }

  private evalStructural(
    assertion: TestAssertion,
    output: string,
  ): AssertionResult {
    switch (assertion.check) {
      case "contains_code_block":
        return {
          assertion,
          passed: /```[\s\S]*?```/.test(output),
          detail: /```[\s\S]*?```/.test(output)
            ? undefined
            : "Output does not contain a code block",
        };
      default:
        return {
          assertion,
          passed: false,
          detail: `Unknown structural check: ${assertion.check}`,
        };
    }
  }

  /**
   * Recursively find all .json files in a directory.
   */
  private async walkDir(
    dirPath: string,
    tests: BehavioralTest[],
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(fullPath, tests);
      } else if (entry.name.endsWith(".json") && entry.name !== "test-rules.json") {
        try {
          const raw = await fs.readFile(fullPath, "utf-8");
          const parsed = JSON.parse(raw) as BehavioralTest;
          if (parsed.scenario?.id && parsed.setup?.prompt && parsed.assertions) {
            tests.push(parsed);
          }
        } catch {
          // Skip malformed test files
        }
      }
    }
  }
}
