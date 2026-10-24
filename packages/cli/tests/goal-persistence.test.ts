import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Goal } from "@mnmal-ai/swarm-types";
import { getExecutableGoals } from "@mnmal-ai/swarm-orchestrator";
import { persistGoalStatus, filterCheckpointTasks, recordSkippedGoals } from "../src/cli/run.js";

interface GoalsManifest {
  goals: Goal[];
}

function makeGoal(overrides: Partial<Goal> & { id: string }): Goal {
  return {
    description: `Goal ${overrides.id}`,
    priority: 1,
    status: "pending",
    acceptance_criteria: [],
    constraints: [],
    ...overrides,
  };
}

describe("goal status persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-goal-persist-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persistGoalStatus writes updated status to disk", async () => {
    const goalsPath = join(dir, "goals.json");
    const manifest: GoalsManifest = {
      goals: [
        makeGoal({ id: "goal-1", priority: 1 }),
        makeGoal({ id: "goal-2", priority: 2, dependsOn: ["goal-1"] }),
      ],
    };
    writeFileSync(goalsPath, JSON.stringify(manifest, null, 2));

    // Mutate in-memory then call the real production function
    manifest.goals[0].status = "completed";
    const success = await persistGoalStatus(goalsPath, manifest);

    expect(success).toBe(true);

    // Re-read and verify
    const reloaded: GoalsManifest = JSON.parse(readFileSync(goalsPath, "utf-8"));
    expect(reloaded.goals[0].status).toBe("completed");
    expect(reloaded.goals[1].status).toBe("pending");
  });

  it("persistGoalStatus returns false on write failure", async () => {
    // Non-existent directory — write should fail gracefully
    const badPath = join(dir, "nonexistent", "subdir", "goals.json");
    const manifest: GoalsManifest = { goals: [makeGoal({ id: "goal-1", priority: 1 })] };

    const success = await persistGoalStatus(badPath, manifest);
    expect(success).toBe(false);
  });

  it("completed goals unblock dependents on resume (using real getExecutableGoals)", () => {
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
      makeGoal({ id: "goal-2", priority: 2, dependsOn: ["goal-1"] }),
      makeGoal({ id: "goal-3", priority: 3, dependsOn: ["goal-2"] }),
    ];

    const { executable, blocked } = getExecutableGoals(goals);

    // goal-1 completed, goal-2 unblocked, goal-3 still blocked
    expect(executable.map(g => g.id)).toEqual(["goal-2"]);
    expect(blocked.map(g => g.id)).toEqual(["goal-3"]);
  });

  it("filterCheckpointTasks clears tasks for reset goals", () => {
    const completedTasks = [
      "goal-1-task-1", "goal-1-task-2", "goal-1-task-3",
      "goal-2-task-1", "goal-2-task-2",
      "goal-3-task-1",
    ];
    const skippedTasks = ["goal-2-task-3"];

    const resetGoalIds = ["goal-2"];

    expect(filterCheckpointTasks(completedTasks, resetGoalIds)).toEqual([
      "goal-1-task-1", "goal-1-task-2", "goal-1-task-3",
      "goal-3-task-1",
    ]);
    expect(filterCheckpointTasks(skippedTasks, resetGoalIds)).toEqual([]);
  });

  it("filterCheckpointTasks handles goal ID prefixes correctly (no false positives)", () => {
    const completedTasks = [
      "goal-1-task-1",
      "goal-10-task-1",  // should NOT match goal-1
      "goal-1-task-2",
    ];

    expect(filterCheckpointTasks(completedTasks, ["goal-1"])).toEqual(["goal-10-task-1"]);
  });

  it("status=blocked goals are hard-skipped, not executable (using real getExecutableGoals)", () => {
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
      makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
    ];

    const { executable, skipped, skipReasons } = getExecutableGoals(goals);

    // swarm bug#3: a status=blocked goal is a hard skip even when its deps are
    // satisfied — it must never reach decomposition. Retry happens by resetting
    // the goal to "pending" upstream before this filter runs (out of scope here).
    expect(executable.map(g => g.id)).toEqual([]);
    expect(skipped.map(g => g.id)).toEqual(["goal-2"]);
    expect(skipReasons["goal-2"]).toBe("goal status is blocked");
  });

  it("a goal reset to pending becomes executable when deps are satisfied", () => {
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
      // The same goal-2 as above, after an upstream re-attempt reset it to pending.
      makeGoal({ id: "goal-2", priority: 2, status: "pending", dependsOn: ["goal-1"] }),
    ];

    const { executable, skipped } = getExecutableGoals(goals);

    expect(executable.map(g => g.id)).toEqual(["goal-2"]);
    expect(skipped.map(g => g.id)).toEqual([]);
  });

  it("pending goals with unmet deps stay blocked (using real getExecutableGoals)", () => {
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1 }),
      makeGoal({ id: "goal-2", priority: 2, dependsOn: ["goal-1"] }),
    ];

    const { executable, blocked } = getExecutableGoals(goals);

    // Only goal-1 executable (no deps), goal-2 blocked
    expect(executable.map(g => g.id)).toEqual(["goal-1"]);
    expect(blocked.map(g => g.id)).toEqual(["goal-2"]);
  });
});

