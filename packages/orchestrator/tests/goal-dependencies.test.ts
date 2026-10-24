import { describe, it, expect } from "vitest";
import { getExecutableGoals } from "../src/orchestrator/goal-deps.js";
import type { Goal } from "@mnmal-ai/swarm-types";

describe("getExecutableGoals", () => {
  it("blocks a goal whose dependency is not complete", () => {
    const goals: Goal[] = [
      { id: "g1", description: "Build", priority: 1, status: "pending", constraints: [], acceptance_criteria: [] },
      { id: "g2", description: "Cleanup", priority: 2, status: "pending", constraints: [], acceptance_criteria: [], dependsOn: ["g1"] },
    ];
    const { executable, blocked } = getExecutableGoals(goals);
    expect(executable.map((g) => g.id)).toEqual(["g1"]);
    expect(blocked.map((g) => g.id)).toEqual(["g2"]);
  });

  it("unblocks a goal when dependency completes", () => {
    const goals: Goal[] = [
      { id: "g1", description: "Build", priority: 1, status: "completed", constraints: [], acceptance_criteria: [] },
      { id: "g2", description: "Cleanup", priority: 2, status: "pending", constraints: [], acceptance_criteria: [], dependsOn: ["g1"] },
    ];
    const { executable, blocked } = getExecutableGoals(goals);
    expect(executable.map((g) => g.id)).toEqual(["g2"]);
    expect(blocked).toHaveLength(0);
  });

  it("handles goals with no dependencies", () => {
    const goals: Goal[] = [
      { id: "g1", description: "Independent", priority: 1, status: "pending", constraints: [], acceptance_criteria: [] },
    ];
    const { executable } = getExecutableGoals(goals);
    expect(executable.map((g) => g.id)).toEqual(["g1"]);
  });

  it("handles diamond dependencies", () => {
    const goals: Goal[] = [
      { id: "g1", description: "Foundation", priority: 1, status: "completed", constraints: [], acceptance_criteria: [] },
      { id: "g2", description: "Components", priority: 2, status: "completed", constraints: [], acceptance_criteria: [], dependsOn: ["g1"] },
      { id: "g3", description: "Pages", priority: 3, status: "completed", constraints: [], acceptance_criteria: [], dependsOn: ["g1"] },
      { id: "g4", description: "Cleanup", priority: 4, status: "pending", constraints: [], acceptance_criteria: [], dependsOn: ["g2", "g3"] },
    ];
    const { executable } = getExecutableGoals(goals);
    expect(executable.map((g) => g.id)).toEqual(["g4"]);
  });

  it("blocks when only some dependencies are complete", () => {
    const goals: Goal[] = [
      { id: "g1", description: "A", priority: 1, status: "completed", constraints: [], acceptance_criteria: [] },
      { id: "g2", description: "B", priority: 2, status: "pending", constraints: [], acceptance_criteria: [] },
      { id: "g3", description: "C", priority: 3, status: "pending", constraints: [], acceptance_criteria: [], dependsOn: ["g1", "g2"] },
    ];
    const { executable, blocked } = getExecutableGoals(goals);
    expect(executable.map((g) => g.id)).toEqual(["g2"]);
    expect(blocked.map((g) => g.id)).toEqual(["g3"]);
  });

  it("skips completed and in_progress goals and hard-skips blocked goals", () => {
    const goals: Goal[] = [
      { id: "g1", description: "Done", priority: 1, status: "completed", constraints: [], acceptance_criteria: [] },
      { id: "g2", description: "Running", priority: 2, status: "in_progress", constraints: [], acceptance_criteria: [] },
      { id: "g3", description: "Stuck", priority: 3, status: "blocked", constraints: [], acceptance_criteria: [] },
    ];
    const { executable, blocked, skipped, skipReasons } = getExecutableGoals(goals);
    // A status="blocked" goal is a hard skip (bug#3), not executable — even
    // with no dependencies. Re-attempts reset it to "pending" upstream.
    expect(executable).toHaveLength(0);
    expect(blocked).toHaveLength(0);
    expect(skipped.map(g => g.id)).toEqual(["g3"]);
    expect(skipReasons.g3).toBe("goal status is blocked");
  });
});
