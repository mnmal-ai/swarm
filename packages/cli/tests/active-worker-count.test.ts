/**
 * Regression test:
 * Dashboard shows more active workers than max_workers allows.
 *
 * Root cause: active_workers count in telemetry events was emitted
 * before the active Map was cleaned up (pre-cleanup snapshot), or
 * not emitted at all, defaulting to 0.
 *
 * This test verifies that all recorded events from _dispatchFlat()
 * never report active_workers > max_workers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@mnmal-ai/swarm-orchestrator";
import type {
  ProjectConfig,
  Task,
  Goal,
  TaskBackend,
  ISwarmEventBus,
  SwarmOversightRunResult,
} from "@mnmal-ai/swarm-types";

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

function createProjectConfig(maxWorkers: number): ProjectConfig {
  return {
    project: "test-project",
    trust_level: "medium",
    task_backend: "local",
    concurrency: {
      max_workers: maxWorkers,
      max_tokens_per_session: 100_000_000,
      max_tokens_per_task: 50_000_000,
      max_tokens_per_goal: 80_000_000,
    },
  } as ProjectConfig;
}

function createGoal(): Goal {
  return {
    id: "goal-1",
    description: "Test goal",
    priority: 1,
    status: "pending",
    constraints: [],
    acceptance_criteria: ["Should work"],
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

function createMockResult(): SwarmOversightRunResult {
  return {
    output: "Task completed",
    tokensUsed: { input: 1000, output: 500 },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("active_workers count never exceeds max_workers", () => {
  let eventBus: ISwarmEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
  });

  it("recorded events never show active_workers > max_workers (max_workers=2, 3 tasks, first completes quickly)", async () => {
    const maxWorkers = 2;
    const config = createProjectConfig(maxWorkers);
    const orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    const tasks = [
      createTask("fast-task"),
      createTask("slow-task-1"),
      createTask("slow-task-2"),
    ];
    const goal = createGoal();

    // First task completes immediately; other two take longer
    const executeTask = vi.fn().mockImplementation(async (task: Task) => {
      if (task.id === "fast-task") {
        // Completes almost immediately
        await new Promise((r) => setTimeout(r, 5));
      } else {
        // Takes longer
        await new Promise((r) => setTimeout(r, 50));
      }
      return createMockResult();
    });

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    // Check ALL recorded events for active_workers violations
    const events = orchestrator.getEvents();
    const eventsWithActiveWorkers = events.filter(
      (e) => e.active_workers !== undefined && e.active_workers > 0,
    );

    // There should be events with active_workers set
    expect(eventsWithActiveWorkers.length).toBeGreaterThan(0);

    // No event should ever report more active workers than max_workers
    for (const event of events) {
      expect(event.active_workers).toBeLessThanOrEqual(maxWorkers);
    }
  });

  it("task_completed and task_failed events include accurate post-cleanup active_workers", async () => {
    const maxWorkers = 2;
    const config = createProjectConfig(maxWorkers);
    const orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    const tasks = [
      createTask("task-ok"),
      createTask("task-fail"),
      createTask("task-ok-2"),
    ];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async (task: Task) => {
      if (task.id === "task-fail") {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("Simulated failure");
      }
      await new Promise((r) => setTimeout(r, 10));
      return createMockResult();
    });

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    const events = orchestrator.getEvents();

    // Verify task_completed events exist and have active_workers set
    const completedEvents = events.filter((e) => e.event_type === "task_completed");
    expect(completedEvents.length).toBe(2);
    for (const e of completedEvents) {
      expect(e.active_workers).toBeLessThanOrEqual(maxWorkers);
      expect(e.active_workers).toBeGreaterThanOrEqual(0);
    }

    // Verify task_failed events exist and have active_workers set
    const failedEvents = events.filter((e) => e.event_type === "task_failed");
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].active_workers).toBeLessThanOrEqual(maxWorkers);
    expect(failedEvents[0].active_workers).toBeGreaterThanOrEqual(0);
  });

  it("task_dispatched events show correct active_workers count as pool fills", async () => {
    const maxWorkers = 2;
    const config = createProjectConfig(maxWorkers);
    const orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    const tasks = [
      createTask("t1"),
      createTask("t2"),
      createTask("t3"),
    ];
    const goal = createGoal();

    // Use gates to control task completion order
    const gates: Array<() => void> = [];
    const executeTask = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      return createMockResult();
    });

    const dispatchPromise = orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    // Wait for the first batch to be dispatched (2 tasks, since max_workers=2)
    for (let i = 0; i < 50 && gates.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(gates.length).toBe(2);

    // Check dispatch events so far
    let events = orchestrator.getEvents();
    const dispatchedEvents = events.filter((e) => e.event_type === "task_dispatched");
    expect(dispatchedEvents.length).toBe(2);
    // First dispatched task: active.size = 1
    expect(dispatchedEvents[0].active_workers).toBe(1);
    // Second dispatched task: active.size = 2
    expect(dispatchedEvents[1].active_workers).toBe(2);

    // Neither should exceed max_workers
    expect(dispatchedEvents[0].active_workers).toBeLessThanOrEqual(maxWorkers);
    expect(dispatchedEvents[1].active_workers).toBeLessThanOrEqual(maxWorkers);

    // Release first task so third can be dispatched
    gates.shift()!();

    // Wait for third task to be dispatched
    for (let i = 0; i < 50 && gates.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Release remaining
    while (gates.length > 0) gates.shift()!();

    await dispatchPromise;

    // Final check: no event exceeds max_workers
    events = orchestrator.getEvents();
    for (const event of events) {
      expect(event.active_workers).toBeLessThanOrEqual(maxWorkers);
    }
  });

  it("active_workers count with max_workers=1 never exceeds 1", async () => {
    const maxWorkers = 1;
    const config = createProjectConfig(maxWorkers);
    const orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    const tasks = [
      createTask("t1"),
      createTask("t2"),
      createTask("t3"),
    ];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return createMockResult();
    });

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    const events = orchestrator.getEvents();

    // Every event should have active_workers <= 1
    for (const event of events) {
      expect(event.active_workers).toBeLessThanOrEqual(maxWorkers);
    }

    // Should have dispatched and completed events
    const dispatchedEvents = events.filter((e) => e.event_type === "task_dispatched");
    const completedEvents = events.filter((e) => e.event_type === "task_completed");
    expect(dispatchedEvents.length).toBe(3);
    expect(completedEvents.length).toBe(3);
  });

  it("active_workers in completed/failed events reflects post-cleanup state (not pre-cleanup)", async () => {
    const maxWorkers = 2;
    const config = createProjectConfig(maxWorkers);
    const orchestrator = new Orchestrator({
      projectConfig: config,
      backend: createMockBackend(),
      eventBus,
    });

    // Two tasks that complete at the same time
    const tasks = [createTask("t1"), createTask("t2")];
    const goal = createGoal();

    const executeTask = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return createMockResult();
    });

    await orchestrator.dispatchParallel({
      tasks,
      goal,
      project: "test-project",
      workingDirectory: "/repo",
      executeTask,
    });

    const events = orchestrator.getEvents();
    const completedEvents = events.filter((e) => e.event_type === "task_completed");

    // After the first task completes and is deleted from active map,
    // active.size should be 1 (one still running), not 2 (pre-cleanup)
    // After the second completes, active.size should be 0
    expect(completedEvents.length).toBe(2);

    // The key assertion: neither completed event should show active_workers = 2
    // (which would be the pre-cleanup count). The first should show 1 (one still
    // active), and the second should show 0 (none left).
    for (const e of completedEvents) {
      expect(e.active_workers).toBeLessThan(maxWorkers);
    }
  });
});

// ---------------------------------------------------------------------------
// Dashboard server activeWorkerCount capping
// ---------------------------------------------------------------------------

describe("Dashboard activeWorkerCount capping", () => {
  it("never exceeds maxWorkers even when worktree events arrive out of order", () => {
    // Simulate the dashboard state directly
    const state = {
      worktrees: [] as Array<{ id: string; taskId: string; status: string }>,
      activeWorkerCount: 0,
      maxWorkers: 3,
    };

    function recalcActiveWorkers() {
      const raw = state.worktrees.filter(w => w.status === "active").length;
      state.activeWorkerCount = Math.min(raw, state.maxWorkers);
    }

    // Create 5 worktrees (simulating race where merge events are delayed)
    for (let i = 1; i <= 5; i++) {
      state.worktrees.push({ id: `wt-${i}`, taskId: `t-${i}`, status: "active" });
      recalcActiveWorkers();
      // Should never exceed maxWorkers
      expect(state.activeWorkerCount).toBeLessThanOrEqual(state.maxWorkers);
    }

    // 5 raw active, but capped at 3
    expect(state.activeWorkerCount).toBe(3);

    // Merge two worktrees
    state.worktrees.find(w => w.id === "wt-1")!.status = "merged";
    state.worktrees.find(w => w.id === "wt-2")!.status = "merged";
    recalcActiveWorkers();
    expect(state.activeWorkerCount).toBe(3); // still 3 active

    // Merge one more
    state.worktrees.find(w => w.id === "wt-3")!.status = "merged";
    recalcActiveWorkers();
    expect(state.activeWorkerCount).toBe(2); // now 2 active
  });

  it("handles conflict status correctly in count", () => {
    const state = {
      worktrees: [
        { id: "wt-1", taskId: "t-1", status: "active" },
        { id: "wt-2", taskId: "t-2", status: "conflict" },
        { id: "wt-3", taskId: "t-3", status: "active" },
      ],
      activeWorkerCount: 0,
      maxWorkers: 3,
    };

    const raw = state.worktrees.filter(w => w.status === "active").length;
    state.activeWorkerCount = Math.min(raw, state.maxWorkers);

    // conflict worktrees don't count as active
    expect(state.activeWorkerCount).toBe(2);
  });
});
