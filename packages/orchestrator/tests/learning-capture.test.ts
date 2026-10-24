import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { captureRunObservation, formatObservationMd, extractPatterns, extractFailures } from "../src/learning/capture.js";
import type { CaptureInput } from "../src/learning/capture.js";
import type { TaskOutcomeSummary } from "@mnmal-ai/swarm-types";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskOutcomeSummary> = {}): TaskOutcomeSummary {
  return {
    taskId: "goal-1-task-1",
    goalId: "goal-1",
    intent: "implementation",
    description: "Build the model",
    verdict: "approved",
    inputTokens: 1_500_000,
    latencyMs: 30000,
    retryCount: 0,
    arbiterInvolved: false,
    humanEscalation: false,
    rejectionReasons: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: "run-test-abc123",
    project: "todo-app",
    swarmVersion: "v0.12.0",
    workerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-sonnet-4-6",
    startTime: Date.parse("2026-03-22T14:00:00Z"),
    endTime: Date.parse("2026-03-22T14:30:00Z"),
    goals: [
      { id: "goal-1", description: "Build the model", status: "completed" },
      { id: "goal-2", description: "Build the list view", status: "failed", designs: ["designs/list-view.png"] },
    ],
    taskOutcomes: [
      makeTask({ taskId: "goal-1-task-1", goalId: "goal-1", verdict: "approved" }),
      makeTask({
        taskId: "goal-2-task-1",
        goalId: "goal-2",
        verdict: "approved",
        retryCount: 2,
        rejectionReasons: ["Missing @MainActor on store", "Still missing @MainActor"],
        inputTokens: 3_200_000,
      }),
    ],
    filesChanged: ["TodoTest/Models/TodoItem.swift", "TodoTest/Models/TodoStore.swift", "TodoTest/ContentView.swift"],
    mergeConflicts: ["TodoTest.xcodeproj/project.pbxproj"],
    totalTokens: 4_700_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// captureRunObservation — end-to-end file writes
// ---------------------------------------------------------------------------

describe("captureRunObservation", () => {
  let tempSwarm: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    tempSwarm = await mkdtemp(join(tmpdir(), "swarm-learn-test-"));
    tempDirs.push(tempSwarm);
  });

  afterAll(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("creates learned/runs/<runId>.md with frontmatter and sections", async () => {
    const input = makeInput();
    captureRunObservation(tempSwarm, input);

    const runFile = join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md");
    expect(existsSync(runFile)).toBe(true);

    const content = await readFile(runFile, "utf-8");
    expect(content).toContain('run_id: "run-test-abc123"');
    expect(content).toContain('project: "todo-app"');
    expect(content).toContain('worker_model: "claude-sonnet-4-6"');
    expect(content).toContain("## Files Changed");
    expect(content).toContain("TodoTest/Models/TodoItem.swift");
    expect(content).toContain("## Reviewer Feedback");
    expect(content).toContain("Missing @MainActor");
    expect(content).toContain("## Merge Conflicts");
    expect(content).toContain("project.pbxproj");
    expect(content).toContain("paused: false");
  });

  it("appends to patterns.jsonl", async () => {
    const input = makeInput();
    captureRunObservation(tempSwarm, input);

    const patternsFile = join(tempSwarm, "domains", "todo-app", "learned", "patterns.jsonl");
    expect(existsSync(patternsFile)).toBe(true);

    const content = await readFile(patternsFile, "utf-8");
    const lines = content.trim().split("\n").map(l => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);

    const contention = lines.find((l: { type: string }) => l.type === "file_contention");
    expect(contention).toBeDefined();
    expect(contention.observation).toContain("project.pbxproj");
  });

  it("appends to failures.jsonl", async () => {
    const input = makeInput();
    captureRunObservation(tempSwarm, input);

    const failuresFile = join(tempSwarm, "domains", "todo-app", "learned", "failures.jsonl");
    expect(existsSync(failuresFile)).toBe(true);

    const content = await readFile(failuresFile, "utf-8");
    const lines = content.trim().split("\n").map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].reason).toBe("Missing @MainActor on store");
    expect(lines[1].reason).toBe("Still missing @MainActor");
    expect(lines[1].eventually_resolved).toBe(true);
  });

  it("accumulates across multiple runs (append, not overwrite)", async () => {
    const input1 = makeInput({ runId: "run-first" });
    const input2 = makeInput({ runId: "run-second" });

    captureRunObservation(tempSwarm, input1);
    captureRunObservation(tempSwarm, input2);

    const runsDir = join(tempSwarm, "domains", "todo-app", "learned", "runs");
    const runFiles = await readdir(runsDir);
    expect(runFiles).toContain("run-first.md");
    expect(runFiles).toContain("run-second.md");

    const patternsContent = await readFile(join(tempSwarm, "domains", "todo-app", "learned", "patterns.jsonl"), "utf-8");
    const patternLines = patternsContent.trim().split("\n");
    const runIds = patternLines.map(l => JSON.parse(l).run_id);
    expect(runIds).toContain("run-first");
    expect(runIds).toContain("run-second");
  });

  it("handles run with no failures gracefully", async () => {
    const input = makeInput({
      taskOutcomes: [makeTask({ rejectionReasons: [] })],
      mergeConflicts: [],
    });

    captureRunObservation(tempSwarm, input);

    const learnedDir = join(tempSwarm, "domains", "todo-app", "learned");
    expect(existsSync(join(learnedDir, "runs", "run-test-abc123.md"))).toBe(true);
    expect(existsSync(join(learnedDir, "failures.jsonl"))).toBe(false);
  });

  it("marks paused runs with indicator in observation", async () => {
    const input = makeInput({ paused: true });
    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("paused: true");
    expect(content).toContain("This run was paused");
  });

  // -------------------------------------------------------------------------
  // Regression — the run .md must always be written. Previously a
  // malformed project name threw in the path guard and the caller swallowed
  // the throw, so the goal-6d run summary was silently lost (run-id 3dcd7f).
  // -------------------------------------------------------------------------

  it("writes the run .md for a clean successful session (bug-4 regression)", async () => {
    const input = makeInput({
      runId: "run-3dcd7f",
      taskOutcomes: [makeTask({ verdict: "approved", rejectionReasons: [] })],
      goals: [{ id: "goal-1", description: "Build", status: "completed" }],
      mergeConflicts: [],
    });

    captureRunObservation(tempSwarm, input);

    const runFile = join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-3dcd7f.md");
    expect(existsSync(runFile)).toBe(true);
    const content = await readFile(runFile, "utf-8");
    expect(content).toContain('run_id: "run-3dcd7f"');
    expect(content).toContain("## Ship Readiness");
  });

  it("still writes the md under a sanitized slug when the project name is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A path-traversal-flavoured name that the old guard would have thrown on.
      const input = makeInput({ project: "../evil/project" });
      captureRunObservation(tempSwarm, input);

      // Sanitized to a safe slug — no traversal escapes the domains directory.
      const runFile = join(tempSwarm, "domains", "evil-project", "learned", "runs", "run-test-abc123.md");
      expect(existsSync(runFile)).toBe(true);

      const content = await readFile(runFile, "utf-8");
      // goal-6d sections survive the malformed-name fallback.
      expect(content).toContain("## Ship Readiness");
      expect(content).toContain("## Suggestions Deferred");
      expect(content).toContain("## Post-run Human PRs");

      // The mismatch is surfaced, not silently swallowed.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a"));
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to a default slug when the project name has no safe characters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = makeInput({ project: "///..." });
      captureRunObservation(tempSwarm, input);

      const runFile = join(tempSwarm, "domains", "unknown-project", "learned", "runs", "run-test-abc123.md");
      expect(existsSync(runFile)).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("surfaces a formatting throw as a warning and still writes a fallback md", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A malformed shipReadiness shape (goals: null) makes formatObservationMd
      // throw while building the Ship Readiness section. The throw must surface
      // as a warning and the write must still happen via the fallback.
      const input = makeInput({
        shipReadiness: { contractLoaded: true, goals: null as unknown as [] },
      });
      captureRunObservation(tempSwarm, input);

      const runFile = join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md");
      expect(existsSync(runFile)).toBe(true);
      const content = await readFile(runFile, "utf-8");
      expect(content).toContain('run_id: "run-test-abc123"');
      expect(content).toContain("minimal fallback");

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to format run summary"));
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// formatObservationMd
// ---------------------------------------------------------------------------

describe("formatObservationMd", () => {
  it("includes frontmatter with all fields", () => {
    const obs = {
      runId: "run-test-abc123",
      date: "2026-03-22",
      swarmVersion: "v0.12.0",
      project: "todo-app",
      workerModel: "claude-sonnet-4-6",
      reviewerModel: "claude-sonnet-4-6",
      goalsAttempted: ["goal-1", "goal-2"],
      goalsCompleted: ["goal-1"],
      goalsFailed: ["goal-2"],
      totalTasks: 2,
      tasksApproved: 2,
      tasksRejected: 0,
      totalRetries: 2,
      arbiterInvocations: 0,
      humanEscalations: 0,
      totalTokens: 4_700_000,
      durationMs: 1800000,
      filesChanged: ["TodoItem.swift"],
      mergeConflicts: [],
      taskOutcomes: [makeTask()],
      goalOutcomes: [
        { goalId: "goal-1", description: "Build", status: "completed" as const, tasksAttempted: 1, tasksCompleted: 1, designsReferenced: [] },
      ],
      paused: false,
    };

    const md = formatObservationMd(obs);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('run_id: "run-test-abc123"');
    expect(md).toContain("total_tokens: 4700000");
    expect(md).toContain("paused: false");
    expect(md).toContain("## Files Changed");
    expect(md).toContain("## Goal Summary");
    expect(md).toContain("## Task Details");
    // Should NOT contain old sections
    expect(md).not.toContain("## Files Created");
    expect(md).not.toContain("## Files Modified");
  });

  it("includes design references when present", () => {
    const obs = {
      runId: "run-test",
      date: "2026-03-22",
      swarmVersion: "v0.12.0",
      project: "todo-app",
      workerModel: "claude-sonnet-4-6",
      reviewerModel: "claude-sonnet-4-6",
      goalsAttempted: ["goal-2"],
      goalsCompleted: [],
      goalsFailed: ["goal-2"],
      totalTasks: 1,
      tasksApproved: 0,
      tasksRejected: 1,
      totalRetries: 0,
      arbiterInvocations: 0,
      humanEscalations: 0,
      inputTokens: 2_000_000,
      durationMs: 60000,
      filesChanged: [],
      mergeConflicts: [],
      taskOutcomes: [],
      goalOutcomes: [
        { goalId: "goal-2", description: "List view", status: "failed" as const, tasksAttempted: 1, tasksCompleted: 0, designsReferenced: ["designs/list-view.png"] },
      ],
      paused: false,
    };

    const md = formatObservationMd(obs);
    expect(md).toContain("## Design References Used");
    expect(md).toContain("designs/list-view.png");
  });

  // -------------------------------------------------------------------------
  // Honest run summary sections (plan Phase 6.5)
  // -------------------------------------------------------------------------

  function baseObs() {
    return {
      runId: "run-test",
      date: "2026-03-22",
      swarmVersion: "v0.12.0",
      project: "todo-app",
      workerModel: "claude-sonnet-4-6",
      reviewerModel: "claude-sonnet-4-6",
      goalsAttempted: ["goal-1"],
      goalsCompleted: ["goal-1"],
      goalsFailed: [],
      totalTasks: 1,
      tasksApproved: 1,
      tasksRejected: 0,
      totalRetries: 0,
      arbiterInvocations: 0,
      humanEscalations: 0,
      inputTokens: 1_000_000,
      durationMs: 60000,
      filesChanged: [],
      mergeConflicts: [],
      taskOutcomes: [makeTask()],
      goalOutcomes: [
        { goalId: "goal-1", description: "Build", status: "completed" as const, tasksAttempted: 1, tasksCompleted: 1, designsReferenced: [] },
      ],
      paused: false,
    };
  }

  it("renders no-contract ship-readiness line when contract absent", () => {
    const md = formatObservationMd(baseObs());
    expect(md).toContain("## Ship Readiness");
    expect(md).toContain("No ship-readiness contract — gate did not run.");
  });

  it("renders ship-readiness goals with status and detail when contract loaded", () => {
    const md = formatObservationMd({
      ...baseObs(),
      shipReadiness: {
        contractLoaded: true,
        goals: [
          { goalId: "goal-1", applied: true, status: "passed" as const, detail: "all checks green" },
          { goalId: "goal-2", applied: false, status: "skipped" as const },
        ],
      },
    });
    expect(md).toContain("## Ship Readiness");
    expect(md).toContain("- goal-1: passed — all checks green");
    expect(md).toContain("- goal-2: skipped");
    expect(md).not.toContain("gate did not run");
  });

  it("renders 'None.' for suggestions-deferred when list is empty", () => {
    const md = formatObservationMd(baseObs());
    expect(md).toContain("## Suggestions Deferred");
    expect(md).toMatch(/## Suggestions Deferred\nNone\./);
  });

  it("renders one bullet per deferred suggestion with axis and reason", () => {
    const md = formatObservationMd({
      ...baseObs(),
      suggestionsDeferred: [
        { catalogEntryId: "c1", axis: "testing", reason: "out of scope", offeredAt: "2026-03-22T14:00:00Z" },
        { catalogEntryId: "c2", axis: "perf", offeredAt: "2026-03-22T14:05:00Z" },
      ],
    });
    expect(md).toContain("- testing: out of scope");
    expect(md).toContain("- perf");
  });

  it("renders post-run-human-PRs placeholder when not backfilled", () => {
    const md = formatObservationMd(baseObs());
    expect(md).toContain("## Post-run Human PRs");
    expect(md).toContain("_None yet — back-filled by `swarm learn-from-pr`._");
  });

  it("renders categorized human PRs when backfilled", () => {
    const md = formatObservationMd({
      ...baseObs(),
      postRunHumanPrs: {
        backfilled: true,
        categorizations: [{ prNumber: 42, category: "bugfix", confidence: 80 }],
      },
    });
    expect(md).toContain("- PR #42: bugfix (confidence 80)");
    expect(md).not.toContain("None yet");
  });

  it("does not show retry suffix on rejection reasons", () => {
    const obs = {
      runId: "run-test",
      date: "2026-03-22",
      swarmVersion: "v0.12.0",
      project: "todo-app",
      workerModel: "claude-sonnet-4-6",
      reviewerModel: "claude-sonnet-4-6",
      goalsAttempted: ["goal-1"],
      goalsCompleted: ["goal-1"],
      goalsFailed: [],
      totalTasks: 1,
      tasksApproved: 1,
      tasksRejected: 0,
      totalRetries: 1,
      arbiterInvocations: 0,
      humanEscalations: 0,
      inputTokens: 2_000_000,
      durationMs: 60000,
      filesChanged: [],
      mergeConflicts: [],
      taskOutcomes: [
        makeTask({
          retryCount: 1,
          rejectionReasons: ["bad code"],
          verdict: "approved",
        }),
      ],
      goalOutcomes: [
        { goalId: "goal-1", description: "Build", status: "completed" as const, tasksAttempted: 1, tasksCompleted: 1, designsReferenced: [] },
      ],
      paused: false,
    };

    const md = formatObservationMd(obs);
    // Should NOT contain misleading "(retry 1)" suffix
    expect(md).not.toContain("(retry 1)");
    expect(md).toContain('rejected — "bad code"');
    expect(md).toContain("(final): approved");
  });
});

// ---------------------------------------------------------------------------
// extractPatterns
// ---------------------------------------------------------------------------

describe("extractPatterns", () => {
  it("extracts file contention patterns from merge conflicts", () => {
    const input = makeInput({ mergeConflicts: ["file-a.swift", "file-b.swift"] });
    const patterns = extractPatterns(input);

    const contentionPatterns = patterns.filter(p => p.type === "file_contention");
    expect(contentionPatterns).toHaveLength(2);
    expect(contentionPatterns[0].files).toEqual(["file-a.swift"]);
    expect(contentionPatterns[0].source).toBe("worktree_merge");
  });

  it("extracts reviewer patterns when same reason appears 2+ times", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({ taskId: "t1", rejectionReasons: ["missing tests"] }),
        makeTask({ taskId: "t2", rejectionReasons: ["missing tests"] }),
      ],
    });
    const patterns = extractPatterns(input);

    const reviewerPatterns = patterns.filter(p => p.type === "reviewer_pattern");
    expect(reviewerPatterns).toHaveLength(1);
    expect(reviewerPatterns[0].observation).toContain("missing tests");
    expect(reviewerPatterns[0].observation).toContain("2 times");
  });

  it("extracts reviewer pattern from single task with 2+ rejection reasons matching", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({ taskId: "t1", rejectionReasons: ["missing tests", "missing tests"] }),
      ],
    });
    const patterns = extractPatterns(input);

    const reviewerPatterns = patterns.filter(p => p.type === "reviewer_pattern");
    expect(reviewerPatterns).toHaveLength(1);
  });

  it("does not extract reviewer pattern for single occurrence", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({ rejectionReasons: ["unique issue"] }),
      ],
    });
    const patterns = extractPatterns(input);

    const reviewerPatterns = patterns.filter(p => p.type === "reviewer_pattern");
    expect(reviewerPatterns).toHaveLength(0);
  });

  it("extracts token patterns for goals 2x above average", () => {
    const input = makeInput({
      goals: [
        { id: "goal-1", description: "Light", status: "completed" },
        { id: "goal-2", description: "Light too", status: "completed" },
        { id: "goal-3", description: "Heavy", status: "completed" },
      ],
      taskOutcomes: [
        makeTask({ taskId: "g1-t1", goalId: "goal-1", inputTokens: 500_000 }),
        makeTask({ taskId: "g2-t1", goalId: "goal-2", inputTokens: 500_000 }),
        makeTask({ taskId: "g3-t1", goalId: "goal-3", inputTokens: 10_000_000 }),
      ],
      totalTokens: 11_000_000,
    });
    const patterns = extractPatterns(input);

    const tokenPatterns = patterns.filter(p => p.type === "token_pattern");
    expect(tokenPatterns).toHaveLength(1);
    expect(tokenPatterns[0].observation).toContain("goal-3");
    expect(tokenPatterns[0].observation).toContain("10M tokens");
  });

  it("returns empty array for clean run", () => {
    const input = makeInput({
      mergeConflicts: [],
      taskOutcomes: [makeTask()],
    });
    const patterns = extractPatterns(input);
    expect(patterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractFailures
// ---------------------------------------------------------------------------

describe("extractFailures", () => {
  it("creates one failure entry per rejection reason", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({
          taskId: "t1",
          goalId: "g1",
          rejectionReasons: ["reason A", "reason B"],
          retryCount: 2,
          verdict: "approved",
        }),
      ],
    });
    const failures = extractFailures(input);

    expect(failures).toHaveLength(2);
    expect(failures[0].reason).toBe("reason A");
    expect(failures[0].retry_number).toBe(1);
    expect(failures[0].eventually_resolved).toBe(false);
    expect(failures[1].reason).toBe("reason B");
    expect(failures[1].retry_number).toBe(2);
    expect(failures[1].eventually_resolved).toBe(true);
  });

  it("marks last failure as resolved when verdict is approved", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({
          rejectionReasons: ["one issue"],
          verdict: "approved",
        }),
      ],
    });
    const failures = extractFailures(input);

    expect(failures).toHaveLength(1);
    expect(failures[0].eventually_resolved).toBe(true);
    expect(failures[0].resolution).toBe("Approved after retry");
  });

  it("marks last failure as unresolved when verdict is not approved", () => {
    const input = makeInput({
      taskOutcomes: [
        makeTask({
          rejectionReasons: ["fatal issue"],
          verdict: "rejected",
        }),
      ],
    });
    const failures = extractFailures(input);

    expect(failures).toHaveLength(1);
    expect(failures[0].eventually_resolved).toBe(false);
    expect(failures[0].resolution).toBeUndefined();
  });

  it("returns empty array when no tasks have rejections", () => {
    const input = makeInput({
      taskOutcomes: [makeTask({ rejectionReasons: [] })],
    });
    const failures = extractFailures(input);
    expect(failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tasksRejected count accuracy
// ---------------------------------------------------------------------------

describe("buildObservation — tasksRejected accuracy", () => {
  it("does not count tasks rejected-then-approved in tasksRejected", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-rejected-count-"));
    const input = makeInput({
      goals: [{ id: "g1", description: "Test goal", status: "partial" }],
      taskOutcomes: [
        makeTask({ taskId: "t1", goalId: "g1", verdict: "approved", rejectionReasons: ["issue A"] }),
        makeTask({ taskId: "t2", goalId: "g1", verdict: "approved", rejectionReasons: [] }),
        makeTask({ taskId: "t3", goalId: "g1", verdict: "rejected", rejectionReasons: ["fatal"] }),
      ],
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    // tasksApproved=2 (t1 and t2), tasksRejected=1 (only t3, not t1 which was rejected-then-approved)
    expect(content).toContain("tasks_approved: 2");
    expect(content).toContain("tasks_rejected: 1");
  });
});

// ---------------------------------------------------------------------------
// taskExecutionCounts — Substrate-sourced axis vs taskOutcomes fallback (goal-9)
// ---------------------------------------------------------------------------

describe("buildObservation — taskExecutionCounts axis source", () => {
  it("sources the task axis from taskExecutionCounts when present", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-tec-present-"));
    // taskOutcomes would derive total=2, approved=2, rejected=0. The Substrate
    // counts deliberately diverge so the test proves the counts win.
    const input = makeInput({
      taskExecutionCounts: { total: 5, completed: 3, failed: 1, blocked: 1, running: 0 },
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("total_tasks: 5");
    expect(content).toContain("tasks_approved: 3");
    expect(content).toContain("tasks_rejected: 1");
  });

  it("falls back to taskOutcomes-derived axis when counts absent", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-tec-absent-"));
    // No taskExecutionCounts → existing behavior: total=2, approved=2, rejected=0.
    const input = makeInput();

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("total_tasks: 2");
    expect(content).toContain("tasks_approved: 2");
    expect(content).toContain("tasks_rejected: 0");
  });
});

// ---------------------------------------------------------------------------
// Goal status — partial vs completed
// ---------------------------------------------------------------------------

describe("goal status derivation", () => {
  it("marks goal as partial when some tasks approved", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-goal-status-"));
    const input = makeInput({
      goals: [{ id: "goal-1", description: "Build", status: "partial" }],
      taskOutcomes: [
        makeTask({ taskId: "g1-t1", goalId: "goal-1", verdict: "approved" }),
        makeTask({ taskId: "g1-t2", goalId: "goal-1", verdict: "rejected", rejectionReasons: ["failed"] }),
      ],
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    // Goal outcomes should show partial (1/2 tasks)
    expect(content).toContain("goal-1: partial (1/2 tasks)");
  });

  it("marks goal as completed when all tasks approved", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-goal-complete-"));
    const input = makeInput({
      goals: [{ id: "goal-1", description: "Build", status: "completed" }],
      taskOutcomes: [
        makeTask({ taskId: "g1-t1", goalId: "goal-1", verdict: "approved" }),
        makeTask({ taskId: "g1-t2", goalId: "goal-1", verdict: "approved" }),
      ],
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("goal-1: completed (2/2 tasks)");
  });

  it("counts skipped verdict as completed", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-goal-skipped-"));
    const input = makeInput({
      goals: [{ id: "goal-1", description: "Build", status: "completed" }],
      taskOutcomes: [
        makeTask({ taskId: "g1-t1", goalId: "goal-1", verdict: "approved" }),
        makeTask({ taskId: "g1-t2", goalId: "goal-1", verdict: "skipped" }),
      ],
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("tasks_approved: 2");
    expect(content).toContain("goal-1: completed (2/2 tasks)");
  });

  it("marks goal as failed when no tasks approved", async () => {
    const tempSwarm = await mkdtemp(join(tmpdir(), "swarm-goal-failed-"));
    const input = makeInput({
      goals: [{ id: "goal-1", description: "Build", status: "failed" }],
      taskOutcomes: [
        makeTask({ taskId: "g1-t1", goalId: "goal-1", verdict: "rejected", rejectionReasons: ["bad"] }),
      ],
    });

    captureRunObservation(tempSwarm, input);

    const content = await readFile(
      join(tempSwarm, "domains", "todo-app", "learned", "runs", "run-test-abc123.md"),
      "utf-8",
    );
    expect(content).toContain("goal-1: failed (0/1 tasks)");
  });
});
