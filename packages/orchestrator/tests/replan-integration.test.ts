/**
 * End-to-end tests for the replan chain:
 *   merge conflict → task failed → categorizeFailure → analyzeGoalResults → action
 *
 * These tests prove the full chain works, not just isolated units.
 */
import { describe, it, expect } from "vitest";
import {
  categorizeFailure,
  analyzeGoalResults,
} from "../src/orchestrator/replan.js";
import type { ReplanTaskResult } from "../src/orchestrator/replan.js";

// ---------------------------------------------------------------------------
// Chain 1: Merge conflict → fold_into_next_goal
// ---------------------------------------------------------------------------

describe("Chain: merge conflict → fold_into_next_goal", () => {
  it("full chain: error message → categorize → analyze → fold", () => {
    // Step 1: The error message produced by the orchestrator when merge fails
    const errorMsg = "Merge conflict: src/shared.ts, src/models/User.swift";

    // Step 2: categorizeFailure recognizes it
    const category = categorizeFailure(errorMsg);
    expect(category).toBe("merge_conflict");

    // Step 3: Build ReplanTaskResult as the orchestrator would
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: errorMsg, retryCount: 0 },
    ];

    // Step 4: analyzeGoalResults decides what to do
    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("fold_into_next_goal");
    expect(decision.failedTaskIds).toEqual(["t2"]);
    expect(decision.reason).toContain("merge conflict");
  });

  it("multiple merge conflicts all fold (not retry)", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: "Merge conflict: A.swift", retryCount: 0 },
      { taskId: "t3", status: "failed", output: "CONFLICT (content): B.swift", retryCount: 0 },
      { taskId: "t4", status: "failed", output: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>", retryCount: 0 },
    ];

    const decision = analyzeGoalResults(results);
    expect(decision.action).toBe("fold_into_next_goal");
    expect(decision.failedTaskIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Chain 2: Build error → retry_decomposed
// ---------------------------------------------------------------------------

describe("Chain: build error → retry_decomposed", () => {
  it("full chain: build error + test failure → mixed categories → retry", () => {
    const buildErr = "error: cannot find module 'Foo'";
    const testErr = "FAIL src/tests/bar.test.ts - Expected true, received false";

    expect(categorizeFailure(buildErr)).toBe("build_error");
    expect(categorizeFailure(testErr)).toBe("test_failure");

    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: buildErr, retryCount: 0 },
      { taskId: "t3", status: "failed", output: testErr, retryCount: 0 },
    ];

    const decision = analyzeGoalResults(results);
    // Mixed categories → retry with decomposition
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.failedTaskIds).toEqual(["t2", "t3"]);
    expect(decision.newTasks).toBeDefined();
    expect(decision.newTasks!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Chain 3: Systemic failure → escalate_human
// ---------------------------------------------------------------------------

describe("Chain: systemic failure → escalate_human", () => {
  it("all failures same category (all build errors) → escalate", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "failed", output: "error: cannot find module 'X'", retryCount: 0 },
      { taskId: "t2", status: "failed", output: "error: cannot find module 'Y'", retryCount: 0 },
      { taskId: "t3", status: "failed", output: "error: cannot find module 'Z'", retryCount: 0 },
    ];

    const decision = analyzeGoalResults(results);
    expect(decision.action).toBe("escalate_human");
    expect(decision.reason).toContain("systemic");
    expect(decision.escalationMessage).toBeDefined();
  });

  it("max remediation rounds exceeded → escalate regardless of category", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "failed", output: "some error", retryCount: 2 },
    ];

    // Simulate being at max rounds
    const decision = analyzeGoalResults(results, 3, 3);
    expect(decision.action).toBe("escalate_human");
    expect(decision.reason.toLowerCase()).toContain("remediation");
  });
});

// ---------------------------------------------------------------------------
// Chain 4: Mixed merge + other → fold merge, retry others
// ---------------------------------------------------------------------------

describe("Chain: mixed merge conflict + build error", () => {
  it("mixed merge + build error → retry_decomposed (diverse categories)", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: "Merge conflict: shared.ts", retryCount: 0 },
      { taskId: "t3", status: "failed", output: "error: cannot find 'Foo'", retryCount: 0 },
    ];

    const decision = analyzeGoalResults(results);
    // Mixed categories (merge_conflict + build_error) → retry with decomposition
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.failedTaskIds).toContain("t2");
    expect(decision.failedTaskIds).toContain("t3");
    expect(decision.newTasks).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Chain 5: All tasks succeed → no_action
// ---------------------------------------------------------------------------

