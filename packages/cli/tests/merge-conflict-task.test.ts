import { describe, expect, it } from "vitest";
import { conflictTaskContext, conflictTaskDescription } from "../src/cli/merge-conflict-task.js";

const ctx = {
  goalId: "trello-abc",
  goalDescription: "Add the pets edit form",
  branch: "swarm/goal-trello-abc",
  base: "main",
  remote: "origin",
  files: ["app/PetsView.swift", "app/PetsModel.swift"],
  baseCommits: [{ sha: "a".repeat(40), subject: "feat(ios): add the pets remove flow" }],
};

describe("the conflict task", () => {
  it("names the branch, the base, every conflicted file and the base commits", () => {
    const d = conflictTaskDescription(ctx);
    expect(d).toContain("swarm/goal-trello-abc");
    expect(d).toContain("origin/main");
    for (const f of ctx.files) expect(d).toContain(f);
    expect(conflictTaskContext(ctx)).toContain("aaaaaaaaaaaa feat(ios): add the pets remove flow");
  });
  it("tells the worker to keep both sides and to finish the merge commit", () => {
    const d = conflictTaskDescription(ctx);
    expect(d).toContain("Keep everything both sides added");
    expect(d).toContain("Delete nothing to make it compile");
    expect(d).toContain("git commit --no-edit");
  });
  it("tells the worker to commit everything and stay on the branch, as swarm checks both", () => {
    const d = conflictTaskDescription(ctx);
    expect(d).toContain("Leave nothing uncommitted");
    expect(d).toContain(`Stay on ${ctx.branch}`);
  });
  it("tells the reviewer that a dropped behaviour is a rejection", () => {
    expect(conflictTaskDescription(ctx)).toContain("Reviewer: name anything either side had that this merge dropped");
  });
});
