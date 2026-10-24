import { describe, it, expect } from "vitest";
import { getExecutableTasks } from "../src/orchestrator/dag.js";
import type { DAGNode } from "../src/orchestrator/dag.js";
import { SUCCESS_VERDICTS } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// DAG dependency resolution — completed_with_notes / completed_with_deferrals
// in the completed set must unblock downstream dependsOn tasks (case 4 cascade)
// ---------------------------------------------------------------------------

describe("getExecutableTasks — success-variant statuses unblock downstream tasks", () => {
  // Mirrors the goal-23 case: task-6, task-8, task-9 completed with notes/deferrals,
  // and task-19 (close-goal) depends on all three.

  const nodes: DAGNode[] = [
    { id: "task-6", dependsOn: [] },
    { id: "task-8", dependsOn: [] },
    { id: "task-9", dependsOn: [] },
    { id: "task-19", dependsOn: ["task-6", "task-8", "task-9"] },
  ];

  it("task-19 is blocked when predecessors have not yet completed", () => {
    const result = getExecutableTasks(nodes, new Set(), new Set());
    expect(result.executable).toContain("task-6");
    expect(result.executable).toContain("task-8");
    expect(result.executable).toContain("task-9");
    expect(result.blocked).toContain("task-19");
  });

  it("task-19 is executable when all predecessors are in the completed set (regardless of verdict label)", () => {
    // The orchestrator is responsible for adding task IDs to completedIds when
    // verdictOk is true. completedIds is just a Set<string> — task-19 doesn't
    // know whether task-6 was 'approved' or 'completed_with_notes'.
    const completedIds = new Set(["task-6", "task-8", "task-9"]);
    const result = getExecutableTasks(nodes, completedIds, new Set());
    expect(result.executable).toContain("task-19");
    expect(result.blocked).not.toContain("task-19");
    expect(result.skipped).not.toContain("task-19");
  });

  it("task-19 is skipped when one predecessor failed", () => {
    // If task-8 had genuinely failed, task-19 should be skipped
    const completedIds = new Set(["task-6", "task-9"]);
    const failedIds = new Set(["task-8"]);
    const result = getExecutableTasks(nodes, completedIds, failedIds);
    expect(result.skipped).toContain("task-19");
    expect(result.executable).not.toContain("task-19");
  });

  it("task-19 executes when completed_with_notes tasks are treated as completed (case 1 + case 4)", () => {
    // Simulate: task-6 → completed_with_notes, task-8 → completed_with_deferrals,
    // task-9 → completed. The orchestrator adds all three to completedIds.
    // task-19 (close-goal) should then be executable.
    const completedIds = new Set(["task-6", "task-8", "task-9"]);
    const result = getExecutableTasks(nodes, completedIds, new Set());
    expect(result.executable).toEqual(expect.arrayContaining(["task-19"]));
    expect(result.executable).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SUCCESS_VERDICTS set — the orchestrator uses this to determine verdictOk.
// Verify the expected verdicts are included (tested at the constant level via
// a re-export shim, and at the integration level via the dispatch path).
//
// We test by importing from dag.js (which doesn't export SUCCESS_VERDICTS) and
// instead simulate what the orchestrator does: add to completedIds when
// verdict is in SUCCESS_VERDICTS.
// ---------------------------------------------------------------------------

describe("SUCCESS_VERDICTS contract (imported from @mnmal-ai/swarm-types)", () => {
  // Tests the actual exported constant — not a local copy — so any future
  // change to SUCCESS_VERDICTS that is not reflected here causes a failure.
  it("approved is a success verdict", () => expect(SUCCESS_VERDICTS.has("approved")).toBe(true));
  it("skipped is a success verdict", () => expect(SUCCESS_VERDICTS.has("skipped")).toBe(true));
  it("completed_with_notes is a success verdict", () => expect(SUCCESS_VERDICTS.has("completed_with_notes")).toBe(true));
  it("completed_with_deferrals is a success verdict", () => expect(SUCCESS_VERDICTS.has("completed_with_deferrals")).toBe(true));
  it("rejected is NOT a success verdict", () => expect(SUCCESS_VERDICTS.has("rejected")).toBe(false));
  it("escalate is NOT a success verdict", () => expect(SUCCESS_VERDICTS.has("escalate")).toBe(false));
});
