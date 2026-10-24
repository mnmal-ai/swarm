import { describe, it, expect, vi } from "vitest";
import {
  validateDAG,
  topologicalSort,
  getExecutableTasks,
  injectDynamicEdges,
} from "../src/orchestrator/dag.js";
import type { DAGNode } from "../src/orchestrator/dag.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import type { Task, Goal, SwarmOversightRunResult } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// validateDAG
// ---------------------------------------------------------------------------

describe("validateDAG", () => {
  it("empty list is valid", () => {
    const result = validateDAG([]);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("single task with no dependencies is valid", () => {
    const result = validateDAG([{ id: "A", dependsOn: [] }]);
    expect(result.valid).toBe(true);
  });

  it("linear chain A -> B -> C is valid", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
  });

  it("diamond shape is valid", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
  });

  it("all independent tasks are valid", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
  });

  it("cycle detection: A -> B -> A", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cycle");
  });

  it("cycle detection: longer cycle A -> B -> C -> A", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: ["C"] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cycle");
  });

  it("self-loop is detected as a cycle", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: ["A"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cycle");
  });

  it("missing dependency: A depends on X (not in list)", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: ["X"] },
      { id: "B", dependsOn: [] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("X");
    expect(result.error).toContain("does not exist");
  });

  it("duplicate node IDs are detected", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "A", dependsOn: [] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Duplicate");
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe("topologicalSort", () => {
  it("empty list returns empty tiers", () => {
    const tiers = topologicalSort([]);
    expect(tiers).toEqual([]);
  });

  it("single task returns one tier", () => {
    const tiers = topologicalSort([{ id: "A", dependsOn: [] }]);
    expect(tiers).toEqual([["A"]]);
  });

  it("all independent tasks go in one tier, preserving input order", () => {
    const nodes: DAGNode[] = [
      { id: "C", dependsOn: [] },
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
    ];
    const tiers = topologicalSort(nodes);
    expect(tiers).toHaveLength(1);
    // Input order is C, A, B — preserved instead of lexicographic sort
    expect(tiers[0]).toEqual(["C", "A", "B"]);
  });

  it("linear chain A -> B -> C produces 3 tiers", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const tiers = topologicalSort(nodes);
    expect(tiers).toEqual([["A"], ["B"], ["C"]]);
  });

  it("diamond: A -> B, A -> C, [B,C] -> D produces 3 tiers with input order", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const tiers = topologicalSort(nodes);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toEqual(["A"]);
    // B before C — preserves input order
    expect(tiers[1]).toEqual(["B", "C"]);
    expect(tiers[2]).toEqual(["D"]);
  });

  it("mixed independent and dependent tasks preserve input order", () => {
    // A, B independent; C depends on A; D depends on both A and B
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["A", "B"] },
    ];
    const tiers = topologicalSort(nodes);
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toEqual(["A", "B"]);
    expect(tiers[1]).toEqual(["C", "D"]);
  });

  it("throws on cycle", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    expect(() => topologicalSort(nodes)).toThrow("Cycle");
  });

  it("complex graph with multiple roots and merge points preserves input order", () => {
    // R1 -> A -> C -> E
    // R2 -> B -> D -/
    const nodes: DAGNode[] = [
      { id: "R1", dependsOn: [] },
      { id: "R2", dependsOn: [] },
      { id: "A", dependsOn: ["R1"] },
      { id: "B", dependsOn: ["R2"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B"] },
      { id: "E", dependsOn: ["C", "D"] },
    ];
    const tiers = topologicalSort(nodes);
    expect(tiers).toHaveLength(4);
    expect(tiers[0]).toEqual(["R1", "R2"]);
    expect(tiers[1]).toEqual(["A", "B"]);
    expect(tiers[2]).toEqual(["C", "D"]);
    expect(tiers[3]).toEqual(["E"]);
  });
});

// ---------------------------------------------------------------------------
// getExecutableTasks
// ---------------------------------------------------------------------------

describe("getExecutableTasks", () => {
  it("empty list returns empty results", () => {
    const result = getExecutableTasks([], new Set(), new Set());
    expect(result.executable).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("all independent tasks are executable when nothing completed/failed", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [] },
    ];
    const result = getExecutableTasks(nodes, new Set(), new Set());
    expect(result.executable).toEqual(["A", "B", "C"]);
    expect(result.blocked).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("dependent task is blocked when dependency not completed", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
    ];
    const result = getExecutableTasks(nodes, new Set(), new Set());
    expect(result.executable).toEqual(["A"]);
    expect(result.blocked).toEqual(["B"]);
  });

  it("dependent task becomes executable when dependency completes", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
    ];
    const result = getExecutableTasks(nodes, new Set(["A"]), new Set());
    expect(result.executable).toEqual(["B"]);
    expect(result.blocked).toEqual([]);
  });

  it("failure propagation: A fails -> B (depends on A) skipped, C (independent) executable", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: [] },
    ];
    const result = getExecutableTasks(nodes, new Set(), new Set(["A"]));
    expect(result.executable).toEqual(["C"]);
    expect(result.skipped).toEqual(["B"]);
    expect(result.blocked).toEqual([]);
  });

  it("transitive failure propagation: A fails -> B skipped -> C skipped", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const result = getExecutableTasks(nodes, new Set(), new Set(["A"]));
    expect(result.skipped).toContain("B");
    expect(result.skipped).toContain("C");
    expect(result.executable).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("diamond with partial failure: A completes, B fails, C completes, D skipped", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const result = getExecutableTasks(
      nodes,
      new Set(["A", "C"]),
      new Set(["B"]),
    );
    // D depends on both B and C; B failed, so D is skipped
    expect(result.skipped).toEqual(["D"]);
    expect(result.executable).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("completed tasks are excluded from all result lists", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const result = getExecutableTasks(nodes, new Set(["A", "B"]), new Set());
    // A and B are completed, not in any list. C is executable.
    expect(result.executable).toEqual(["C"]);
    expect(result.blocked).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("failed tasks are excluded from all result lists", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
    ];
    const result = getExecutableTasks(nodes, new Set(), new Set(["A"]));
    // A is failed (not in lists), B is skipped
    expect(result.executable).toEqual([]);
    expect(result.skipped).toEqual(["B"]);
    // A itself should NOT appear in executable, blocked, or skipped
    expect(result.blocked).toEqual([]);
  });

  it("multiple dependencies: task blocked until ALL deps complete", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: ["A", "B"] },
    ];
    // Only A completed, B not yet
    const result = getExecutableTasks(nodes, new Set(["A"]), new Set());
    expect(result.executable).toEqual(["B"]);
    expect(result.blocked).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: dispatchParallel with DAG dependencies
