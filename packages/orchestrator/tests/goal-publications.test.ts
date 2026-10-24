import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { GoalPublication, ProjectConfig, TaskBackend } from "@mnmal-ai/swarm-types";
import { Orchestrator } from "../src/orchestrator/index.js";
import {
  completedFromPublication,
  isPublicationPending,
  mergeableFromPublication,
  pendingPublications,
  resumeStackHead,
  trackGoalPublications,
} from "../src/source-control/publications.js";

/**
 * Goal publications: which finished goals swarm has pushed, opened a PR for
 * and merged, kept in the checkpoint so a later run finishes what an earlier
 * one could not, and repeats nothing.
 */

const ON = { autoPush: true, openPr: true };

function record(overrides: Partial<GoalPublication> & Pick<GoalPublication, "goal_id">): GoalPublication {
  return {
    description: `Goal ${overrides.goal_id}`,
    mode: "stack",
    branch: `swarm/goal-${overrides.goal_id}`,
    pushed: false,
    merged: false,
    ...overrides,
  };
}

describe("isPublicationPending", () => {
  it("stack: pending until the branch is pushed and its PR is open", () => {
    expect(isPublicationPending(record({ goal_id: "a" }), ON)).toBe(true);
    expect(isPublicationPending(record({ goal_id: "a", pushed: true }), ON)).toBe(true);
    expect(isPublicationPending(record({ goal_id: "a", pushed: true, pr_url: "https://x/pull/1" }), ON)).toBe(false);
  });

  it("stack: asks only for what the settings ask for", () => {
    expect(isPublicationPending(record({ goal_id: "a", pushed: true }), { autoPush: true, openPr: false })).toBe(false);
    expect(isPublicationPending(record({ goal_id: "a" }), { autoPush: false, openPr: false })).toBe(false);
  });

  it("merge: pending until merged, or until swarm leaves its PR open with a reason", () => {
    const merge = (o: Partial<GoalPublication>) => record({ goal_id: "m", mode: "merge", ...o });
    expect(isPublicationPending(merge({}), ON)).toBe(true);
    // A push that failed: no PR, so nothing was decided.
    expect(isPublicationPending(merge({ left_open_reason: "the branch could not be pushed" }), ON)).toBe(true);
    // A PR opened, then the run stopped before deciding.
    expect(isPublicationPending(merge({ pushed: true, pr_url: "https://x/pull/2" }), ON)).toBe(true);
    // Left open on purpose, or merged: done.
    expect(isPublicationPending(merge({ pushed: true, pr_url: "https://x/pull/2", left_open_reason: "the merge gate failed" }), ON)).toBe(false);
    expect(isPublicationPending(merge({ pushed: true, pr_url: "https://x/pull/2", merged: true }), ON)).toBe(false);
  });

  it("pendingPublications keeps one mode, in finishing order", () => {
    const records = [
      record({ goal_id: "a" }),
      record({ goal_id: "m", mode: "merge" }),
      record({ goal_id: "b", pushed: true, pr_url: "https://x/pull/1" }),
      record({ goal_id: "c" }),
    ];
    expect(pendingPublications(records, "stack", ON).map((r) => r.goal_id)).toEqual(["a", "c"]);
    expect(pendingPublications(records, "merge", ON).map((r) => r.goal_id)).toEqual(["m"]);
  });
});

describe("resumeStackHead", () => {
  const published = (id: string) => record({ goal_id: id, pushed: true, pr_url: `https://x/pull/${id}` });

  it("continues the stack while some of it is unpublished", () => {
    expect(resumeStackHead([published("a"), record({ goal_id: "b" })], { interrupted: false, settings: ON })).toBe("swarm/goal-b");
  });

  it("continues the stack when the last run stopped in the middle of a goal", () => {
    expect(resumeStackHead([published("a"), published("b")], { interrupted: true, settings: ON })).toBe("swarm/goal-b");
  });

  it("starts again from the base once the stack is published and the last run finished", () => {
    expect(resumeStackHead([published("a"), published("b")], { interrupted: false, settings: ON })).toBeNull();
    expect(resumeStackHead([record({ goal_id: "m", mode: "merge" })], { interrupted: true, settings: ON })).toBeNull();
    expect(resumeStackHead([], { interrupted: true, settings: ON })).toBeNull();
  });
});

