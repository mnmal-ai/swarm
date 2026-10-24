/**
 * CLI wiring for the project's `decomposition` policy: startup validation,
 * the planner prompt's task cap, and the cap applied to what the planner
 * returns.
 */

import { describe, it, expect } from "vitest";
import type { Goal, ProjectConfig, Task } from "@mnmal-ai/swarm-types";
import type { Swarm } from "@mnmal-ai/swarm-core";
import {
  assertValidDecompositionConfig,
  applyPlannerCap,
  goalDecompositionWarnings,
  plannerTaskCapInstruction,
} from "../src/cli/decomposition-policy.js";
import { decomposeGoal } from "../src/cli/run.js";

const configPath = "/swarm/domains/sample-project/config.json";

describe("assertValidDecompositionConfig", () => {
  it("passes a config without decomposition, and a valid one", () => {
    expect(() => assertValidDecompositionConfig({} as ProjectConfig, configPath)).not.toThrow();
    expect(() =>
      assertValidDecompositionConfig({ decomposition: { max_tasks: 3, sub_decompose: "on_failure" } } as ProjectConfig, configPath),
    ).not.toThrow();
  });

  it("throws one error naming the file and every bad key", () => {
    const bad = { decomposition: { max_tasks: 0, sub_decompose: "sometimes" } } as unknown as ProjectConfig;
    expect(() => assertValidDecompositionConfig(bad, configPath)).toThrow(`Invalid decomposition in ${configPath}`);
    expect(() => assertValidDecompositionConfig(bad, configPath)).toThrow(/decomposition\.max_tasks/);
    expect(() => assertValidDecompositionConfig(bad, configPath)).toThrow(/decomposition\.sub_decompose/);
  });
});

describe("plannerTaskCapInstruction", () => {
  it("says nothing without a cap", () => {
    expect(plannerTaskCapInstruction(undefined)).toBeUndefined();
  });

  it("asks for at most N tasks", () => {
    expect(plannerTaskCapInstruction(3)).toBe(
      "Plan at most 3 tasks. Combine small steps into the task they belong to rather than listing them separately.",
    );
  });

  it("asks for exactly one task that does the whole goal when the cap is 1", () => {
    expect(plannerTaskCapInstruction(1)).toBe("Plan exactly one task that does the whole goal.");
  });
});

// ---------------------------------------------------------------------------
// decomposeGoal — the planner prompt
// ---------------------------------------------------------------------------

const GOAL: Goal = {
  id: "goal-3",
  description: "Show the due date on the loan receipt",
  priority: 1,
  status: "pending",
  constraints: [],
  acceptance_criteria: ["The receipt names the due date"],
};

function plannerOutput(n: number): string {
  return JSON.stringify({
    shared_files: [],
    tasks: Array.from({ length: n }, (_, i) => ({
      title: `Step ${i + 1}`,
      description: `Do step ${i + 1}.`,
      intent: "implementation",
      creates: i === 0 ? ["src/receipt.ts"] : [],
      modifies: [`src/file-${i + 1}.ts`],
    })),
  });
}

/** A Swarm that records what the planner was asked and answers with `output`. */
function fakeSwarm(output: string): { swarm: Swarm; inputs: string[] } {
  const inputs: string[] = [];
  const swarm = {
    run: async (_task: string, options: { input: string }) => {
      inputs.push(options.input);
      return { output };
    },
  } as unknown as Swarm;
  return { swarm, inputs };
}

describe("decomposeGoal — task cap in the planner prompt", () => {
  it("asks for at most N tasks when the goal has a cap", async () => {
    const { swarm, inputs } = fakeSwarm(plannerOutput(2));
    await decomposeGoal(swarm, GOAL, "sample-project", "/repo", undefined, undefined, undefined, undefined, 3);
    expect(inputs[0]).toContain("Plan at most 3 tasks.");
  });

  it("asks for exactly one task when the cap is 1", async () => {
    const { swarm, inputs } = fakeSwarm(plannerOutput(1));
    await decomposeGoal(swarm, GOAL, "sample-project", "/repo", undefined, undefined, undefined, undefined, 1);
    expect(inputs[0]).toContain("Plan exactly one task that does the whole goal.");
    expect(inputs[0]).not.toContain("at most");
  });

  it("says nothing about a cap when there is none", async () => {
    const { swarm, inputs } = fakeSwarm(plannerOutput(2));
    const { tasks } = await decomposeGoal(swarm, GOAL, "sample-project", "/repo");
    expect(inputs[0]).not.toMatch(/Plan at most|Plan exactly one/);
    expect(tasks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// applyPlannerCap — the cap enforced on the planner's answer
// ---------------------------------------------------------------------------

describe("applyPlannerCap", () => {
  it("leaves a plan within the cap, or with no cap, alone", async () => {
    const { swarm } = fakeSwarm(plannerOutput(5));
    const { tasks, createsMap } = await decomposeGoal(swarm, GOAL, "sample-project", "/repo");
    expect(applyPlannerCap(tasks, createsMap, undefined)).toEqual({ tasks, createsMap, message: null });
    expect(applyPlannerCap(tasks, createsMap, 5)).toEqual({ tasks, createsMap, message: null });
  });

  it("folds a planner that ignored the cap, keeping every file claim", async () => {
    const { swarm } = fakeSwarm(plannerOutput(5));
    const planned = await decomposeGoal(swarm, GOAL, "sample-project", "/repo", undefined, undefined, undefined, undefined, 3);
    expect(planned.tasks).toHaveLength(5);

    // The first task creates a file; fold it into task 1 with a cap of 1.
    const capped = applyPlannerCap(planned.tasks, planned.createsMap, 1);
    expect(capped.message).toBe("Folded 4 of 5 planned tasks into task 1 (max 1 task)");
    expect(capped.tasks).toHaveLength(1);
    expect(capped.tasks[0].id).toBe("goal-3-task-1");
    expect(capped.tasks[0].serializedFiles).toEqual(["src/file-1.ts", "src/file-2.ts", "src/file-3.ts", "src/file-4.ts", "src/file-5.ts"]);
    expect(capped.tasks[0].createsFiles).toBeUndefined();
    expect([...capped.createsMap]).toEqual([["goal-3-task-1", ["src/receipt.ts"]]]);

    const three = applyPlannerCap(planned.tasks, planned.createsMap, 3);
    expect(three.message).toBe("Folded 2 of 5 planned tasks into task 3 (max 3 tasks)");
    expect(three.tasks.map((t: Task) => t.id)).toEqual(["goal-3-task-1", "goal-3-task-2", "goal-3-task-3"]);
    expect(three.tasks[2].description).toContain("Step 3 of 3: Step 5\nDo step 5.");
  });
});

describe("goalDecompositionWarnings", () => {
  const autonomy = { escalation: { decompose_on_failure: true } } as never;

  it("warns about each goal whose ticket carried both swarm_split labels, naming it", () => {
    const goals: Goal[] = [
      { ...GOAL, id: "trello-kq7Lm2Pa", description: "Add barcode labels for new copies", split: false, splitConflict: true },
      { ...GOAL, id: "trello-zz", description: "Other", split: true },
      GOAL,
    ];
    expect(goalDecompositionWarnings(goals, { max_tasks: 3 }, autonomy)).toEqual([
      `Goal "Add barcode labels for new copies" [trello-kq7Lm2Pa] has both swarm_split: true and swarm_split: false; using swarm_split: false.`,
    ]);
  });

  it("is empty when no goal conflicts", () => {
    expect(goalDecompositionWarnings([GOAL, { ...GOAL, split: false }], undefined, autonomy)).toEqual([]);
  });
});
