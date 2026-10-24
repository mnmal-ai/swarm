import { describe, it, expect } from "vitest";
import { formatObservationMd } from "./capture.js";
import type { RunObservation, TaskOutcomeSummary } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// The run summary reports tokens only: each goal and task line carries
// `Total tokens: 1,243,500` (all input, cache included, plus output), the
// frontmatter carries `total_tokens`, and no dollar figure appears anywhere.
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskOutcomeSummary> = {}): TaskOutcomeSummary {
  return {
    taskId: "goal-1-task-1",
    goalId: "goal-1",
    intent: "implementation",
    description: "Build the thing",
    verdict: "approved",
    latencyMs: 1000,
    retryCount: 0,
    arbiterInvolved: false,
    humanEscalation: false,
    rejectionReasons: [],
    ...overrides,
  };
}

function makeObs(tasks: TaskOutcomeSummary[], overrides: Partial<RunObservation> = {}): RunObservation {
  return {
    runId: "run-tokens-test",
    date: "2026-06-01",
    swarmVersion: "v0.13.0",
    project: "sample-project",
    workerModel: "model-a",
    reviewerModel: "model-b",
    goalsAttempted: ["goal-1"],
    goalsCompleted: ["goal-1"],
    goalsFailed: [],
    totalTasks: tasks.length,
    tasksApproved: tasks.length,
    tasksRejected: 0,
    totalRetries: 0,
    arbiterInvocations: 0,
    humanEscalations: 0,
    totalTokens: tasks.reduce((n, t) => n + (t.inputTokens ?? 0) + (t.outputTokens ?? 0), 0),
    durationMs: 1000,
    filesChanged: [],
    mergeConflicts: [],
    taskOutcomes: tasks,
    goalOutcomes: [
      {
        goalId: "goal-1",
        description: "Build the thing",
        status: "completed",
        tasksAttempted: tasks.length,
        tasksCompleted: tasks.length,
        designsReferenced: [],
      },
    ],
    paused: false,
    ...overrides,
  };
}

// 1,000,000 input (cache included) + 243,500 output = 1,243,500 tokens.
const TASK = makeTask({ inputTokens: 1_000_000, outputTokens: 243_500 });

describe("run summary — tokens only", () => {
  it("gives each task and goal its token total", () => {
    const md = formatObservationMd(makeObs([TASK]));

    const taskLine = md.split("\n").find(l => l.startsWith("- goal-1-task-1 ["));
    const goalLine = md.split("\n").find(l => l.startsWith("- goal-1: completed"));
    expect(taskLine).toContain("Total tokens: 1,243,500");
    expect(goalLine).toContain("Total tokens: 1,243,500");
  });

  it("sums a goal's tasks", () => {
    const second = makeTask({ taskId: "goal-1-task-2", inputTokens: 500_000, outputTokens: 6_500 });

    const md = formatObservationMd(makeObs([TASK, second]));

    const goalLine = md.split("\n").find(l => l.startsWith("- goal-1: completed"));
    expect(goalLine).toContain("Total tokens: 1,750,000");
  });

  it("records the run's tokens in the frontmatter", () => {
    const md = formatObservationMd(makeObs([TASK]));

    expect(md).toContain("total_tokens: 1243500");
    expect(md).not.toContain("cost_usd");
  });

  it("contains no dollar amount anywhere", () => {
    const md = formatObservationMd(makeObs([TASK]));

    expect(md).not.toMatch(/\$/);
  });

  it("renders a task without token counts as 0, not NaN", () => {
    const md = formatObservationMd(makeObs([makeTask()], { totalTokens: 0 }));

    expect(md).toContain("Total tokens: 0");
    expect(md).not.toContain("NaN");
  });
});
