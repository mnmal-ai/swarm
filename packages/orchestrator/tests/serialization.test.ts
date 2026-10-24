import { describe, it, expect, vi } from "vitest";
import {
  matchesGlob,
  applySerializationConstraints,
  applySharedFileConstraints,
  applyCreateModifyConstraints,
  topologicalSort,
  validateDAG,
} from "../src/orchestrator/dag.js";
import type { DAGNode } from "../src/orchestrator/dag.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import type { Task, Goal, SwarmOversightRunResult } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

describe("matchesGlob", () => {
  it("matches exact file name", () => {
    expect(matchesGlob("package-lock.json", "package-lock.json")).toBe(true);
  });

  it("does not match different file name", () => {
    expect(matchesGlob("package.json", "package-lock.json")).toBe(false);
  });

  it("matches * wildcard for extension", () => {
    expect(matchesGlob("project.pbxproj", "*.pbxproj")).toBe(true);
  });

  it("* does not match across path separators", () => {
    expect(matchesGlob("src/project.pbxproj", "*.pbxproj")).toBe(false);
  });

  it("matches ** wildcard across path separators", () => {
    expect(matchesGlob("ios/MyApp.xcodeproj/project.pbxproj", "**/*.pbxproj")).toBe(true);
  });

  it("matches ** for deep paths", () => {
    expect(matchesGlob("a/b/c/d/Cargo.lock", "**/Cargo.lock")).toBe(true);
  });

  it("matches Cargo.lock at root with **", () => {
    expect(matchesGlob("Cargo.lock", "**/Cargo.lock")).toBe(true);
  });

  it("does not match partial file names", () => {
    expect(matchesGlob("my-package-lock.json", "package-lock.json")).toBe(false);
  });

  it("matches ? wildcard for single character", () => {
    expect(matchesGlob("file1.txt", "file?.txt")).toBe(true);
  });

  it("? does not match path separator", () => {
    expect(matchesGlob("file/.txt", "file?.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applySerializationConstraints — pure DAG function
// ---------------------------------------------------------------------------

describe("applySerializationConstraints", () => {
  it("two tasks touching the same constrained file are serialized", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // B should now depend on A (serialized)
    expect(result[1].dependsOn).toContain("A");
    // A should remain independent
    expect(result[0].dependsOn).toEqual([]);
  });

  it("two tasks touching different files remain parallel", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["Cargo.lock"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // B does not touch a pbxproj file, so no dependency injected
    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toEqual([]);
  });

  it("tasks with no file declarations are unaffected", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // A and B have no serializedFiles — no dependency injected
    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toEqual([]);
    // C is the only one touching pbxproj; no other task to chain to
    expect(result[2].dependsOn).toEqual([]);
  });

  it("constraint patterns support globs (e.g., *.pbxproj)", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["ios/MyApp.xcodeproj/project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["ios/MyApp.xcodeproj/project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["**/*.pbxproj"]);

    // B should depend on A due to the ** glob matching deep paths
    expect(result[1].dependsOn).toContain("A");
  });

  it("three tasks touching the same constrained file form a chain", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "C", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // Chain: B depends on A, C depends on B
    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toContain("A");
    expect(result[2].dependsOn).toContain("B");
  });

  it("does not duplicate existing dependencies", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: ["A"], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // B already depends on A — should not have duplicates
    const aDeps = result[1].dependsOn.filter((d) => d === "A");
    expect(aDeps).toHaveLength(1);
  });

  it("empty constraint patterns returns nodes unchanged", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, []);

    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toEqual([]);
  });

  it("does not mutate input nodes", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    applySerializationConstraints(nodes, ["*.pbxproj"]);

    // Original nodes should be unchanged
    expect(nodes[0].dependsOn).toEqual([]);
    expect(nodes[1].dependsOn).toEqual([]);
  });

  it("multiple constraint patterns are all applied", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["package-lock.json"] },
      { id: "C", dependsOn: [], serializedFiles: ["project.pbxproj", "package-lock.json"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj", "package-lock.json"]);

    // For *.pbxproj: A and C match -> C depends on A
    expect(result[2].dependsOn).toContain("A");
    // For package-lock.json: B and C match -> C depends on B
    expect(result[2].dependsOn).toContain("B");
  });

  it("serialized tasks still produce valid topological tiers", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: [], serializedFiles: ["project.pbxproj"] },
      { id: "C", dependsOn: [] },
    ];

    const constrained = applySerializationConstraints(nodes, ["*.pbxproj"]);
    const tiers = topologicalSort(constrained);

    // C is independent, A is first in pbxproj chain, B depends on A
    // Tier 0: A and C (parallel), Tier 1: B
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toContain("A");
    expect(tiers[0]).toContain("C");
    expect(tiers[1]).toEqual(["B"]);
  });

  it("does not create a cycle when tasks arrive in reverse dependency order", () => {
    // B already depends on A, but B appears before A in the input array.
    // Without depth-based sorting, chaining would inject A.dependsOn("B"),
    // creating a cycle (A -> B -> A).
    const nodes: DAGNode[] = [
      { id: "B", dependsOn: ["A"], serializedFiles: ["project.pbxproj"] },
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // A (depth 0) should come first in the chain; B (depth 1) depends on A.
    // The existing B -> A dependency is preserved; no reverse edge injected.
    const nodeA = result.find((n) => n.id === "A")!;
    const nodeB = result.find((n) => n.id === "B")!;
    expect(nodeA.dependsOn).not.toContain("B");
    expect(nodeB.dependsOn).toContain("A");

    // The resulting graph must be a valid DAG (no cycles)
    const tiers = topologicalSort(result);
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toContain("A");
    expect(tiers[1]).toContain("B");
  });

  it("does not create a cycle with three tasks in reverse order", () => {
    // C -> B -> A dependency chain, but supplied in reverse input order.
    const nodes: DAGNode[] = [
      { id: "C", dependsOn: ["B"], serializedFiles: ["project.pbxproj"] },
      { id: "B", dependsOn: ["A"], serializedFiles: ["project.pbxproj"] },
      { id: "A", dependsOn: [], serializedFiles: ["project.pbxproj"] },
    ];

    const result = applySerializationConstraints(nodes, ["*.pbxproj"]);

    // Depth-sorted chain: A(0) -> B(1) -> C(2). No reverse edges.
    const nodeA = result.find((n) => n.id === "A")!;
    const nodeB = result.find((n) => n.id === "B")!;
    const nodeC = result.find((n) => n.id === "C")!;
    expect(nodeA.dependsOn).toEqual([]);
    expect(nodeB.dependsOn).toContain("A");
    expect(nodeB.dependsOn).not.toContain("C");
    expect(nodeC.dependsOn).toContain("B");

    // Must produce a valid DAG
    const tiers = topologicalSort(result);
    expect(tiers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Integration: dispatchParallel with serialization constraints
// ---------------------------------------------------------------------------

describe("dispatchParallel with serialization constraints", () => {
  function makeTask(id: string, opts?: { deps?: string[]; serializedFiles?: string[] }): Task {
    return {
      id,
      goal_id: "g1",
      description: `Task ${id}`,
      intent: "implementation",
      status: "pending",
      order: 0,
      ...(opts?.deps && opts.deps.length > 0 ? { dependsOn: opts.deps } : {}),
      ...(opts?.serializedFiles ? { serializedFiles: opts.serializedFiles } : {}),
    };
  }

  const goal: Goal = {
    id: "g1",
    description: "Test goal",
    priority: 1,
    status: "pending",
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

  function createOrchestrator(constraintPatterns?: string[]) {
    return new Orchestrator({
      projectConfig: {
        project: "test",
        swarm_path: "/tmp/swarm",
        trust_level: "medium",
        concurrency: {
          max_workers: 3,
          max_tokens_per_session: 10_000_000,
          max_tokens_per_task: 5_000_000,
          max_tokens_per_goal: 5_000_000,
        },
        task_backend: "local",
        created: new Date().toISOString(),
        ...(constraintPatterns
          ? { serialization_constraints: { patterns: constraintPatterns } }
          : {}),
      },
      backend: {
        getGoals: vi.fn().mockResolvedValue([]),
        createGoal: vi.fn().mockResolvedValue("g1"),
        getTasks: vi.fn().mockResolvedValue([]),
        getAllTasks: vi.fn().mockResolvedValue([]),
        getTaskById: vi.fn().mockResolvedValue(null),
        createTask: vi.fn().mockResolvedValue("t1"),
        updateTask: vi.fn().mockResolvedValue(undefined),
        addComment: vi.fn().mockResolvedValue(undefined),
        escalate: vi.fn().mockResolvedValue(undefined),
      },
    });
  }

  it("serializes tasks that touch the same constrained file", async () => {
    const orchestrator = createOrchestrator(["*.pbxproj"]);
    const executionOrder: string[] = [];

    const executeTask = vi.fn(async (task: Task) => {
      executionOrder.push(task.id);
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A", { serializedFiles: ["project.pbxproj"] }),
        makeTask("B", { serializedFiles: ["project.pbxproj"] }),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    // A must complete before B starts (serialized)
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("B"));
  });

  it("tasks touching different files remain parallel", async () => {
    const orchestrator = createOrchestrator(["*.pbxproj", "package-lock.json"]);

    const executeTask = vi.fn(async (task: Task) => {
      return makeResult(task.id);
    });

    const tasks = [
      makeTask("A", { serializedFiles: ["project.pbxproj"] }),
      makeTask("B", { serializedFiles: ["Cargo.lock"] }),
    ];

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    // Structural check: verify the DAG places both tasks in the same tier,
    // meaning they CAN run in parallel (no synthetic dependency injected).
    const dagNodes: DAGNode[] = tasks.map((t) => ({
      id: t.id,
      dependsOn: t.dependsOn ?? [],
      serializedFiles: t.serializedFiles,
    }));
    const constrained = applySerializationConstraints(dagNodes, ["*.pbxproj", "package-lock.json"]);
    const tiers = topologicalSort(constrained);
    // Both A and B should be in the same tier (tier 0) since they touch different files
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toContain("A");
    expect(tiers[0]).toContain("B");
  });

  it("tasks with no file declarations are unaffected by constraints", async () => {
    const orchestrator = createOrchestrator(["*.pbxproj"]);

    const executeTask = vi.fn(async (task: Task) => {
      return makeResult(task.id);
    });

    // No serializedFiles on any task — should go through flat dispatch
    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A"),
        makeTask("B"),
        makeTask("C"),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    // All tasks should have been called
    expect(executeTask).toHaveBeenCalledTimes(3);
  });

  it("serializes shared files even without constraint patterns configured", async () => {
    const orchestrator = createOrchestrator(); // no constraint patterns
    const executionOrder: string[] = [];

    const executeTask = vi.fn(async (task: Task) => {
      executionOrder.push(task.id);
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A", { serializedFiles: ["project.pbxproj"] }),
        makeTask("B", { serializedFiles: ["project.pbxproj"] }),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    // Shared-file detection serializes these even without config patterns
    expect(result.completed).toHaveLength(2);
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("B"));
  });

  it("combines explicit dependencies with serialization constraints", async () => {
    const orchestrator = createOrchestrator(["*.pbxproj"]);
    const executionOrder: string[] = [];

    const executeTask = vi.fn(async (task: Task) => {
      executionOrder.push(task.id);
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A", { serializedFiles: ["project.pbxproj"] }),
        makeTask("B", { deps: ["A"] }),
        makeTask("C", { serializedFiles: ["project.pbxproj"] }),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(3);
    // A must run first (explicit dep for B, serialization for C)
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("B"));
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("C"));
  });
});

// ---------------------------------------------------------------------------
// applySharedFileConstraints — pure DAG function
// ---------------------------------------------------------------------------

describe("applySharedFileConstraints", () => {
  it("two tasks with overlapping serializedFiles are serialized", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    // B should now depend on A (serialized by shared file)
    expect(result[1].dependsOn).toContain("A");
    // A should remain independent
    expect(result[0].dependsOn).toEqual([]);
  });

  it("two tasks with no overlapping files remain parallel", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/lib/auth.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toEqual([]);
  });

  it("three tasks where A-B share one file and B-C share another are all serialized", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/lib/jwt.ts", "src/lib/auth.ts"] },
      { id: "C", dependsOn: [], serializedFiles: ["src/lib/auth.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    // For jwt.ts: A and B share it -> B depends on A
    expect(result[1].dependsOn).toContain("A");
    // For auth.ts: B and C share it. Depth-based sorting puts the shallower
    // task first (C at depth 0) and deeper task second (B at depth 1, since
    // it already depends on A from jwt.ts). So B depends on C.
    expect(result[1].dependsOn).toContain("C");
    // A and C remain independent
    expect(result[0].dependsOn).toEqual([]);
    expect(result[2].dependsOn).toEqual([]);

    // Must produce a valid DAG. A and C can run in parallel (different files),
    // but B must wait for both (shares jwt.ts with A and auth.ts with C).
    const tiers = topologicalSort(result);
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toContain("A");
    expect(tiers[0]).toContain("C");
    expect(tiers[1]).toEqual(["B"]);
  });

  it("tasks with no serializedFiles are unchanged", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: ["A"] },
    ];

    const result = applySharedFileConstraints(nodes);

    expect(result.find((n) => n.id === "A")!.dependsOn).toEqual([]);
    expect(result.find((n) => n.id === "B")!.dependsOn).toEqual([]);
    expect(result.find((n) => n.id === "C")!.dependsOn).toEqual(["A"]);
  });

  it("does not mutate input nodes", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    applySharedFileConstraints(nodes);

    // Original nodes should be unchanged
    expect(nodes[0].dependsOn).toEqual([]);
    expect(nodes[1].dependsOn).toEqual([]);
  });

  it("does not duplicate existing dependencies", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: ["A"], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    // B already depends on A — should not have duplicates
    const aDeps = result[1].dependsOn.filter((d) => d === "A");
    expect(aDeps).toHaveLength(1);
  });

  it("does not create a cycle when tasks arrive in reverse dependency order", () => {
    const nodes: DAGNode[] = [
      { id: "B", dependsOn: ["A"], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    const nodeA = result.find((n) => n.id === "A")!;
    const nodeB = result.find((n) => n.id === "B")!;
    expect(nodeA.dependsOn).not.toContain("B");
    expect(nodeB.dependsOn).toContain("A");

    // Must produce a valid DAG
    const tiers = topologicalSort(result);
    expect(tiers).toHaveLength(2);
  });

  it("works with a mix of shared-file and non-shared-file tasks", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
      { id: "B", dependsOn: [] },
      { id: "C", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    // A and C share jwt.ts -> C depends on A
    expect(result.find((n) => n.id === "C")!.dependsOn).toContain("A");
    // B is independent
    expect(result.find((n) => n.id === "B")!.dependsOn).toEqual([]);
    // A is independent
    expect(result.find((n) => n.id === "A")!.dependsOn).toEqual([]);

    const tiers = topologicalSort(result);
    // Tier 0: A and B (parallel), Tier 1: C
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toContain("A");
    expect(tiers[0]).toContain("B");
    expect(tiers[1]).toEqual(["C"]);
  });

  it("handles duplicate serializedFiles entries within a single task without self-dependency", () => {
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/lib/jwt.ts", "src/lib/jwt.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/lib/jwt.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    // A should NOT depend on itself
    expect(result.find((n) => n.id === "A")!.dependsOn).toEqual([]);
    // B depends on A (shared file)
    expect(result.find((n) => n.id === "B")!.dependsOn).toContain("A");

    // DAG should be valid
    const validation = validateDAG(result);
    expect(validation.valid).toBe(true);
  });

  it("uses exact string matching, not glob", () => {
    // Ensure that "src/*.ts" in one task does NOT match "src/foo.ts" in another —
    // this is exact string comparison, not glob.
    const nodes: DAGNode[] = [
      { id: "A", dependsOn: [], serializedFiles: ["src/*.ts"] },
      { id: "B", dependsOn: [], serializedFiles: ["src/foo.ts"] },
    ];

    const result = applySharedFileConstraints(nodes);

    expect(result.find((n) => n.id === "A")!.dependsOn).toEqual([]);
    expect(result.find((n) => n.id === "B")!.dependsOn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: dispatchParallel with shared-file serialization (no config patterns)
// ---------------------------------------------------------------------------

describe("dispatchParallel with shared-file serialization", () => {
  function makeTask(id: string, opts?: { deps?: string[]; serializedFiles?: string[] }): Task {
    return {
      id,
      goal_id: "g1",
      description: `Task ${id}`,
      intent: "implementation",
      status: "pending",
      order: 0,
      ...(opts?.deps && opts.deps.length > 0 ? { dependsOn: opts.deps } : {}),
      ...(opts?.serializedFiles ? { serializedFiles: opts.serializedFiles } : {}),
    };
  }

  const goal: Goal = {
    id: "g1",
    description: "Test goal",
    priority: 1,
    status: "pending",
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
    // No serialization_constraints configured — shared-file detection
    // should still serialize tasks with overlapping serializedFiles.
    return new Orchestrator({
      projectConfig: {
        project: "test",
        swarm_path: "/tmp/swarm",
        trust_level: "medium",
        concurrency: {
          max_workers: 3,
          max_tokens_per_session: 10_000_000,
          max_tokens_per_task: 5_000_000,
          max_tokens_per_goal: 5_000_000,
        },
        task_backend: "local",
        created: new Date().toISOString(),
      },
      backend: {
        getGoals: vi.fn().mockResolvedValue([]),
        createGoal: vi.fn().mockResolvedValue("g1"),
        getTasks: vi.fn().mockResolvedValue([]),
        getAllTasks: vi.fn().mockResolvedValue([]),
        getTaskById: vi.fn().mockResolvedValue(null),
        createTask: vi.fn().mockResolvedValue("t1"),
        updateTask: vi.fn().mockResolvedValue(undefined),
        addComment: vi.fn().mockResolvedValue(undefined),
        escalate: vi.fn().mockResolvedValue(undefined),
      },
    });
  }

  it("serializes tasks with shared files even without config patterns", async () => {
    const orchestrator = createOrchestrator();
    const executionOrder: string[] = [];

    const executeTask = vi.fn(async (task: Task) => {
      executionOrder.push(task.id);
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A", { serializedFiles: ["src/lib/jwt.ts"] }),
        makeTask("B", { serializedFiles: ["src/lib/jwt.ts"] }),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    // A must complete before B starts (serialized by shared file)
    expect(executionOrder.indexOf("A")).toBeLessThan(executionOrder.indexOf("B"));
  });

  it("tasks with non-overlapping files remain parallel even without config patterns", async () => {
    const orchestrator = createOrchestrator();

    const executeTask = vi.fn(async (task: Task) => {
      return makeResult(task.id);
    });

    const result = await orchestrator.dispatchParallel({
      tasks: [
        makeTask("A", { serializedFiles: ["src/lib/jwt.ts"] }),
        makeTask("B", { serializedFiles: ["src/lib/auth.ts"] }),
      ],
      goal,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyCreateModifyConstraints
// ---------------------------------------------------------------------------

describe("applyCreateModifyConstraints", () => {
  it("injects dependency when task B modifies a file that task A creates", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], createsFiles: ["src/Foo.swift"], serializedFiles: [] },
      { id: "t2", dependsOn: [], serializedFiles: ["src/Foo.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    expect(result[1].dependsOn).toContain("t1");
  });

  it("does not inject self-dependency", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], createsFiles: ["src/Foo.swift"], serializedFiles: ["src/Foo.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    expect(result[0].dependsOn).not.toContain("t1");
  });

  it("does not inject dependency when no create/modify overlap", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], createsFiles: ["src/A.swift"] },
      { id: "t2", dependsOn: [], serializedFiles: ["src/B.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    expect(result[1].dependsOn).toHaveLength(0);
  });

  it("handles multiple creators and modifiers", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], createsFiles: ["src/Model.swift"] },
      { id: "t2", dependsOn: [], createsFiles: ["src/Service.swift"] },
      { id: "t3", dependsOn: [], serializedFiles: ["src/Model.swift", "src/Service.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    // t3 modifies both files, should depend on both creators
    expect(result[2].dependsOn).toContain("t1");
    expect(result[2].dependsOn).toContain("t2");
  });

  it("multiple creators of the same file — modifier depends on all of them", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], createsFiles: ["src/Shared.swift"] },
      { id: "t2", dependsOn: [], createsFiles: ["src/Shared.swift"] },
      { id: "t3", dependsOn: [], serializedFiles: ["src/Shared.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    // t3 should depend on BOTH t1 and t2 since both create the file
    expect(result[2].dependsOn).toContain("t1");
    expect(result[2].dependsOn).toContain("t2");
  });

  it("returns nodes unchanged when no createsFiles present", () => {
    const nodes: DAGNode[] = [
      { id: "t1", dependsOn: [], serializedFiles: ["src/A.swift"] },
      { id: "t2", dependsOn: [], serializedFiles: ["src/B.swift"] },
    ];

    const result = applyCreateModifyConstraints(nodes);
    expect(result[0].dependsOn).toHaveLength(0);
    expect(result[1].dependsOn).toHaveLength(0);
  });
});
