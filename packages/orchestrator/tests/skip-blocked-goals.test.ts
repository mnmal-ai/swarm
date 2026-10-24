/**
 * Skip blocked goals (dependency-failure skipping). A goal whose own status
 * is "blocked" is an orchestrator-level hard skip — it lands in `skipped`
 * (never `executable`) regardless of dependency state, before any
 * dependency-based routing.
 *
 * Tests getExecutableGoals():
 *   1. Goal with failed dependency is skipped (not returned as executable)
 *   2. Goal with no dependencies is still returned as executable
 *   3. Goal with completed dependency is returned as executable
 *   4. A status="blocked" goal is always skipped (satisfied/unsatisfied/no deps)
 */

import { describe, it, expect } from "vitest";
import { getExecutableGoals } from "../src/orchestrator/goal-deps.js";
import type { Goal } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helper to build goals quickly
// ---------------------------------------------------------------------------

function makeGoal(
  id: string,
  status: Goal["status"],
  dependsOn?: string[],
): Goal {
  return {
    id,
    description: `Goal ${id}`,
    priority: 1,
    status,
    constraints: [],
    acceptance_criteria: [],
    dependsOn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getExecutableGoals — skipBlockedGoals: true", () => {
  it("skips a goal whose dependency has failed (is in blocked state with unmet deps)", () => {
    // A "failed" goal is one that's "blocked" AND has unmet dependencies.
    // g0 is pending (never ran). g1 is blocked with g0 as unmet dep → failed.
    // g2 depends on g1 → should be skipped when skipBlockedGoals=true
    const goals: Goal[] = [
      makeGoal("g0", "pending"),
      makeGoal("g1", "blocked", ["g0"]),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { executable, blocked, skipped, skipReasons } = getExecutableGoals(goals, true);

    // g2 should be skipped because its dependency (g1) is failed
    expect(skipped.map((g) => g.id)).toContain("g2");
    expect(skipReasons.g2).toBe("dependency failed");
    // g2 should NOT be in executable or blocked
    expect(executable.map((g) => g.id)).not.toContain("g2");
    expect(blocked.map((g) => g.id)).not.toContain("g2");
    // g1's own status is blocked → hard-skipped with the status reason
    expect(skipped.map((g) => g.id)).toContain("g1");
    expect(skipReasons.g1).toBe("goal status is blocked");
  });

  it("hard-skips a blocked goal with no dependencies (own status takes precedence)", () => {
    // A status="blocked" goal is never executable, even with no deps. Its
    // dependents, however, are not skipped-for-failed-dependency (a no-dep
    // blocked goal did not fail a dependency) — they are merely blocked.
    const goals: Goal[] = [
      makeGoal("g1", "blocked"),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { executable, skipped, blocked, skipReasons } = getExecutableGoals(goals, true);

    // g1 (own status blocked) is skipped, never executable
    expect(skipped.map((g) => g.id)).toContain("g1");
    expect(executable.map((g) => g.id)).not.toContain("g1");
    expect(skipReasons.g1).toBe("goal status is blocked");
    // g2 depends on g1 (incomplete, but not a failed dependency) — blocked, not skipped
    expect(skipped.map((g) => g.id)).not.toContain("g2");
    expect(blocked.map((g) => g.id)).toContain("g2");
  });

  it("returns a goal with no dependencies as executable", () => {
    const goals: Goal[] = [
      makeGoal("independent", "pending"),
    ];

    const { executable, blocked, skipped } = getExecutableGoals(goals, true);

    expect(executable.map((g) => g.id)).toContain("independent");
    expect(blocked).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it("returns a goal with completed dependency as executable", () => {
    const goals: Goal[] = [
      makeGoal("g1", "completed"),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { executable, blocked, skipped } = getExecutableGoals(goals, true);

    expect(executable.map((g) => g.id)).toContain("g2");
    expect(skipped.map((g) => g.id)).not.toContain("g2");
    expect(blocked.map((g) => g.id)).not.toContain("g2");
  });

  it("blocks (not skips) a goal whose dependency is still pending", () => {
    // g1 is pending (not failed), g2 depends on g1 → should be blocked, not skipped
    const goals: Goal[] = [
      makeGoal("g1", "pending"),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { executable, blocked, skipped } = getExecutableGoals(goals, true);

    // g1 is executable (no deps)
    expect(executable.map((g) => g.id)).toContain("g1");
    // g2 is blocked (g1 is not yet complete, not failed)
    expect(blocked.map((g) => g.id)).toContain("g2");
    expect(skipped.map((g) => g.id)).not.toContain("g2");
  });

  it("does NOT skip dependents for failed deps when skipBlockedGoals is false, but still hard-skips own-status-blocked goals", () => {
    const goals: Goal[] = [
      makeGoal("g1", "blocked"),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { blocked, skipped, skipReasons } = getExecutableGoals(goals, false);

    // The skipBlockedGoals flag only gates dependency-failure skipping of
    // dependents — g2 is blocked, not skipped, regardless of the flag.
    expect(blocked.map((g) => g.id)).toContain("g2");
    expect(skipped.map((g) => g.id)).not.toContain("g2");
    // The own-status hard skip is unconditional — g1 is skipped even with the flag off.
    expect(skipped.map((g) => g.id)).toEqual(["g1"]);
    expect(skipReasons.g1).toBe("goal status is blocked");
  });

  it("returns empty skipped array when skipBlockedGoals is true but no goals have failed deps", () => {
    const goals: Goal[] = [
      makeGoal("g1", "completed"),
      makeGoal("g2", "pending", ["g1"]),
    ];

    const { skipped } = getExecutableGoals(goals, true);
    expect(skipped).toHaveLength(0);
  });

  it("handles mixed scenario: some goals skipped, some executable, some blocked", () => {
    const goals: Goal[] = [
      makeGoal("g0", "pending"),                      // never ran
      makeGoal("g1", "blocked", ["g0"]),              // failed (g0 incomplete)
      makeGoal("g2", "completed"),                    // done
      makeGoal("g3", "pending", ["g1"]),              // depends on failed → skip
      makeGoal("g4", "pending", ["g2"]),              // depends on completed → executable
      makeGoal("g5", "pending"),                      // no deps → executable
      makeGoal("g6", "pending", ["g4"]),              // depends on pending → blocked
    ];

    const { executable, blocked, skipped } = getExecutableGoals(goals, true);

    expect(executable.map((g) => g.id)).toContain("g4");
    expect(executable.map((g) => g.id)).toContain("g5");
    expect(skipped.map((g) => g.id)).toContain("g3");
    expect(blocked.map((g) => g.id)).toContain("g6");
  });

  it("hard-skips a blocked goal regardless of dependency state", () => {
    // Bug#3: a status="blocked" goal is never executable, whether its deps are
    // satisfied, unsatisfied, or absent. The own-status filter runs before any
    // dependency evaluation.
    const goals: Goal[] = [
      makeGoal("dep", "completed"),
      makeGoal("satisfied", "blocked", ["dep"]),   // deps satisfied
      makeGoal("unsatisfied", "blocked", ["dep", "missing"]), // a dep is unmet
      makeGoal("nodeps", "blocked"),               // no deps at all
    ];

    for (const flag of [true, false]) {
      const { executable, skipped, skipReasons } = getExecutableGoals(goals, flag);
      for (const id of ["satisfied", "unsatisfied", "nodeps"]) {
        expect(executable.map((g) => g.id)).not.toContain(id);
        expect(skipped.map((g) => g.id)).toContain(id);
        expect(skipReasons[id]).toBe("goal status is blocked");
      }
    }
  });
});