describe("recordSkippedGoals — goal_blocked emission for skipped goals (bug#3)", () => {
  interface RecordedEvent { type: string; message: string; goalId: string }

  function captureEvents(): { events: RecordedEvent[]; record: (type: "goal_blocked", message: string, meta: { goal_id: string }) => void } {
    const events: RecordedEvent[] = [];
    return {
      events,
      record: (type, message, meta) => { events.push({ type, message, goalId: meta.goal_id }); },
    };
  }

  it("a status='blocked' goal triggers a goal_blocked event and is never decomposed/dispatched", () => {
    // Drive the production filter, then the production skip handler — end to end
    // through the two functions the dispatch loop composes.
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
      makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
    ];

    const { executable, skipped, skipReasons } = getExecutableGoals(goals);
    // Hard skip: the blocked goal is never executable even though its dep is done.
    expect(executable.map(g => g.id)).toEqual([]);
    expect(skipped.map(g => g.id)).toEqual(["goal-2"]);

    const processedGoalIds = new Set<string>();
    const { events, record } = captureEvents();
    const outcomes = recordSkippedGoals(skipped, skipReasons, processedGoalIds, record, () => {});

    // Exactly one goal_blocked event, with the filter's own skip reason as the message.
    expect(events).toEqual([
      { type: "goal_blocked", message: "goal status is blocked", goalId: "goal-2" },
    ]);
    // The goal is marked processed — the dispatch loop selects only executable
    // goals NOT in processedGoalIds, so it can never be decomposed or dispatched.
    expect(processedGoalIds.has("goal-2")).toBe(true);
    // It is not in the executable set, the only set the dispatch loop draws from.
    expect(executable.map(g => g.id)).not.toContain("goal-2");
    // Ship Readiness summary row carries the skip reason.
    expect(outcomes).toEqual([
      { goalId: "goal-2", applied: false, status: "skipped", detail: "goal status is blocked" },
    ]);
  });

  it("uses the per-goal skip reason from getExecutableGoals for each event message", () => {
    // g0 pending → g1 blocked-with-unmet-dep (own status hard skip) →
    // g2 depends on the failed g1 (dependency-failed skip under skipBlockedGoals).
    const goals: Goal[] = [
      makeGoal({ id: "g0", priority: 1 }),
      makeGoal({ id: "g1", priority: 2, status: "blocked", dependsOn: ["g0"] }),
      makeGoal({ id: "g2", priority: 3, dependsOn: ["g1"] }),
    ];

    const { skipped, skipReasons } = getExecutableGoals(goals, true);
    const processedGoalIds = new Set<string>();
    const { events, record } = captureEvents();
    recordSkippedGoals(skipped, skipReasons, processedGoalIds, record, () => {});

    const byGoal = Object.fromEntries(events.map(e => [e.goalId, e.message]));
    expect(byGoal.g1).toBe("goal status is blocked");
    expect(byGoal.g2).toBe("dependency failed");
    expect(events.every(e => e.type === "goal_blocked")).toBe(true);
  });

  it("is idempotent: a goal already processed does not emit a second event", () => {
    const goals: Goal[] = [
      makeGoal({ id: "goal-1", priority: 1, status: "blocked" }),
    ];
    const { skipped, skipReasons } = getExecutableGoals(goals);
    const processedGoalIds = new Set<string>();
    const { events, record } = captureEvents();

    recordSkippedGoals(skipped, skipReasons, processedGoalIds, record, () => {});
    // Second pass (e.g. next dispatch-loop iteration) — already processed.
    const secondOutcomes = recordSkippedGoals(skipped, skipReasons, processedGoalIds, record, () => {});

    expect(events).toHaveLength(1);
    expect(secondOutcomes).toEqual([]);
  });
});