// ---------------------------------------------------------------------------

describe("dispatchParallel with DAG dependencies", () => {
  function makeTask(id: string, deps?: string[]): Task {
    return {
      id,
      goal_id: "g1",
      description: `Task ${id}`,
      intent: "implementation",
      status: "pending",
      order: 0,
      ...(deps && deps.length > 0 ? { dependsOn: deps } : {}),
    };
  }

  const goal: Goal = {
    id: "g1",
    description: "Test goal",
    priority: 1,
    status: "active",
    constraints: [],
    acceptance_criteria: [],
  };

  function makeResult(taskId: string): SwarmOversightRunResult {
    return {
      output: `Result for ${taskId}`,
      intent: "implementation",
      filesLoaded: [],
      tokensUsed: { context: 0, input: 100, output: 50 },
      latencyMs: 100,
      sessionId: `sess-${taskId}`,
      oversight: {
        verdict: "approved",
        retryCount: 0,
        arbiterInvolved: false,
        humanEscalation: false,
        rejectionReasons: [],
        totalResolutionTimeMs: 50,
      },
    };
  }

  function createOrchestrator() {
    return new Orchestrator({
      projectConfig: {
        project: "test",
        trust_level: "medium",
        concurrency: {
          max_workers: 3,
          max_tokens_per_session: 10_000_000,
          max_tokens_per_task: 5_000_000,
          max_tokens_per_goal: 5_000_000,
        },
      },
      backend: {
        type: "local",
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn(),
        createTask: vi.fn(),
        updateTask: vi.fn(),
      },
    });
  }

  it("dispatches tasks in dependency order (tier 0 before tier 1)", async () => {
    const orchestrator = createOrchestrator();
    const executionOrder: string[] = [];

    const executeTask = vi.fn(async (task: Task) => {
      executionOrder.push(task.id);
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A"),
        makeTask("B", ["A"]),
        makeTask("C", ["A"]),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    // A must complete before B and C start
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("B"));
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("C"));
  });

  it("skips downstream tasks when a dependency fails", async () => {
    const orchestrator = createOrchestrator();

    const executeTask = vi.fn(async (task: Task) => {
      if (task.id === "A") throw new Error("Task A failed");
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A"),
        makeTask("B", ["A"]),
        makeTask("C"),  // independent — should still run
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].task.id).toBe("A");
    // B should be skipped (dependency on A failed)
    expect(result.skipped.some((s) => s.id === "B")).toBe(true);
    // C is independent and should complete
    expect(result.completed.some((c) => c.task.id === "C")).toBe(true);
  });

  it("respects abort signal between tiers", async () => {
    const orchestrator = createOrchestrator();
    const controller = new AbortController();

    const executeTask = vi.fn(async (task: Task) => {
      // Abort after tier 0 completes
      if (task.id === "A") controller.abort();
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A"),
        makeTask("B", ["A"]),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
      abortSignal: controller.signal,
    });

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].task.id).toBe("A");
    // B should be skipped because abort was triggered
    expect(result.skipped.some((s) => s.id === "B")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// injectDynamicEdges
// ---------------------------------------------------------------------------

describe("injectDynamicEdges", () => {
  it("adds new dependency edges without mutating input", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [] },
    ];
    const result = injectDynamicEdges(nodes, [{ from: "A", to: "B" }]);
    expect(result.find((n) => n.id === "B")!.dependsOn).toContain("A");
    // Original not mutated
    expect(nodes.find((n) => n.id === "B")!.dependsOn).toHaveLength(0);
  });

  it("skips edges that already exist", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
    ];
    const result = injectDynamicEdges(nodes, [{ from: "A", to: "B" }]);
    expect(
      result.find((n) => n.id === "B")!.dependsOn.filter((d) => d === "A"),
    ).toHaveLength(1);
  });

  it("handles edges referencing non-existent nodes gracefully", () => {
    const nodes: DAGNode[] = [{ id: "A", dependsOn: [] }];
    const result = injectDynamicEdges(nodes, [{ from: "A", to: "MISSING" }]);
    expect(result).toHaveLength(1);
    expect(result[0].dependsOn).toHaveLength(0);
  });

  it("produces a valid DAG after injection", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: ["A"] },
    ];
    const result = injectDynamicEdges(nodes, [{ from: "B", to: "C" }]);
    expect(validateDAG(result).valid).toBe(true);
  });

  it("handles multiple edges at once", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [] },
    ];
    const result = injectDynamicEdges(nodes, [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]);
    expect(result.find((n) => n.id === "B")!.dependsOn).toEqual(["A"]);
    expect(result.find((n) => n.id === "C")!.dependsOn).toEqual(["B"]);
  });
});
