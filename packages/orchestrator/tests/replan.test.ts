import { describe, it, expect } from "vitest";
import {
  categorizeFailure,
  analyzeGoalResults,
  diagnoseEmptyOutput,
  type ReplanTaskResult,
} from "../src/orchestrator/replan.js";
import type { Task } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// categorizeFailure
// ---------------------------------------------------------------------------

describe("categorizeFailure", () => {
  it("returns build_error for compile failures", () => {
    expect(categorizeFailure("error: cannot find module 'foo'")).toBe("build_error");
    expect(categorizeFailure("Failed to compile src/index.ts")).toBe("build_error");
    expect(categorizeFailure("Build failed with 3 errors")).toBe("build_error");
    expect(categorizeFailure("Compilation error in module X")).toBe("build_error");
  });

  it("returns test_failure for test failures", () => {
    expect(categorizeFailure("Test failed: expected 3 but got 4")).toBe("test_failure");
    expect(categorizeFailure("AssertionError: values are not equal")).toBe("test_failure");
    expect(categorizeFailure("Expected: true\nReceived: false")).toBe("test_failure");
    expect(categorizeFailure("FAIL src/router.test.ts > routing")).toBe("test_failure");
    expect(categorizeFailure("expected 200 but received 404")).toBe("test_failure");
  });

  it("returns merge_conflict for merge conflicts", () => {
    expect(categorizeFailure("Merge conflict in src/index.ts")).toBe("merge_conflict");
    expect(categorizeFailure("CONFLICT (content): Merge conflict in file.ts")).toBe("merge_conflict");
    expect(categorizeFailure("<<<<<<< HEAD\nsome code\n=======\nother code\n>>>>>>>")).toBe("merge_conflict");
  });

  it("returns empty_output for empty or missing output", () => {
    expect(categorizeFailure(undefined)).toBe("empty_output");
    expect(categorizeFailure("")).toBe("empty_output");
    expect(categorizeFailure("   ")).toBe("empty_output");
    expect(categorizeFailure("ok")).toBe("empty_output"); // less than 5 chars
  });

  it("returns timeout for timeout-related output", () => {
    expect(categorizeFailure("Operation timed out after 30s")).toBe("timeout");
    expect(categorizeFailure("Timeout: no response in 60 seconds")).toBe("timeout");
    expect(categorizeFailure("Token limit exceeded")).toBe("timeout");
    expect(categorizeFailure("Context limit exceeded")).toBe("timeout");
  });

  it("returns reviewer_rejected when rejection is indicated in failureReason or output", () => {
    expect(categorizeFailure("some output", "Reviewer rejected: missing tests")).toBe("reviewer_rejected");
    expect(categorizeFailure("code output here", "Rejected by reviewer")).toBe("reviewer_rejected");
    // Also detects rejection in output when failureReason is absent
    expect(categorizeFailure("Output was rejected due to quality issues")).toBe("reviewer_rejected");
  });

  it("returns unknown for unrecognized output", () => {
    expect(categorizeFailure("Something went wrong but we don't know what")).toBe("unknown");
    expect(categorizeFailure("The operation could not be performed for an indeterminate reason")).toBe("unknown");
  });

  it("checks failureReason in addition to output", () => {
    // Output is clean but failureReason reveals the issue
    expect(categorizeFailure("clean output here", "Build failed on CI")).toBe("build_error");
    expect(categorizeFailure("normal looking output", "Test failed in suite")).toBe("test_failure");
  });

  it("returns tool_failure for MCP and tool configuration errors", () => {
    expect(categorizeFailure("MCP server xcodebuild returned error")).toBe("tool_failure");
    expect(categorizeFailure("mcp connection error: timeout")).toBe("tool_failure");
    expect(categorizeFailure("tool not found: some_tool")).toBe("tool_failure");
    expect(categorizeFailure("command failed with mcp server")).toBe("tool_failure");
    expect(categorizeFailure("xcodebuild error: scheme not found")).toBe("tool_failure");
    expect(categorizeFailure("automation not enabled on simulator")).toBe("tool_failure");
    expect(categorizeFailure("simulator not booted")).toBe("tool_failure");
    expect(categorizeFailure("scheme not found in project")).toBe("tool_failure");
    expect(categorizeFailure("no such mcp server configured")).toBe("tool_failure");
  });

  it("is case-insensitive", () => {
    expect(categorizeFailure("BUILD FAILED with issues")).toBe("build_error");
    expect(categorizeFailure("TEST FAILED badly")).toBe("test_failure");
    expect(categorizeFailure("TIMEOUT reached")).toBe("timeout");
    expect(categorizeFailure("MERGE CONFLICT in file.ts")).toBe("merge_conflict");
  });
});

