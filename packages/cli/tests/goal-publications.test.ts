import { describe, it, expect, vi } from "vitest";
import type { GoalPublication } from "@mnmal-ai/swarm-types";
import type { MergeableGoal, MergeGoalResult } from "@mnmal-ai/swarm-orchestrator";
import { earlierMergeOptions, formatEarlierPublications, mergeGoalSafely, publishEarlierMergeGoals, type GoalMerger } from "../src/cli/goal-publications.js";
import { stackPushQueue } from "../src/cli/goal-stack.js";

/**
 * `swarm run`'s side of publishing goals an earlier run finished: merge mode
 * gives each its push, PR and merge before this run's first goal; stacked
 * mode puts them at the front of this run's stack.
 */

const OPTIONS = { gate: { command: "true" }, skipLabels: ["swarm_merge: false"] };

function record(id: string, overrides: Partial<GoalPublication> = {}): GoalPublication {
  return { goal_id: id, description: `Goal ${id}`, mode: "merge", branch: `swarm/goal-${id}`, pushed: false, merged: false, ...overrides };
}

function merger(fail?: string): GoalMerger & { goals: MergeableGoal[]; restoreBaseBranch: ReturnType<typeof vi.fn> } {
  const goals: MergeableGoal[] = [];
  return {
    goals,
    mergeGoal: vi.fn(async (goal: MergeableGoal): Promise<MergeGoalResult> => {
      goals.push(goal);
      if (goal.goalId === fail) throw new Error("a listener threw");
      return { goalId: goal.goalId, branch: goal.branch, base: "main", merged: true, prUrl: `https://x/pull/${goal.goalId}` };
    }),
    restoreBaseBranch: vi.fn(async () => {}),
  };
}

describe("publishEarlierMergeGoals", () => {
  it("merges each pending goal in the order it finished, with its verdicts, labels and items", async () => {
    const m = merger();
    const seen: string[] = [];
    const left = [{ task: "Build it", items: ["Check it on a phone"] }];
    const outcomes = await publishEarlierMergeGoals(
      m,
      [record("a", { verdicts: ["approved"], labels: ["ui"], left_for_person: left }), record("b", { verdicts: ["approved"] })],
      OPTIONS,
      "main",
      (o) => { seen.push(o.goalId); },
    );

    expect(m.goals.map((g) => g.goalId)).toEqual(["a", "b"]);
    expect(m.goals[0]).toMatchObject({ verdicts: ["approved"], labels: ["ui"], leftForPerson: left, branch: "swarm/goal-a" });
    expect(outcomes.map((o) => o.merged)).toEqual([true, true]);
    expect(seen).toEqual(["a", "b"]);
  });

  it("skips stack records, and carries on past a goal whose merge step threw", async () => {
    const m = merger("a");
    const outcomes = await publishEarlierMergeGoals(m, [record("s", { mode: "stack" }), record("a"), record("b")], OPTIONS, "main");

    expect(m.goals.map((g) => g.goalId)).toEqual(["a", "b"]);
    expect(outcomes[0]).toMatchObject({ goalId: "a", merged: false, base: "main", error: "a listener threw" });
    expect(m.restoreBaseBranch).toHaveBeenCalledTimes(1);
    expect(outcomes[1].merged).toBe(true);
  });

  it("mergeGoalSafely reports a throw as the PR left open", async () => {
    const outcome = await mergeGoalSafely(merger("x"), { goalId: "x", goalDescription: "X", branch: "swarm/goal-x", verdicts: [] }, OPTIONS, "main");
    expect(outcome).toMatchObject({ merged: false, reason: "the merge step stopped unexpectedly; check the pull request by hand" });
  });

  it("announces what it publishes, and nothing when there is nothing", () => {
    expect(formatEarlierPublications([], "merge")).toEqual([]);
    const lines = formatEarlierPublications([record("a"), record("b", { pushed: true }), record("c", { pushed: true, pr_url: "https://x/pull/3" })], "merge");
    expect(lines[0]).toMatch(/^Publishing 3 goal\(s\) an earlier run finished/);
    expect(lines.slice(1)).toEqual([
      '  a "Goal a" on swarm/goal-a (not pushed)',
      '  b "Goal b" on swarm/goal-b (pushed, no PR)',
      '  c "Goal c" on swarm/goal-c (PR https://x/pull/3)',
    ]);
  });
});

describe("earlierMergeOptions", () => {
  const resolveConflict = async () => ({ resolved: true });
  it("keeps the conflict hand-back while the run goes on", () => {
    expect(earlierMergeOptions({ ...OPTIONS, resolveConflict }, { stopping: false }).resolveConflict).toBe(resolveConflict);
  });
  it("starts no worker once the run is stopping (a pause, a budget stop): a conflict is left open for the next run", () => {
    const o = earlierMergeOptions({ ...OPTIONS, resolveConflict }, { stopping: true });
    expect(o.resolveConflict).toBeUndefined();
    expect(o.gate).toEqual(OPTIONS.gate);
  });
});

describe("stackPushQueue", () => {
  it("puts the earlier run's goals first, in order, with their bases, then this run's", () => {
    const queue = stackPushQueue(
      [
        record("a", { mode: "stack", base: "main" }),
        record("m"),
        record("b", { mode: "stack", base: "swarm/goal-a", url: "https://tracker/b" }),
      ],
      [{ goalId: "c", goalDescription: "Goal c", base: "swarm/goal-b" }],
    );
    expect(queue).toEqual([
      { goalId: "a", goalDescription: "Goal a", base: "main" },
      { goalId: "b", goalDescription: "Goal b", goalUrl: "https://tracker/b", base: "swarm/goal-a" },
      { goalId: "c", goalDescription: "Goal c", base: "swarm/goal-b" },
    ]);
  });

  it("pushes a goal this run finished again once, as this run's", () => {
    const queue = stackPushQueue([record("a", { mode: "stack", base: "main" })], [{ goalId: "a", goalDescription: "Goal a, again", base: "main" }]);
    expect(queue).toEqual([{ goalId: "a", goalDescription: "Goal a, again", base: "main" }]);
  });
});
