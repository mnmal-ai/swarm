import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Goal } from "@mnmal-ai/swarm-types";
import { getExecutableGoals } from "@mnmal-ai/swarm-orchestrator";
import {
  persistGoalStatus,
  resetBlockedGoalsForRetry,
  determineGoalStatus,
} from "../src/cli/run.js";

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

// Bug#2: the goal status write-back must be IDEMPOTENT. When iter-1 tasks all
// fail the orchestrator persists status="blocked"; on a later run the retry
// succeeds but the status must flip back to "completed". With Bug#3 hard-skip
// in place, the retry only happens if a blocked goal is reset to "pending"
// upstream of getExecutableGoals — and the completion path must derive
// "completed" from this run's outcomes regardless of the prior status.
describe("goal status flip-back (bug#2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-goal-flipback-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("resetBlockedGoalsForRetry — blocked -> pending on dispatch", () => {
    it("resets a blocked goal to pending and returns its id (default mode)", () => {
      const goals: Goal[] = [
        makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
        makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
      ];

      const reset = resetBlockedGoalsForRetry(goals, /* skipBlockedGoals */ false);

      expect(reset).toEqual(["goal-2"]);
      expect(goals[1].status).toBe("pending");
      // Completed goals are untouched.
      expect(goals[0].status).toBe("completed");
    });

    it("leaves a deliberately-blocked goal skipped when skip_blocked_goals is set", () => {
      const goals: Goal[] = [
        makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
        makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
      ];

      const reset = resetBlockedGoalsForRetry(goals, /* skipBlockedGoals */ true);

      expect(reset).toEqual([]);
      expect(goals[1].status).toBe("blocked");
    });

    it("does not touch pending or in_progress goals", () => {
      const goals: Goal[] = [
        makeGoal({ id: "goal-1", priority: 1, status: "pending" }),
        makeGoal({ id: "goal-2", priority: 2, status: "in_progress" }),
      ];

      const reset = resetBlockedGoalsForRetry(goals, false);

      expect(reset).toEqual([]);
      expect(goals[0].status).toBe("pending");
      expect(goals[1].status).toBe("in_progress");
    });

    // The reset is the supported retry path: it runs upstream of
    // getExecutableGoals (Bug#3), which hard-skips any goal still "blocked".
    it("makes a previously-blocked goal executable once reset (full contract)", () => {
      const goals: Goal[] = [
        makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
        makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
      ];

      // Before reset: getExecutableGoals hard-skips the blocked goal.
      const before = getExecutableGoals(goals);
      expect(before.executable.map((g) => g.id)).toEqual([]);
      expect(before.skipped.map((g) => g.id)).toEqual(["goal-2"]);
      expect(before.skipReasons["goal-2"]).toBe("goal status is blocked");

      // After the upstream reset: the goal is executable (deps satisfied).
      resetBlockedGoalsForRetry(goals, false);
      const after = getExecutableGoals(goals);
      expect(after.executable.map((g) => g.id)).toEqual(["goal-2"]);
      expect(after.skipped.map((g) => g.id)).toEqual([]);
    });

    // When skip_blocked_goals is set the goal is NOT reset, so it stays
    // hard-skipped and never reaches decomposition (zero LLM calls).
    it("keeps a blocked goal hard-skipped under skip_blocked_goals", () => {
      const goals: Goal[] = [
        makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
        makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
      ];

      resetBlockedGoalsForRetry(goals, /* skipBlockedGoals */ true);
      const { executable, skipped, skipReasons } = getExecutableGoals(goals, true);

      expect(executable.map((g) => g.id)).toEqual([]);
      expect(skipped.map((g) => g.id)).toEqual(["goal-2"]);
      expect(skipReasons["goal-2"]).toBe("goal status is blocked");
    });
  });

  describe("determineGoalStatus — success -> completed regardless of prior state", () => {
    it("returns completed when all tasks complete", () => {
      expect(determineGoalStatus(3, 3)).toBe("completed");
    });

    it("returns blocked when no tasks complete", () => {
      expect(determineGoalStatus(0, 3)).toBe("blocked");
    });

    it("returns blocked when only some tasks complete", () => {
      expect(determineGoalStatus(2, 3)).toBe("blocked");
    });

    it("returns completed for a no-task goal (no work to fail)", () => {
      expect(determineGoalStatus(0, 0)).toBe("completed");
    });
  });

  describe("end-to-end write-back: blocked -> pending -> completed", () => {
    it("persists completed even when the prior persisted status was blocked", async () => {
      const goalsPath = join(dir, "goals.json");
      const manifest: GoalsManifest = {
        goals: [
          makeGoal({ id: "goal-1", priority: 1, status: "completed" }),
          // Persisted as blocked by a prior run whose iter-1 tasks all failed.
          makeGoal({ id: "goal-2", priority: 2, status: "blocked", dependsOn: ["goal-1"] }),
        ],
      };
      writeFileSync(goalsPath, JSON.stringify(manifest, null, 2));

      // (a) On dispatch: reset blocked -> pending, then persist.
      const reset = resetBlockedGoalsForRetry(manifest.goals, false);
      expect(reset).toEqual(["goal-2"]);
      await persistGoalStatus(goalsPath, manifest);

      const afterReset: GoalsManifest = JSON.parse(readFileSync(goalsPath, "utf-8"));
      expect(afterReset.goals[1].status).toBe("pending");

      // (b) On successful completion: status is derived from this run's
      // outcomes (all tasks done) — not from the prior "blocked" status —
      // and the write-back flips it to "completed".
      manifest.goals[1].status = determineGoalStatus(2, 2);
      expect(manifest.goals[1].status).toBe("completed");
      await persistGoalStatus(goalsPath, manifest);

      const afterSuccess: GoalsManifest = JSON.parse(readFileSync(goalsPath, "utf-8"));
      expect(afterSuccess.goals[1].status).toBe("completed");
    });
  });
});
