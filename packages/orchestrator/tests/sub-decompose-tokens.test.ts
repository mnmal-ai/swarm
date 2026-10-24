/**
 * subDecompose is an LLM call of its own, so it reports the tokens it spent
 * and the run counts them toward the session, goal and task budgets.
 */

import { describe, it, expect } from "vitest";
import { subDecompose } from "../src/complexity/index.js";
import type { Goal, Task } from "@mnmal-ai/swarm-types";

const goal = { id: "goal-1", description: "Add the sample widget" } as Goal;
const task = { id: "goal-1-task-1", goal_id: "goal-1", description: "Build the widget", intent: "implementation", status: "pending" } as Task;
const TOKENS = { input: 9_000, output: 400, cacheRead: 8_000, cacheWrite: 500 };

function swarmReturning(output: string) {
  return { run: async () => ({ output, tokensUsed: { context: 100, ...TOKENS } }) };
}

describe("subDecompose reports the tokens its call spent", () => {
  it("on a successful split", async () => {
    const result = await subDecompose(
      swarmReturning('[{"title":"A","description":"first half","intent":"implementation"},{"title":"B","description":"second half","intent":"implementation"}]'),
      task, goal, "sample-project",
    );

    expect(result.subTasks).toHaveLength(2);
    expect(result.tokensUsed).toMatchObject(TOKENS);
  });

  it("when the output cannot be parsed, since the call still used them", async () => {
    const result = await subDecompose(swarmReturning("no json here"), task, goal, "sample-project");

    expect(result.subTasks).toHaveLength(0);
    expect(result.tokensUsed).toMatchObject(TOKENS);
  });

  it("reports none for a subtask it refuses to split, which makes no call", async () => {
    const result = await subDecompose(swarmReturning("[]"), { ...task, parentTaskId: "goal-1-task-0" }, goal, "sample-project");

    expect(result.tokensUsed).toBeUndefined();
  });
});
