import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GoalPublication } from "@mnmal-ai/swarm-types";
import { CheckpointPublicationFile, selectMergeRetries } from "../src/cli/merge-command.js";

const rec = (goal: string, extra: Partial<GoalPublication>): GoalPublication => ({
  goal_id: goal, description: goal, mode: "merge", branch: `b-${goal}`, pushed: true, merged: false,
  pr_url: `https://github.com/o/r/pull/${goal.length}`, left_open_reason: "why", ...extra,
});

describe("selectMergeRetries", () => {
  const records = [
    rec("conflict", { left_open_kind: "conflict" }),
    rec("gate", { left_open_kind: "gate_failed" }),
    rec("ineligible", { left_open_kind: "ineligible" }),
    rec("merged", { merged: true }),
    { ...rec("stack", {}), mode: "stack" as const },
  ];
  it("takes the retryable kinds by default", () => {
    expect(selectMergeRetries(records, {}).map((r) => r.goal_id)).toEqual(["conflict"]);
  });
  it("adds gate failures with --all, never ineligible or merged", () => {
    expect(selectMergeRetries(records, { all: true }).map((r) => r.goal_id)).toEqual(["conflict", "gate"]);
  });
  it("takes exactly one pull request with --pr, whatever its kind, except merged", () => {
    expect(selectMergeRetries(records, { pr: "https://github.com/o/r/pull/4" }).map((r) => r.goal_id)).toEqual(["gate"]);
    expect(selectMergeRetries(records, { pr: "https://github.com/o/r/pull/6" })).toEqual([]);
  });
});

describe("CheckpointPublicationFile", () => {
  it("updates goal_publications in checkpoint.json and keeps everything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-merge-cmd-"));
    try {
      const path = join(dir, "checkpoint.json");
      writeFileSync(path, JSON.stringify({ session_id: "s", goal_publications: [rec("conflict", { left_open_kind: "conflict" })] }));
      const store = await CheckpointPublicationFile.open(path);
      store.updateGoalPublication("conflict", { merged: true });
      await store.save();
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.session_id).toBe("s");
      expect(saved.goal_publications[0].merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