describe("Chain: all succeed → no_action", () => {
  it("no failures → no remediation needed", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "completed", retryCount: 0 },
      { taskId: "t3", status: "completed", retryCount: 0 },
    ];

    const decision = analyzeGoalResults(results);
    expect(decision.action).toBe("no_action");
  });
});

// ---------------------------------------------------------------------------
// Chain 6: Verify the error message format from orchestrator matches
// what categorizeFailure expects
// ---------------------------------------------------------------------------

describe("Orchestrator error format → categorizeFailure compatibility", () => {
  it("recognizes the exact format the orchestrator produces for merge conflicts", () => {
    // This is the exact format from orchestrator/index.ts:
    // `Merge conflict: ${(mergeResult.conflictFiles ?? []).join(", ")}`
    const orchError = "Merge conflict: src/models/User.swift, src/views/MainView.swift";
    expect(categorizeFailure(orchError)).toBe("merge_conflict");
  });

  it("recognizes git conflict markers that might appear in task output", () => {
    expect(categorizeFailure("<<<<<<< HEAD")).toBe("merge_conflict");
    expect(categorizeFailure("CONFLICT (content): Merge conflict in file.ts")).toBe("merge_conflict");
  });

  it("recognizes build errors from common tools", () => {
    expect(categorizeFailure("error: cannot find module")).toBe("build_error");
    expect(categorizeFailure("build failed")).toBe("build_error");
    expect(categorizeFailure("error: type 'string' is not assignable")).toBe("build_error");
    expect(categorizeFailure("failed to compile")).toBe("build_error");
    // Note: "error TS2345: ..." (TypeScript format) is categorized as unknown
    // because the regex requires "error:" immediately, not "error <code>:"
    expect(categorizeFailure("error TS2345: Argument of type")).toBe("unknown");
  });

  it("recognizes test failures from common frameworks", () => {
    expect(categorizeFailure("FAIL tests/foo.test.ts")).toBe("test_failure");
    expect(categorizeFailure("test failed")).toBe("test_failure");
    expect(categorizeFailure("assertion error: expected 1 but got 2")).toBe("test_failure");
  });

  it("recognizes timeouts", () => {
    expect(categorizeFailure("request timed out")).toBe("timeout");
    expect(categorizeFailure("time out waiting for response")).toBe("timeout");
    expect(categorizeFailure("token limit exceeded")).toBe("timeout");
  });

  it("recognizes tool/MCP failures", () => {
    expect(categorizeFailure("MCP server xcodebuild returned error")).toBe("tool_failure");
    expect(categorizeFailure("xcodebuild error: scheme not found")).toBe("tool_failure");
    expect(categorizeFailure("automation not enabled on simulator")).toBe("tool_failure");
  });

  it("unknown errors fall through to unknown", () => {
    expect(categorizeFailure("something weird happened")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Chain: tool failure → retry with fix instructions
// ---------------------------------------------------------------------------

describe("Chain: tool failure → retry with fix instructions", () => {
  it("full chain: MCP error → categorize → analyze → retry_decomposed", () => {
    const mcpError = "MCP server xcodebuild returned error";

    // Step 1: categorizeFailure recognizes tool failure
    const category = categorizeFailure(mcpError);
    expect(category).toBe("tool_failure");

    // Step 2: Build results as the orchestrator would
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: mcpError, retryCount: 0 },
      { taskId: "t3", status: "failed", output: "simulator not booted", retryCount: 0 },
    ];

    // Step 3: analyzeGoalResults retries (not escalates) tool failures
    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("retry_decomposed");
    expect(decision.failedTaskIds).toEqual(["t2", "t3"]);
    expect(decision.newTasks).toBeDefined();
    expect(decision.newTasks).toHaveLength(2);

    // Verify retry task descriptions contain fix instructions
    for (const task of decision.newTasks!) {
      expect(task.description).toContain("tool misconfiguration");
    }

    // Verify the original failure reason is included
    expect(decision.newTasks![0].description).toContain("MCP server xcodebuild returned error");
    expect(decision.newTasks![1].description).toContain("simulator not booted");
  });

  it("mixed tool failure + build error → retry_decomposed (diverse categories)", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "completed", retryCount: 0 },
      { taskId: "t2", status: "failed", output: "MCP server returned error", retryCount: 0 },
      { taskId: "t3", status: "failed", output: "error: cannot find module 'Foo'", retryCount: 0 },
    ];

    // Mixed categories (tool_failure + build_error) → diverse → retry_decomposed
    const decision = analyzeGoalResults(results);
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.failedTaskIds).toEqual(["t2", "t3"]);
    expect(decision.newTasks).toBeDefined();
  });
});
