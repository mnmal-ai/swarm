import { describe, it, expect } from "vitest";
import {
  validateDecompositionConfig,
  effectiveDecomposition,
  describeDecomposition,
  foldTasksToCap,
  planTaskSplit,
  classifyTaskForDispatch,
} from "../src/decomposition/index.js";
import { DEFAULT_COMPLEXITY_THRESHOLDS } from "../src/complexity/index.js";
import type { AutonomyConfig, DecompositionConfig, Goal, Task } from "@mnmal-ai/swarm-types";

// decompose_on_failure is the only autonomy key the policy reads.
const FLAG_ON = { escalation: { decompose_on_failure: true } } as AutonomyConfig;
const FLAG_OFF = { escalation: { decompose_on_failure: false } } as AutonomyConfig;

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-7",
    description: "Renew a loan from the shelf screen",
    priority: 1,
    status: "pending",
    constraints: [],
    acceptance_criteria: [],
    ...overrides,
  };
}

function task(n: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `goal-7-task-${n}`,
    goal_id: "goal-7",
    title: `Task ${n} title`,
    description: `Task ${n} description.`,
    intent: "implementation",
    status: "pending",
    order: n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateDecompositionConfig
// ---------------------------------------------------------------------------

describe("validateDecompositionConfig", () => {
  it("accepts no block, an empty block, and every valid setting", () => {
    expect(validateDecompositionConfig(undefined)).toEqual([]);
    expect(validateDecompositionConfig({})).toEqual([]);
    for (const mode of ["never", "on_failure", "auto"]) {
      expect(validateDecompositionConfig({ max_tasks: 1, sub_decompose: mode })).toEqual([]);
    }
    expect(validateDecompositionConfig({ max_tasks: 12 })).toEqual([]);
  });

  it("names max_tasks when it is not a whole number of at least 1", () => {
    for (const bad of [0, -2, 1.5, "3", null, Number.NaN]) {
      const errors = validateDecompositionConfig({ max_tasks: bad });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^decomposition\.max_tasks must be a whole number of at least 1/);
    }
  });

  it("names sub_decompose when it is not one of the three modes", () => {
    const errors = validateDecompositionConfig({ sub_decompose: "sometimes" });
    expect(errors).toEqual([
      `decomposition.sub_decompose must be "never", "on_failure" or "auto" (got "sometimes")`,
    ]);
    expect(validateDecompositionConfig({ sub_decompose: "AUTO" })).toHaveLength(1);
  });

  it("names a key it does not know, so a typo is not silently ignored", () => {
    expect(validateDecompositionConfig({ max_task: 3 })).toEqual([
      "decomposition.max_task is not a setting (known: max_tasks, sub_decompose)",
    ]);
  });

  it("refuses a block that is not an object", () => {
    for (const bad of [null, [], "auto", 3]) {
      expect(validateDecompositionConfig(bad)[0]).toMatch(/^decomposition must be an object/);
    }
  });

  it("reports every problem at once", () => {
    expect(validateDecompositionConfig({ max_tasks: 0, sub_decompose: "x", extra: true })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// effectiveDecomposition
// ---------------------------------------------------------------------------

describe("effectiveDecomposition — project policy", () => {
  it("defaults to today's behaviour: no cap, auto, every kind of split", () => {
    expect(effectiveDecomposition(undefined, undefined, FLAG_ON)).toEqual({
      maxTasks: undefined,
      subDecompose: "auto",
      proactive: true,
      speculative: true,
      reactive: true,
      source: "project",
      warnings: [],
    });
    expect(effectiveDecomposition({}, goal(), FLAG_ON)).toEqual(effectiveDecomposition(undefined, undefined, FLAG_ON));
  });

  it("auto splits proactively; it splits on failure only when decompose_on_failure is on", () => {
    const off = effectiveDecomposition({ sub_decompose: "auto" }, goal(), FLAG_OFF);
    expect(off).toMatchObject({ subDecompose: "auto", proactive: true, reactive: false });
    // A speculative sub-plan is only ever used when an escalation splits the
    // task, so with reactive splitting off it would always be thrown away.
    expect(off.speculative).toBe(false);
  });

  it("on_failure never splits proactively, and splits on failure only with decompose_on_failure", () => {
    expect(effectiveDecomposition({ sub_decompose: "on_failure" }, goal(), FLAG_ON)).toMatchObject({
      subDecompose: "on_failure", proactive: false, speculative: false, reactive: true,
    });
    expect(effectiveDecomposition({ sub_decompose: "on_failure" }, goal(), FLAG_OFF)).toMatchObject({
      subDecompose: "on_failure", proactive: false, speculative: false, reactive: false,
    });
  });

  it("never splits at all, whatever decompose_on_failure says", () => {
    for (const autonomy of [FLAG_ON, FLAG_OFF]) {
      expect(effectiveDecomposition({ sub_decompose: "never" }, goal(), autonomy)).toMatchObject({
        subDecompose: "never", proactive: false, speculative: false, reactive: false,
      });
    }
  });

  it("carries max_tasks through", () => {
    expect(effectiveDecomposition({ max_tasks: 3, sub_decompose: "on_failure" }, goal(), FLAG_ON).maxTasks).toBe(3);
  });
});

describe("effectiveDecomposition — per-goal split", () => {
  const project: DecompositionConfig = { max_tasks: 4, sub_decompose: "on_failure" };

  it("split false is one task, never split", () => {
    expect(effectiveDecomposition(project, goal({ split: false }), FLAG_ON)).toEqual({
      maxTasks: 1,
      subDecompose: "never",
      proactive: false,
      speculative: false,
      reactive: false,
      source: "swarm_split: false",
      warnings: [],
    });
    expect(effectiveDecomposition(undefined, goal({ split: false }), FLAG_ON)).toMatchObject({ maxTasks: 1, subDecompose: "never" });
  });

  it("split true is no cap and auto, overriding the project", () => {
    expect(effectiveDecomposition(project, goal({ split: true }), FLAG_ON)).toEqual({
      maxTasks: undefined,
      subDecompose: "auto",
      proactive: true,
      speculative: true,
      reactive: true,
      source: "swarm_split: true",
      warnings: [],
    });
    expect(effectiveDecomposition({ sub_decompose: "never", max_tasks: 1 }, goal({ split: true }), FLAG_ON))
      .toMatchObject({ maxTasks: undefined, subDecompose: "auto", proactive: true });
  });

  it("split true still needs decompose_on_failure to split on failure", () => {
    expect(effectiveDecomposition(project, goal({ split: true }), FLAG_OFF)).toMatchObject({
      subDecompose: "auto", proactive: true, speculative: false, reactive: false,
    });
  });

  it("a goal without split follows the project", () => {
    expect(effectiveDecomposition(project, goal(), FLAG_ON)).toMatchObject({
      maxTasks: 4, subDecompose: "on_failure", source: "project",
    });
  });

  it("warns, naming the goal, when it carried both labels", () => {
    const eff = effectiveDecomposition(project, goal({ split: false, splitConflict: true }), FLAG_ON);
    expect(eff).toMatchObject({ maxTasks: 1, subDecompose: "never", source: "swarm_split: false" });
    expect(eff.warnings).toEqual([
      `Goal "Renew a loan from the shelf screen" [goal-7] has both swarm_split: true and swarm_split: false; using swarm_split: false.`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// describeDecomposition — the banner row
// ---------------------------------------------------------------------------

describe("describeDecomposition", () => {
  it("says what will happen, with the cap", () => {
    expect(describeDecomposition(effectiveDecomposition(undefined, undefined, FLAG_ON))).toBe("auto · no cap");
    expect(describeDecomposition(effectiveDecomposition({ max_tasks: 3, sub_decompose: "on_failure" }, undefined, FLAG_ON)))
      .toBe("on failure · max 3 tasks");
    expect(describeDecomposition(effectiveDecomposition({ sub_decompose: "never" }, undefined, FLAG_ON))).toBe("never · no cap");
    expect(describeDecomposition(effectiveDecomposition({ max_tasks: 1, sub_decompose: "never" }, undefined, FLAG_ON)))
      .toBe("never · max 1 task");
  });

  it("says when decompose_on_failure turns splitting on failure off", () => {
    expect(describeDecomposition(effectiveDecomposition({ sub_decompose: "on_failure" }, undefined, FLAG_OFF)))
      .toBe("never (on_failure, but decompose_on_failure is off) · no cap");
    expect(describeDecomposition(effectiveDecomposition(undefined, undefined, FLAG_OFF)))
      .toBe("auto, not on failure (decompose_on_failure is off) · no cap");
  });

  it("names a label override", () => {
    expect(describeDecomposition(effectiveDecomposition(undefined, goal({ split: false }), FLAG_ON)))
      .toBe("never · max 1 task (swarm_split: false)");
    expect(describeDecomposition(effectiveDecomposition({ sub_decompose: "never" }, goal({ split: true }), FLAG_ON)))
      .toBe("auto · no cap (swarm_split: true)");
  });
});

// ---------------------------------------------------------------------------
// foldTasksToCap
// ---------------------------------------------------------------------------

describe("foldTasksToCap", () => {
  it("leaves a plan within the cap alone", () => {
    const tasks = [task(1), task(2), task(3)];
    expect(foldTasksToCap(tasks, 3)).toEqual({ tasks, folded: 0 });
    expect(foldTasksToCap(tasks, 5)).toEqual({ tasks, folded: 0 });
  });

  it("folds every task after the (N-1)th into task N, dropping no work", () => {
    const tasks = [
      task(1, { intent: "investigation", serializedFiles: ["src/a.ts"] }),
      task(2, { serializedFiles: ["src/b.ts"] }),
      task(3, { title: "Add the renewal check", description: "Refuse a renewal on a held title.", serializedFiles: ["src/loans.ts"], createsFiles: ["src/holds.ts"] }),
      task(4, { title: "Cover the refusal", description: "Test the held-title refusal.", serializedFiles: ["src/loans.ts", "src/loans.test.ts"], createsFiles: ["src/loans.test.ts"] }),
      task(5, { title: "Review the change", description: "Read the diff.", intent: "code-review", serializedFiles: ["src/c.ts"] }),
    ];
    const { tasks: out, folded } = foldTasksToCap(tasks, 3);

    expect(folded).toBe(2);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(tasks[0]);
    expect(out[1]).toEqual(tasks[1]);

    const merged = out[2];
    expect(merged.id).toBe("goal-7-task-3");
    expect(merged.order).toBe(3);
    expect(merged.title).toBe("Add the renewal check");
    expect(merged.description).toBe([
      "This task does 3 planned steps, in order:",
      "",
      "Step 1 of 3: Add the renewal check",
      "Refuse a renewal on a held title.",
      "",
      "Step 2 of 3: Cover the refusal",
      "Test the held-title refusal.",
      "",
      "Step 3 of 3: Review the change",
      "Read the diff.",
    ].join("\n"));
    expect(merged.serializedFiles).toEqual(["src/loans.ts", "src/loans.test.ts", "src/c.ts"]);
    expect(merged.createsFiles).toEqual(["src/holds.ts", "src/loans.test.ts"]);
    expect(merged.intent).toBe("implementation");
  });

  it("keeps task N's intent unless a folded task is implementation", () => {
    const review = [task(1), task(2, { intent: "code-review" }), task(3, { intent: "code-review" })];
    expect(foldTasksToCap(review, 2).tasks[1].intent).toBe("code-review");

    const investigate = [task(1, { intent: "investigation" }), task(2, { intent: "code-review" })];
    expect(foldTasksToCap(investigate, 1).tasks[0].intent).toBe("investigation");

    const reviewThenBuild = [task(1), task(2, { intent: "code-review" }), task(3, { intent: "implementation" })];
    expect(foldTasksToCap(reviewThenBuild, 2).tasks[1].intent).toBe("implementation");
  });

  it("remaps dependsOn to the merged task and drops dependencies inside it", () => {
    const tasks = [
      task(1),
      task(2, { dependsOn: ["goal-7-task-4"] }),
      task(3, { dependsOn: ["goal-7-task-1"] }),
      task(4, { dependsOn: ["goal-7-task-3", "goal-7-task-2"] }),
      task(5, { dependsOn: ["goal-7-task-4", "goal-7-task-1", "goal-7-task-9"] }),
    ];
    const { tasks: out } = foldTasksToCap(tasks, 3);
    expect(out[1].dependsOn).toEqual(["goal-7-task-3"]);
    expect(out[2].dependsOn).toEqual(["goal-7-task-1", "goal-7-task-2", "goal-7-task-9"]);
  });

  it("with a cap of 1, makes one task that does the whole plan", () => {
    const tasks = [task(1, { intent: "investigation", title: undefined, description: "Look first." }), task(2), task(3)];
    const { tasks: out, folded } = foldTasksToCap(tasks, 1);
    expect(folded).toBe(2);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("goal-7-task-1");
    expect(out[0].intent).toBe("implementation");
    expect(out[0].description).toContain("Step 1 of 3\nLook first.");
    expect(out[0].description).toContain("Step 2 of 3: Task 2 title\nTask 2 description.");
    expect(out[0].description).toContain("Step 3 of 3: Task 3 title\nTask 3 description.");
    expect(out[0].serializedFiles).toBeUndefined();
    expect(out[0].createsFiles).toBeUndefined();
    expect(out[0].dependsOn).toBeUndefined();
  });

  it("does not change the tasks it was given", () => {
    const tasks = [task(1, { serializedFiles: ["a.ts"] }), task(2, { serializedFiles: ["b.ts"] })];
    const before = JSON.parse(JSON.stringify(tasks));
    foldTasksToCap(tasks, 1);
    expect(tasks).toEqual(before);
  });

  it("refuses a cap below 1", () => {
    expect(() => foldTasksToCap([task(1)], 0)).toThrow(/at least 1/);
  });
});

// ---------------------------------------------------------------------------
// planTaskSplit / classifyTaskForDispatch — the run path's gating
// ---------------------------------------------------------------------------

describe("planTaskSplit", () => {
  const auto = effectiveDecomposition(undefined, undefined, FLAG_ON);
  const autoNoFailure = effectiveDecomposition(undefined, undefined, FLAG_OFF);
  const onFailure = effectiveDecomposition({ sub_decompose: "on_failure" }, undefined, FLAG_ON);
  const never = effectiveDecomposition({ sub_decompose: "never" }, undefined, FLAG_ON);

  it("under auto: complex tasks split first, moderate ones get a speculative sub-plan (today's behaviour)", () => {
    expect(planTaskSplit("complex", false, auto)).toEqual({ proactive: "pre_split", armEscalationWatcher: false });
    expect(planTaskSplit("moderate", false, auto)).toEqual({ proactive: "speculative", armEscalationWatcher: true });
    expect(planTaskSplit("simple", false, auto)).toEqual({ proactive: "none", armEscalationWatcher: false });
  });

  it("never splits a subtask again", () => {
    expect(planTaskSplit("complex", true, auto).proactive).toBe("none");
    expect(planTaskSplit("moderate", true, auto).proactive).toBe("none");
  });

  it("under on_failure: nothing is split up front; moderate tasks are still watched", () => {
    expect(planTaskSplit("complex", false, onFailure)).toEqual({ proactive: "none", armEscalationWatcher: false });
    expect(planTaskSplit("moderate", false, onFailure)).toEqual({ proactive: "none", armEscalationWatcher: true });
  });

  it("under never: nothing is split and nothing is watched for a split", () => {
    for (const band of ["simple", "moderate", "complex"] as const) {
      expect(planTaskSplit(band, false, never)).toEqual({ proactive: "none", armEscalationWatcher: false });
    }
  });

  it("under auto without decompose_on_failure: complex tasks still split first, nothing else", () => {
    expect(planTaskSplit("complex", false, autoNoFailure)).toEqual({ proactive: "pre_split", armEscalationWatcher: false });
    expect(planTaskSplit("moderate", false, autoNoFailure)).toEqual({ proactive: "none", armEscalationWatcher: false });
  });
});

describe("classifyTaskForDispatch", () => {
  it("scores the task against the thresholds it is given and plans its split", () => {
    const description =
      "Check the loan renewal endpoint in src/loans/renewals.ts and its test in src/loans/renewals.test.ts, " +
      "and confirm the due date moves forward by the renewal period, and that a renewal on a reserved title is refused, " +
      "and that the response names the new due date, and that the event entry records who renewed it, and that nothing else changes. " +
      "Keep the change small and local to the renewal path so the reviewer can read it in one sitting without context from other areas.";
    const auto = effectiveDecomposition(undefined, undefined, FLAG_ON);

    const byDefault = classifyTaskForDispatch({ description }, DEFAULT_COMPLEXITY_THRESHOLDS, auto);
    expect(byDefault.complexity).toMatchObject({ score: 47, band: "moderate" });
    expect(byDefault.split.proactive).toBe("speculative");

    const stricter = classifyTaskForDispatch({ description }, { ...DEFAULT_COMPLEXITY_THRESHOLDS, simpleMax: 20, complexMin: 45 }, auto);
    expect(stricter.complexity.band).toBe("complex");
    expect(stricter.split.proactive).toBe("pre_split");

    const asSubtask = classifyTaskForDispatch({ description, parentTaskId: "goal-7-task-2" }, { ...DEFAULT_COMPLEXITY_THRESHOLDS, complexMin: 45 }, auto);
    expect(asSubtask.split.proactive).toBe("none");
  });
});