describe("trackGoalPublications", () => {
  function store(records: GoalPublication[]) {
    return {
      records,
      getGoalPublications: () => records.map((r) => ({ ...r })),
      updateGoalPublication(goalId: string, patch: Partial<GoalPublication>) {
        const i = records.findIndex((r) => r.goal_id === goalId);
        if (i >= 0) records[i] = { ...records[i], ...patch };
      },
    };
  }

  it("records each step as source control reports it", () => {
    const bus = new SwarmEventBus();
    const s = store([record({ goal_id: "a" }), record({ goal_id: "m", mode: "merge" }), record({ goal_id: "n", mode: "merge" })]);
    const detach = trackGoalPublications(bus, s);

    bus.emit("source_control:branch_pushed", { branch: "swarm/goal-a", remote: "origin", timestamp: 0 });
    bus.emit("source_control:pr_created", { goalId: "a", branch: "swarm/goal-a", prUrl: "https://x/pull/1", timestamp: 0 });
    bus.emit("source_control:pr_merged", { goalId: "m", branch: "swarm/goal-m", prUrl: "https://x/pull/2", mergeCommit: "abc", base: "main", timestamp: 0 });
    // A skip with no PR (the push failed) decides nothing.
    bus.emit("source_control:merge_skipped", { goalId: "n", branch: "swarm/goal-n", reason: "the branch could not be pushed", timestamp: 0 });

    expect(s.records[0]).toMatchObject({ pushed: true, pr_url: "https://x/pull/1" });
    expect(s.records[1]).toMatchObject({ merged: true, pr_url: "https://x/pull/2" });
    expect(s.records[2]).not.toHaveProperty("left_open_reason");

    bus.emit("source_control:merge_skipped", { goalId: "n", branch: "swarm/goal-n", prUrl: "https://x/pull/3", reason: "the merge gate failed", timestamp: 0 });
    expect(s.records[2]).toMatchObject({ pr_url: "https://x/pull/3", left_open_reason: "the merge gate failed" });

    detach();
    bus.emit("source_control:pr_created", { goalId: "a", branch: "swarm/goal-a", prUrl: "https://x/pull/9", timestamp: 0 });
    expect(s.records[0].pr_url).toBe("https://x/pull/1");
  });
});

describe("records as goals", () => {
  const groups = [{ task: "Build it", items: ["Check it on a phone"] }];

  it("a merge record keeps its verdicts, labels and items for mergeGoal", () => {
    expect(mergeableFromPublication(record({
      goal_id: "m", mode: "merge", url: "https://tracker/1", verdicts: ["approved"], labels: ["ui"], left_for_person: groups,
    }))).toEqual({
      goalId: "m", goalDescription: "Goal m", goalUrl: "https://tracker/1", branch: "swarm/goal-m",
      verdicts: ["approved"], labels: ["ui"], leftForPerson: groups,
    });
    // Without verdicts it is never eligible: its PR opens, and stays open.
    expect(mergeableFromPublication(record({ goal_id: "m", mode: "merge" })).verdicts).toEqual(["no verdict recorded"]);
  });

  it("a merge record left open hands its pull request and reason to the retry", () => {
    expect(mergeableFromPublication(record({
      goal_id: "m", mode: "merge", verdicts: ["approved"], pr_url: "https://github.com/o/r/pull/4", left_open_reason: "the branch conflicts with main",
    }))).toMatchObject({ prUrl: "https://github.com/o/r/pull/4", lastLeftOpenReason: "the branch conflicts with main" });
  });

  it("a stack record keeps its base and items for the stacked push", () => {
    expect(completedFromPublication(record({ goal_id: "b", base: "swarm/goal-a", left_for_person: groups }))).toEqual({
      goalId: "b", goalDescription: "Goal b", base: "swarm/goal-a", leftForPerson: groups,
    });
  });
});

describe("Orchestrator keeps the records in the checkpoint", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = { project: "test-project", swarm_path: "/tmp/swarm", trust_level: "medium", concurrency: { max_workers: 1 }, task_backend: "local", created: "2026-01-01T00:00:00Z" } as unknown as ProjectConfig;
  const backend = { getGoals: vi.fn(), createGoal: vi.fn(), getTasks: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), addComment: vi.fn(), escalate: vi.fn() } as unknown as TaskBackend;
  const base = { session_id: "s", swarm_version: "HEAD", project: "test-project", current_goal: null, current_task: null, completed_tasks: [], pending_tasks: [], skipped_tasks: [], blocked: false };

  it("writes them with every save, reads them back, and forgets them on a fresh start", async () => {
    dir = mkdtempSync(join(tmpdir(), "swarm-publications-"));
    const first = new Orchestrator({ projectConfig: config, backend, checkpointPath: dir });
    first.recordGoalPublication(record({ goal_id: "a" }));
    first.recordGoalPublication(record({ goal_id: "b" }));
    first.updateGoalPublication("a", { pushed: true, pr_url: "https://x/pull/1" });
    // A goal finished again replaces its record, at the end.
    first.recordGoalPublication(record({ goal_id: "a", branch: "swarm/goal-a-again" }));
    await first.saveCheckpoint(base);

    const second = new Orchestrator({ projectConfig: config, backend, checkpointPath: dir });
    expect(second.getGoalPublications()).toEqual([]);
    const checkpoint = await second.loadCheckpoint();
    expect(checkpoint?.goal_publications?.map((r) => r.goal_id)).toEqual(["b", "a"]);
    expect(second.getGoalPublications().map((r) => [r.goal_id, r.branch, r.pushed])).toEqual([
      ["b", "swarm/goal-b", false],
      ["a", "swarm/goal-a-again", false],
    ]);

    // A save that knows nothing about publications still keeps them.
    second.updateGoalPublication("b", { pushed: true });
    await second.saveCheckpoint({ ...base, current_goal: "c" });
    const third = new Orchestrator({ projectConfig: config, backend, checkpointPath: dir });
    await third.loadCheckpoint();
    expect(third.getGoalPublications().find((r) => r.goal_id === "b")?.pushed).toBe(true);

    await third.clearCheckpoint();
    expect(third.getGoalPublications()).toEqual([]);
  });

  it("writes no field when there is nothing to record, so older checkpoints read the same", async () => {
    dir = mkdtempSync(join(tmpdir(), "swarm-publications-"));
    const o = new Orchestrator({ projectConfig: config, backend, checkpointPath: dir });
    await o.saveCheckpoint(base);
    expect(await o.loadCheckpoint()).not.toHaveProperty("goal_publications");
  });
});