// ---------------------------------------------------------------------------
// analyzeGoalResults
// ---------------------------------------------------------------------------

describe("analyzeGoalResults", () => {
  // Helper to create task results
  function makeResult(overrides: Partial<ReplanTaskResult> & { taskId: string }): ReplanTaskResult {
    return {
      status: "completed",
      retryCount: 0,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // All success
  // -----------------------------------------------------------------------

  it("returns no_action when all tasks succeed", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
      makeResult({ taskId: "t2", status: "completed" }),
      makeResult({ taskId: "t3", status: "completed" }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("no_action");
    expect(decision.reason).toContain("All tasks completed");
    expect(decision.newTasks).toBeUndefined();
    expect(decision.escalationMessage).toBeUndefined();
    expect(decision.failedTaskIds).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Single failure — escalate (single category = systemic)
  // -----------------------------------------------------------------------

  it("returns retry_decomposed for a single build error (N <= 2 is not systemic)", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Build failed with 3 errors",
        failureReason: "compilation error",
        retryCount: 2,
      }),
    ];

    const decision = analyzeGoalResults(results);

    // Single failure = same category but N <= 2: retry, not escalate
    // Systemic escalation requires N > 2 to avoid false positives.
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.failedTaskIds).toEqual(["t2"]);
  });

  // -----------------------------------------------------------------------
  // All same category (systemic) -> escalate
  // -----------------------------------------------------------------------

  it("returns escalate_human when all failures share the same category", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Build failed: missing dependency",
        retryCount: 2,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Compilation error: type mismatch",
        retryCount: 2,
      }),
      makeResult({
        taskId: "t3",
        status: "failed",
        output: "error: cannot find module",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("escalate_human");
    expect(decision.reason).toContain("same category");
    expect(decision.reason).toContain("build_error");
    expect(decision.escalationMessage).toBeDefined();
    expect(decision.escalationMessage!.toLowerCase()).toContain("systemic");
    expect(decision.failedTaskIds).toEqual(["t1", "t2", "t3"]);
  });

  // -----------------------------------------------------------------------
  // Mixed failures -> retry_decomposed
  // -----------------------------------------------------------------------

  it("returns retry_decomposed for mixed failure categories", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Build failed with errors",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t3",
        status: "failed",
        output: "Test failed: expected 3 got 4",
        retryCount: 2,
      }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("retry_decomposed");
    expect(decision.reason).toContain("different failure categories");
    expect(decision.newTasks).toBeDefined();
    expect(decision.newTasks).toHaveLength(2); // one per failed task
    expect(decision.failedTaskIds).toEqual(["t2", "t3"]);
  });

  // -----------------------------------------------------------------------
  // Merge conflicts -> fold_into_next_goal
  // -----------------------------------------------------------------------

  it("returns fold_into_next_goal when all failures are merge conflicts", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Merge conflict in src/index.ts",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t3",
        status: "failed",
        output: "CONFLICT (content): src/router.ts",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("fold_into_next_goal");
    expect(decision.reason).toContain("merge conflict");
    expect(decision.failedTaskIds).toEqual(["t2", "t3"]);
  });

  // -----------------------------------------------------------------------
  // All tool failures -> retry_decomposed (not escalate)
  // -----------------------------------------------------------------------

  it("returns retry_decomposed (not escalate_human) when all failures are tool_failure", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "MCP server xcodebuild returned error",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "simulator not booted",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results);

    // Tool failures are fixable — should retry, not escalate
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.action).not.toBe("escalate_human");
    expect(decision.reason).toContain("tool configuration");
    expect(decision.newTasks).toBeDefined();
    expect(decision.newTasks).toHaveLength(2);
    expect(decision.failedTaskIds).toEqual(["t1", "t2"]);
  });

  // -----------------------------------------------------------------------
  // Max remediation rounds -> escalate
  // -----------------------------------------------------------------------

  it("returns escalate_human when max remediation rounds reached", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Build failed",
        retryCount: 2,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Test failed: assertion error",
        retryCount: 2,
      }),
    ];

    const decision = analyzeGoalResults(results, 2, 2);

    expect(decision.action).toBe("escalate_human");
    expect(decision.reason).toContain("maximum");
    expect(decision.reason).toContain("2");
    expect(decision.escalationMessage).toBeDefined();
    expect(decision.escalationMessage).toContain("Manual intervention");
    expect(decision.failedTaskIds).toEqual(["t1", "t2"]);
  });

  it("escalates at custom max remediation rounds", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Something went wrong",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results, 3, 3);

    expect(decision.action).toBe("escalate_human");
    expect(decision.reason).toContain("maximum of 3");
  });

  // -----------------------------------------------------------------------
  // Mix of success and failure -> only failed tasks in decision
  // -----------------------------------------------------------------------

  it("only includes failed tasks in the decision", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
      makeResult({ taskId: "t2", status: "completed" }),
      makeResult({
        taskId: "t3",
        status: "failed",
        output: "Build failed: missing import",
        retryCount: 1,
      }),
      makeResult({ taskId: "t4", status: "completed" }),
      makeResult({
        taskId: "t5",
        status: "failed",
        output: "Test failed: assertion error",
        retryCount: 2,
      }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.failedTaskIds).toEqual(["t3", "t5"]);
    expect(decision.failedTaskIds).not.toContain("t1");
    expect(decision.failedTaskIds).not.toContain("t2");
    expect(decision.failedTaskIds).not.toContain("t4");
  });

  // -----------------------------------------------------------------------
  // Pre-categorized failures
  // -----------------------------------------------------------------------

  it("respects pre-categorized failureCategory on task results", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        failureCategory: "timeout",
        output: "no useful output",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        failureCategory: "build_error",
        output: "no useful output",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results);

    // Two different pre-set categories -> retry_decomposed
    expect(decision.action).toBe("retry_decomposed");
  });

  // -----------------------------------------------------------------------
  // Default remediation round values
  // -----------------------------------------------------------------------

  it("defaults currentRemediationRound to 0 and maxRemediationRounds to 2", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Build failed: missing import",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Test failed: expected true to be false",
        retryCount: 1,
      }),
    ];

    // No remediation round args -> should NOT escalate (round 0 < max 2)
    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("retry_decomposed");
  });

  // -----------------------------------------------------------------------
  // New tasks contain failure context
  // -----------------------------------------------------------------------

  it("retry_decomposed tasks include failure context in description", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Build failed: missing import for UserService",
        failureReason: "compilation error in module",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Test failed: expected 200 got 404",
        retryCount: 2,
      }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("retry_decomposed");
    expect(decision.newTasks).toHaveLength(2);

    // Each new task description should reference the original task ID
    expect(decision.newTasks![0].description).toContain("t1");
    expect(decision.newTasks![1].description).toContain("t2");

    // Each new task should include context about the failure
    expect(decision.newTasks![0].description).toContain("build_error");
    expect(decision.newTasks![1].description).toContain("test_failure");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles empty results array", () => {
    const decision = analyzeGoalResults([]);

    expect(decision.action).toBe("no_action");
    expect(decision.reason).toContain("All tasks completed");
  });

  it("handles single completed task", () => {
    const results: ReplanTaskResult[] = [
      makeResult({ taskId: "t1", status: "completed" }),
    ];

    const decision = analyzeGoalResults(results);

    expect(decision.action).toBe("no_action");
  });

  it("handles merge conflicts mixed with other failures", () => {
    const results: ReplanTaskResult[] = [
      makeResult({
        taskId: "t1",
        status: "failed",
        output: "Merge conflict in file.ts",
        retryCount: 1,
      }),
      makeResult({
        taskId: "t2",
        status: "failed",
        output: "Build failed: missing type",
        retryCount: 1,
      }),
    ];

    const decision = analyzeGoalResults(results);

    // Should decompose the non-merge failures; merge conflicts noted
    expect(decision.action).toBe("retry_decomposed");
    expect(decision.reason).toContain("merge conflict");
    // Only non-merge failures get new tasks
    expect(decision.newTasks).toHaveLength(1);
    expect(decision.newTasks![0].description).toContain("t2");
  });
});

