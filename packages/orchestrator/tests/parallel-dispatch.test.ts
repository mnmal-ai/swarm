import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";
import type {
  ProjectConfig,
  Task,
  Goal,
  TaskBackend,
  ISwarmEventBus,
  SwarmOversightRunResult,
} from "@mnmal-ai/swarm-types";
import type { WorktreeManager } from "../src/worktree/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus(): ISwarmEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    onAny: vi.fn(() => () => {}),
    removeAllListeners: vi.fn(),
  };
}

function createMockBackend(): TaskBackend {
  return {
    createTask: vi.fn().mockResolvedValue(undefined),
    getTaskById: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getAllTasks: vi.fn().mockResolvedValue([]),
    escalate: vi.fn().mockResolvedValue(undefined),
  };
}

function createProjectConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    project: "test-project",
    trust_level: "medium",
    task_backend: "local",
    concurrency: {
      max_workers: 3,
      max_tokens_per_session: 20_000_000,
      max_tokens_per_task: 5_000_000,
      max_tokens_per_goal: 15_000_000,
    },
    ...overrides,
  } as ProjectConfig;
}

function createGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    description: "Test goal",
    priority: 1,
    status: "pending",
    constraints: [],
    acceptance_criteria: ["Should work"],
    ...overrides,
  };
}

function createTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id,
    goal_id: "goal-1",
    description: `Task ${id}`,
    intent: "implementation",
    status: "pending",
    order: 1,
    ...overrides,
  };
}

/** A result that used `tokens` tokens (all counted as input). */
function createMockResult(tokens = 1500): SwarmOversightRunResult {
  return {
    output: "Task completed",
    tokensUsed: { input: tokens, output: 0 },
    latencyMs: 2000,
    tokenLimitExceeded: false,
    oversight: {
      verdict: "approved",
      rejectionReasons: [],
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
    },
  };
}

function createMockWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn().mockImplementation(async (taskId: string) => ({
      id: taskId,
      path: `/repo/.swarm/worktrees/${taskId}`,
      branch: `swarm-worker/${taskId}`,
      baseBranch: "main",
      taskId,
      status: "active",
      filesChanged: [],
      createdAt: Date.now(),
      lastCheckedAt: Date.now(),
    })),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    pollChanges: vi.fn(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    merge: vi.fn().mockResolvedValue({ success: true }),
    destroy: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    isGitRepo: vi.fn().mockResolvedValue(true),
    getCurrentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator.dispatchParallel()", () => {
  let orchestrator: Orchestrator;
  let eventBus: ISwarmEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
  });

  it("max_workers === 1: tasks execute sequentially, no worktrees created", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 1, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2"), createTask("t3")];
    const goal = createGoal();

    const executionOrder: string[] = [];
    const executeTask = vi.fn().mockImplementation(async (task: Task) => {
      executionOrder.push(task.id);
      return createMockResult(0.5);
    });

    const worktreeManager = createMockWorktreeManager();

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
    });

    expect(result.completed).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    // No worktrees should be created for max_workers === 1
    expect(worktreeManager.create).not.toHaveBeenCalled();
  });

  it("max_workers === 3: up to 3 tasks execute in parallel", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 3, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2"), createTask("t3"), createTask("t4"), createTask("t5")];
    const goal = createGoal();

    // Use controlled promises so concurrency measurement is deterministic
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const gates: Array<() => void> = [];

    const executeTask = vi.fn().mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Block until the test opens the gate
      await new Promise<void>(resolve => { gates.push(resolve); });
      currentConcurrent--;
      return createMockResult(0.5);
    });

    const worktreeManager = createMockWorktreeManager();

    const dispatchPromise = orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
    });

    // Wait for the first batch of workers to be launched (3 at most)
    // Yield the event loop repeatedly until gates are populated
    for (let i = 0; i < 50 && gates.length < 3; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    // Exactly 3 workers should be in-flight (the pool limit)
    expect(gates.length).toBe(3);
    expect(maxConcurrent).toBe(3);

    // Release all blocked workers — remaining tasks will fill in
    while (gates.length > 0) gates.shift()!();
    // Yield for next batch
    for (let i = 0; i < 50 && gates.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    while (gates.length > 0) gates.shift()!();
    // Yield for any remaining
    for (let i = 0; i < 50 && gates.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    while (gates.length > 0) gates.shift()!();

    const result = await dispatchPromise;

    expect(result.completed).toHaveLength(5);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("session token limit stops dispatching new tasks but lets active workers finish", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 3, max_tokens_per_session: 1_500_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2"), createTask("t3"), createTask("t4"), createTask("t5")];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return createMockResult(1_000_000); // Each task uses 1M tokens, limit is 1.5M
    });

    const worktreeManager = createMockWorktreeManager();

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
    });

    // Should complete some tasks but skip later ones due to the token limit
    expect(result.completed.length).toBeGreaterThan(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.completed.length + result.skipped.length + result.failed.length).toBe(5);
    expect(result.totalTokens).toBe(result.completed.length * 1_000_000);
    expect(orchestrator.getCumulativeTokens()).toBe(result.totalTokens);
  });

  it("failed tasks go to results.failed, don't block other workers", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 3, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2-fail"), createTask("t3")];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async (task: Task) => {
      if (task.id === "t2-fail") {
        throw new Error("Task failed");
      }
      return createMockResult(0.5);
    });

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].task.id).toBe("t2-fail");
    expect(result.failed[0].error.message).toBe("Task failed");
  });

  it("onTaskComplete callback fires after each task", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 2, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2")];
    const goal = createGoal();
    const completedIds: string[] = [];

    const onTaskComplete = vi.fn().mockImplementation(async (task: Task) => {
      completedIds.push(task.id);
    });

    const executeTask = vi.fn().mockImplementation(async () => createMockResult(0.5));

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      onTaskComplete,
    });

    expect(onTaskComplete).toHaveBeenCalledTimes(2);
    expect(completedIds).toHaveLength(2);
  });

  it("worktree create() called for each parallel task; cleanup() called after each", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 2, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2")];
    const goal = createGoal();
    const worktreeManager = createMockWorktreeManager();

    const executeTask = vi.fn().mockImplementation(async () => createMockResult(0.5));

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
    });

    expect(worktreeManager.create).toHaveBeenCalledTimes(2);
    // After merge conflict handling fix: orchestrator calls merge() + destroy()
    // instead of cleanup() for successful tasks
    expect(worktreeManager.merge).toHaveBeenCalledTimes(2);
    expect(worktreeManager.destroy).toHaveBeenCalledTimes(2);
  });

  it("merge conflict moves task from completed to failed and calls onTaskComplete with error", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 2, max_tokens_per_session: 20_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 15_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2")];
    const goal = createGoal();
    const worktreeManager = createMockWorktreeManager();

    // First merge succeeds, second has a conflict
    (worktreeManager.merge as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, conflictFiles: ["src/shared.ts"] });

    const executeTask = vi.fn().mockImplementation(async () => createMockResult(0.5));
    const onTaskComplete = vi.fn();

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
      onTaskComplete,
    });

    // t1 succeeded and merged, t2 succeeded at worker level but merge conflicted
    expect(result.completed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error.message).toContain("Merge conflict");
    expect(result.failed[0].error.message).toContain("src/shared.ts");

    // onTaskComplete should be called for both tasks
    expect(onTaskComplete).toHaveBeenCalledTimes(2);

    // The merge-conflicted task (t2) should be called with null result and an error
    const conflictCall = onTaskComplete.mock.calls.find(
      (call: unknown[]) => call[0]?.id === "t2",
    );
    expect(conflictCall).toBeDefined();
    expect(conflictCall![1]).toBeNull(); // result is null
    expect(conflictCall![2]).toBeInstanceOf(Error); // error is present
    expect(conflictCall![2].message).toContain("Merge conflict");

    // The successful task (t1) should be called with result and no error
    const successCall = onTaskComplete.mock.calls.find(
      (call: unknown[]) => call[0]?.id === "t1",
    );
    expect(successCall).toBeDefined();
    expect(successCall![1]).not.toBeNull(); // result is present
    expect(successCall![2]).toBeUndefined(); // no error

    // task_merge_conflict orchestration event should be emitted
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const conflictEvent = emitCalls.find(
      (call: unknown[]) => call[0] === "orchestration:event" &&
        (call[1] as { eventType?: string })?.eventType === "task_merge_conflict",
    );
    expect(conflictEvent).toBeDefined();
  });

  it("goal token limit skips remaining tasks for that goal", async () => {
    const config = createProjectConfig({ concurrency: { max_workers: 1, max_tokens_per_session: 100_000_000, max_tokens_per_task: 50_000_000, max_tokens_per_goal: 2_000_000 } });
    orchestrator = new Orchestrator({ projectConfig: config, backend: createMockBackend(), eventBus });

    const tasks = [createTask("t1"), createTask("t2"), createTask("t3")];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async () => createMockResult(1_500_000));

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    // First task uses 1.5M tokens (under the 2M goal limit), second pushes over
    expect(result.completed.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("handles deadlock — all remaining tasks blocked with no executable ones", async () => {
    const config = createProjectConfig({
      concurrency: {
        max_workers: 3,
        max_tokens_per_session: 50_000_000,
        max_tokens_per_task: 10_000_000,
        max_tokens_per_goal: 30_000_000,
      },
    });
    orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    // Task A depends on B, B depends on A — circular dependency is caught
    // by validateDAG. Instead, test the case where the only dependency fails:
    // B depends on A, A fails → B should be skipped, not hang.
    const tasks = [
      createTask("A"),
      createTask("B", { dependsOn: ["A"] }),
      createTask("C", { dependsOn: ["B"] }),
    ];
    const goal = createGoal();
    const worktreeManager = createMockWorktreeManager();

    const executeTask = vi.fn().mockImplementation(async (task: Task) => {
      // A always fails
      if (task.id === "A") throw new Error("A failed");
      return createMockResult();
    });

    const result = await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
      worktreeManager,
    });

    // A failed, B and C should be skipped (not hung)
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].task.id).toBe("A");
    expect(result.skipped.length).toBe(2);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(["B", "C"]);
    // Loop should terminate, not hang
    expect(result.completed.length).toBe(0);
  });
});