describe("leftForPersonSection", () => {
  it("lists items in the PR body, safely: no mentions, no markup, no runaway length", async () => {
    const { leftForPersonSection } = await import("../src/source-control/index.js");
    const body = leftForPersonSection([
      { task: "Build  the\nsettings screen", items: ["Ask @octocat to check it <script>alert(1)</script>", "**bold** [link](x)", "y".repeat(600)] },
    ]);
    expect(body).toContain("## Left for a person");
    expect(body).toContain("**Build the settings screen**");
    expect(body).toContain("- Ask @​octocat to check it &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("- \\*\\*bold\\*\\* \\[link\\](x)");
    expect(body).toContain(`- ${"y".repeat(499)}…`);
    expect(leftForPersonSection([])).toBe("");
    expect(leftForPersonSection([{ task: "T", items: [] }])).toBe("");
  });
});
describe("left-open kinds", () => {
  const settings = { autoPush: true, openPr: true };
  const left = (kind?: GoalPublication["left_open_kind"]) =>
    record({ goal_id: "g", mode: "merge", branch: "b", pushed: true, merged: false, pr_url: "https://github.com/o/r/pull/1", left_open_reason: "why", ...(kind ? { left_open_kind: kind } : {}) });

  it("retries conflict, base_kept_moving and refused", () => {
    for (const k of ["conflict", "base_kept_moving", "refused"] as const) expect(isPublicationPending(left(k), settings)).toBe(true);
  });
  it("keeps gate_failed, ineligible, closed, head_changed and kind-less records finished", () => {
    for (const k of ["gate_failed", "ineligible", "closed", "head_changed", undefined] as const) expect(isPublicationPending(left(k), settings)).toBe(false);
  });
  it("stops retrying on its own after three attempts in all", () => {
    expect(isPublicationPending({ ...left("conflict"), merge_attempts: 2 }, settings)).toBe(true);
    expect(isPublicationPending({ ...left("conflict"), merge_attempts: 3 }, settings)).toBe(false);
    expect(isPublicationPending({ ...left("refused"), merge_attempts: 5 }, settings)).toBe(false);
  });
  it("counts every attempt that left the pull request open", () => {
    const bus = new SwarmEventBus();
    const store = { recs: [left()], getGoalPublications() { return this.recs; }, updateGoalPublication(id: string, patch: Partial<GoalPublication>) { this.recs = this.recs.map((r) => (r.goal_id === id ? { ...r, ...patch } : r)); } };
    trackGoalPublications(bus, store);
    const skipped = { goalId: "g", branch: "b", prUrl: "https://github.com/o/r/pull/1", reason: "x", kind: "conflict" as const, timestamp: 1 };
    bus.emit("source_control:merge_skipped", skipped);
    bus.emit("source_control:merge_skipped", skipped);
    expect(store.recs[0].merge_attempts).toBe(2);
  });
  it("records the kind from merge_skipped", () => {
    const bus = new SwarmEventBus();
    const store = { recs: [left()], getGoalPublications() { return this.recs; }, updateGoalPublication(id: string, patch: Partial<GoalPublication>) { this.recs = this.recs.map((r) => (r.goal_id === id ? { ...r, ...patch } : r)); } };
    trackGoalPublications(bus, store);
    bus.emit("source_control:merge_skipped", { goalId: "g", branch: "b", prUrl: "https://github.com/o/r/pull/1", reason: "x", kind: "conflict", timestamp: 1 });
    expect(store.recs[0].left_open_kind).toBe("conflict");
  });
});