// ---------------------------------------------------------------------------
// diagnoseEmptyOutput
// ---------------------------------------------------------------------------

describe("diagnoseEmptyOutput", () => {
  it("returns blocked_prerequisite when target files are created by another task", () => {
    const failedTask: Task = {
      id: "t2", goal_id: "g1", description: "Create pages",
      intent: "implementation", status: "failed", order: 2,
      dependsOn: [], serializedFiles: ["src/pages/Home.tsx"],
    };
    const allTasks: Task[] = [
      {
        id: "t1", goal_id: "g1", description: "Create components",
        intent: "implementation", status: "pending", order: 1,
        dependsOn: [], createsFiles: ["src/pages/Home.tsx"],
      },
      failedTask,
    ];
    const result = diagnoseEmptyOutput(failedTask, allTasks);
    expect(result.diagnosis).toBe("blocked_prerequisite");
    expect(result.blockedBy).toContain("t1");
  });

  it("returns unknown when no prerequisite issue found", () => {
    const failedTask: Task = {
      id: "t1", goal_id: "g1", description: "Do something",
      intent: "implementation", status: "failed", order: 1, dependsOn: [],
    };
    const result = diagnoseEmptyOutput(failedTask, [failedTask]);
    expect(result.diagnosis).toBe("unknown");
  });

  it("ignores completed tasks as blockers", () => {
    const failedTask: Task = {
      id: "t2", goal_id: "g1", description: "Use file",
      intent: "implementation", status: "failed", order: 2,
      dependsOn: [], serializedFiles: ["src/App.tsx"],
    };
    const allTasks: Task[] = [
      {
        id: "t1", goal_id: "g1", description: "Create file",
        intent: "implementation", status: "completed", order: 1,
        dependsOn: [], createsFiles: ["src/App.tsx"],
      },
      failedTask,
    ];
    const result = diagnoseEmptyOutput(failedTask, allTasks);
    expect(result.diagnosis).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// analyzeGoalResults — reorder_with_edges
// ---------------------------------------------------------------------------

describe("analyzeGoalResults — reorder_with_edges", () => {
  it("returns reorder_with_edges when empty_output tasks have prerequisite issues", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "failed", retryCount: 1, output: "some output", failureCategory: "build_error" },
      { taskId: "t2", status: "failed", retryCount: 2, output: "", failureCategory: "empty_output" },
    ];
    // t1 is pending (not yet completed) and creates files t2 needs
    const allTasks: Task[] = [
      { id: "t1", goal_id: "g1", description: "", intent: "implementation", status: "pending", order: 1, dependsOn: [], createsFiles: ["src/App.tsx"] },
      { id: "t2", goal_id: "g1", description: "", intent: "implementation", status: "failed", order: 2, dependsOn: [], serializedFiles: ["src/App.tsx"] },
    ];
    const decision = analyzeGoalResults(results, 0, 2, allTasks);
    expect(decision.action).toBe("reorder_with_edges");
    expect(decision.newEdges).toBeDefined();
    expect(decision.newEdges!.length).toBeGreaterThan(0);
  });

  it("falls through to normal handling when no prerequisite issue found", () => {
    const results: ReplanTaskResult[] = [
      { taskId: "t1", status: "failed", retryCount: 1, output: "", failureCategory: "empty_output" },
    ];
    // No allTasks with createsFiles that match
    const allTasks: Task[] = [
      { id: "t1", goal_id: "g1", description: "", intent: "implementation", status: "failed", order: 1, dependsOn: [] },
    ];
    const decision = analyzeGoalResults(results, 0, 2, allTasks);
    // Should NOT be reorder_with_edges since no prerequisite found
    expect(decision.action).not.toBe("reorder_with_edges");
  });
});
