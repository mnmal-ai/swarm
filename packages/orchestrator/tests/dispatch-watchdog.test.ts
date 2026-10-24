/**
 * Integration test for the dispatch-loop watchdog.
 *
 * Bug context: `_dispatchFlat`'s inner `await Promise.race([...active.values()])`
 * has no timeout. When every active worker wedges (the claude.exe SDK can fail
 * to translate its own `queryTimeoutMs` into a rejected promise — observed in
 * three production incidents), Promise.race never resolves and the dispatch
 * loop hangs indefinitely. Swarm logs go silent and the operator has to Ctrl+C.
 *
 * Fix: race against a watchdog timeout (`workerHeartbeatMs`, default 30 min,
 * configurable on OrchestratorConfig). When it fires, emit `task_wedged`,
 * mark the currently-active workers as failed, and let the existing failure
 * path drive replanning / continuation.
 */

import { describe, it, expect } from "vitest";
import { Orchestrator, WorkerWedgedError } from "../src/orchestrator/index.js";
import type {
  SwarmOversightRunResult,
  ProjectConfig,
  Task,
} from "@mnmal-ai/swarm-types";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goal_id: overrides.goal_id ?? "goal-1",
    title: overrides.title ?? id,
    description: overrides.description ?? `do ${id}`,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 1,
    intent: overrides.intent ?? "implementation",
    files_to_create: overrides.files_to_create ?? [],
    files_to_modify: overrides.files_to_modify ?? [],
  } as Task;
}

function makeOrchestrator(workerHeartbeatMs: number): Orchestrator {
  return new Orchestrator({
    projectConfig: {
      project: "test",
      swarm_path: ".swarm",
      trust_level: "low",
      task_backend: "local",
      models: {
        worker: "test",
        reviewer: "test",
        arbiter: "test",
        provider: "anthropic",
      },
      backends: {},
      base_branch: "main",
      isolation: null,
      concurrency: {
        max_workers: 1,
        max_tokens_per_session: 100_000_000,
        max_tokens_per_task: 10_000_000,
        max_tokens_per_goal: 50_000_000,
      },
    } as unknown as ProjectConfig,
    backend: { run: async () => ({ output: "", tokenUsage: {} }) } as never,
    workerHeartbeatMs,
  });
}

describe("Orchestrator dispatch-loop watchdog", () => {
  it("WorkerWedgedError carries the wedged task ids and heartbeat", () => {
    const err = new WorkerWedgedError(["t1", "t2"], 500);
    expect(err.name).toBe("WorkerWedgedError");
    expect(err.activeTaskIds).toEqual(["t1", "t2"]);
    expect(err.heartbeatMs).toBe(500);
    expect(err.message).toContain("500ms");
    expect(err.message).toContain("t1");
    expect(err.message).toContain("t2");
  });

  it("dispatchParallel returns (does not hang) when the worker never settles", async () => {
    const orch = makeOrchestrator(100);

    // Worker never resolves — simulates a wedged SDK call below queryTimeoutMs.
    const executeTask = (): Promise<SwarmOversightRunResult> => new Promise(() => {
      /* intentionally never resolves */
    });

    // Race the dispatch against a fail-bound timer. Without the watchdog the
    // dispatch hangs forever and vitest's own timeout would kill the test;
    // with the watchdog the dispatch must return well under the bound.
    const dispatchPromise = orch.dispatchParallel({
      tasks: [makeTask("wedged-1")],
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    const FAIL_BOUND_MS = 3000;
    const failBound = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), FAIL_BOUND_MS),
    );

    const winner = await Promise.race([dispatchPromise.then(() => "dispatch" as const), failBound]);
    expect(winner).toBe("dispatch");

    const result = await dispatchPromise;
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.task.id).toBe("wedged-1");
    expect(result.failed[0]?.error).toBeInstanceOf(WorkerWedgedError);
  }, 10_000);

  it("records a task_wedged event when the watchdog fires", async () => {
    const orch = makeOrchestrator(100);

    const executeTask = (): Promise<SwarmOversightRunResult> => new Promise(() => { /* hang */ });

    await orch.dispatchParallel({
      tasks: [makeTask("hang-task")],
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    const events = (orch as unknown as { events: { event_type: string; detail: string }[] }).events;
    const wedged = events.filter((e) => e.event_type === "task_wedged");
    expect(wedged.length).toBeGreaterThanOrEqual(1);
    expect(wedged[0]?.detail).toContain("hang-task");
  }, 10_000);

  it("continues dispatching subsequent queued tasks after a wedge", async () => {
    // Two tasks, max_workers=1: first wedges → watchdog fires → second runs.
    const orch = makeOrchestrator(100);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      if (task.id === "wedge") {
        return new Promise(() => { /* never */ });
      }
      return {
        output: "ok",
        tokensUsed: { input: 0, output: 0 },
        latencyMs: 0,
        tokenLimitExceeded: false,
        oversight: {
          verdict: "approved",
          rejectionReasons: [],
          retryCount: 0,
          arbiterInvolved: false,
          humanEscalation: false,
        },
      } as SwarmOversightRunResult;
    };

    const result = await orch.dispatchParallel({
      tasks: [makeTask("wedge"), makeTask("normal")],
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: "/tmp",
      executeTask,
    });

    expect(result.failed.map((f) => f.task.id)).toContain("wedge");
    expect(result.completed.map((c) => c.task.id)).toContain("normal");
  }, 10_000);
});
