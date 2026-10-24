import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { captureRunObservation, readDeferredSuggestions } from "../src/learning/capture.js";
import type { CaptureInput } from "../src/learning/capture.js";
import type { TaskOutcomeSummary } from "@mnmal-ai/swarm-types";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Honest run summary — Ship Readiness, Suggestions Deferred, Post-run Human PRs.
// Both new sections render with
// sample inputs (snapshot test on formatObservationMd output). We exercise the
// real write path — captureRunObservation writes exactly formatObservationMd's
// output to learned/runs/<runId>.md, so snapshotting that file IS snapshotting
// the formatter, and it also drives readDeferredSuggestions against a real
// `.suggestions-log.json` on disk.
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

// Deterministic base input — fixed times keep the rendered date stable for snapshots.
function makeInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: "run-summary-test",
    project: "todo-app",
    swarmVersion: "v0.12.0",
    workerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-sonnet-4-6",
    startTime: Date.parse("2026-03-22T14:00:00Z"),
    endTime: Date.parse("2026-03-22T14:30:00Z"),
    goals: [{ id: "goal-1", description: "Build the model", status: "completed" }],
    taskOutcomes: [makeTask()],
    filesChanged: [],
    mergeConflicts: [],
    totalTokens: 1_500_000,
    ...overrides,
  };
}

const runFile = (swarmPath: string, runId: string) =>
  join(swarmPath, "domains", "todo-app", "learned", "runs", `${runId}.md`);

// Canonical SuggestionsLog wrapper — mirrors the shape that
// /prepare-for-swarm writes to `.swarm/.suggestions-log.json`
// (see packages/cli/src/scaffold/templates/suggestions-log-schema.ts).
function suggestionsLog(entries: unknown[]): string {
  return JSON.stringify({
    schemaVersion: "1",
    generatedAt: "2026-03-22T14:00:00Z",
    detection: { stacks: [], frameworks: [], signals: {} },
    entries,
  });
}

// ---------------------------------------------------------------------------
// Snapshot — full input (contract loaded, suggestions log present)
// ---------------------------------------------------------------------------

describe("run summary sections — rendered output", () => {
  let tempSwarm: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    tempSwarm = await mkdtemp(join(tmpdir(), "swarm-run-summary-"));
    tempDirs.push(tempSwarm);
  });

  afterAll(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("renders all three sections for a full input — contract loaded, declined suggestions only", async () => {
    // Suggestions log holds both declined ("no") and accepted ("yes") offers;
    // only the declined ones must surface in the report.
    await writeFile(
      join(tempSwarm, ".suggestions-log.json"),
      suggestionsLog([
        { catalogEntryId: "cat-1", axis: "testing", response: "no", reason: "out of scope", offeredAt: "2026-03-22T14:00:00Z" },
        { catalogEntryId: "cat-2", axis: "perf", response: "yes", offeredAt: "2026-03-22T14:05:00Z" },
        { catalogEntryId: "cat-3", axis: "docs", response: "no", offeredAt: "2026-03-22T14:10:00Z" },
      ]),
    );

    const input = makeInput({
      goals: [
        { id: "goal-1", description: "Build the model", status: "completed" },
        { id: "goal-2", description: "Build the list view", status: "failed" },
        { id: "goal-3", description: "Polish", status: "completed" },
      ],
      taskOutcomes: [
        makeTask({ taskId: "goal-1-task-1", goalId: "goal-1", verdict: "approved" }),
        // goal-2 carries real token counts so the snapshot exercises the
        // token line end to end, not just the zero-token rendering path.
        makeTask({
          taskId: "goal-2-task-1",
          goalId: "goal-2",
          verdict: "rejected",
          rejectionReasons: ["type errors"],
          inputTokens: 200_000,
          outputTokens: 100_000,
        }),
        makeTask({ taskId: "goal-3-task-1", goalId: "goal-3", verdict: "approved" }),
      ],
      shipReadiness: {
        contractLoaded: true,
        goals: [
          { goalId: "goal-1", applied: true, status: "passed", detail: "verify:vercel green" },
          { goalId: "goal-2", applied: true, status: "failed", detail: "type errors" },
          { goalId: "goal-3", applied: false, status: "skipped" },
        ],
      },
    });

    captureRunObservation(tempSwarm, input);
    const md = await readFile(runFile(tempSwarm, "run-summary-test"), "utf-8");

    // Ship Readiness — gate fired, mix of passed/failed/skipped with detail.
    expect(md).toContain("## Ship Readiness");
    expect(md).toContain("- goal-1: passed — verify:vercel green");
    expect(md).toContain("- goal-2: failed — type errors");
    expect(md).toContain("- goal-3: skipped");
    expect(md).not.toContain("No ship-readiness contract");

    // Suggestions Deferred — only declined ("no") offers; "perf" (yes) absent.
    expect(md).toContain("## Suggestions Deferred");
    expect(md).toContain("- testing: out of scope");
    expect(md).toContain("- docs");
    expect(md).not.toContain("- perf");
    expect(md).not.toContain("None.");

    // Post-run Human PRs — placeholder still renders (not yet back-filled).
    expect(md).toContain("## Post-run Human PRs");
    expect(md).toContain("_None yet — back-filled by `swarm learn-from-pr`._");

    expect(md).toMatchInlineSnapshot(`
      "---
      run_id: "run-summary-test"
      date: "2026-03-22"
      swarm_version: "v0.12.0"
      project: "todo-app"
      worker_model: "claude-sonnet-4-6"
      reviewer_model: "claude-sonnet-4-6"
      goals_attempted: ["goal-1","goal-2","goal-3"]
      goals_completed: ["goal-1","goal-3"]
      goals_failed: ["goal-2"]
      total_tasks: 3
      tasks_approved: 2
      tasks_rejected: 1
      total_retries: 0
      arbiter_invocations: 0
      human_escalations: 0
      total_tokens: 1500000
      duration_ms: 1800000
      paused: false
      ---

      ## Reviewer Feedback
      - goal-2-task-1: rejected — "type errors"

      ## Goal Summary
      - goal-1: completed (1/1 tasks) — Total tokens: 1,500,000
      - goal-2: failed (0/1 tasks) — Total tokens: 300,000
      - goal-3: completed (1/1 tasks) — Total tokens: 1,500,000

      ## Task Details
      - goal-1-task-1 [implementation]: approved — Total tokens: 1,500,000, 0 retries
      - goal-2-task-1 [implementation]: rejected — Total tokens: 300,000, 0 retries
      - goal-3-task-1 [implementation]: approved — Total tokens: 1,500,000, 0 retries

      ## Ship Readiness
      - goal-1: passed — verify:vercel green
      - goal-2: failed — type errors
      - goal-3: skipped

      ## Suggestions Deferred
      - testing: out of scope
      - docs

      ## Post-run Human PRs
      _None yet — back-filled by \`swarm learn-from-pr\`._
      "
    `);
  });

  it("renders fallback lines for empty input — no contract, no suggestions log", async () => {
    // No `.suggestions-log.json` written; shipReadiness omitted entirely so
    // buildObservation defaults contractLoaded=false.
    const input = makeInput();

    captureRunObservation(tempSwarm, input);
    const md = await readFile(runFile(tempSwarm, "run-summary-test"), "utf-8");

    // Ship Readiness — gate did not run.
    expect(md).toContain("## Ship Readiness");
    expect(md).toContain("No ship-readiness contract — gate did not run.");

    // Suggestions Deferred — none.
    expect(md).toMatch(/## Suggestions Deferred\nNone\./);

    // Post-run Human PRs — placeholder still renders.
    expect(md).toContain("## Post-run Human PRs");
    expect(md).toContain("_None yet — back-filled by `swarm learn-from-pr`._");

    expect(md).toMatchInlineSnapshot(`
      "---
      run_id: "run-summary-test"
      date: "2026-03-22"
      swarm_version: "v0.12.0"
      project: "todo-app"
      worker_model: "claude-sonnet-4-6"
      reviewer_model: "claude-sonnet-4-6"
      goals_attempted: ["goal-1"]
      goals_completed: ["goal-1"]
      goals_failed: []
      total_tasks: 1
      tasks_approved: 1
      tasks_rejected: 0
      total_retries: 0
      arbiter_invocations: 0
      human_escalations: 0
      total_tokens: 1500000
      duration_ms: 1800000
      paused: false
      ---

      ## Goal Summary
      - goal-1: completed (1/1 tasks) — Total tokens: 1,500,000

      ## Task Details
      - goal-1-task-1 [implementation]: approved — Total tokens: 1,500,000, 0 retries

      ## Ship Readiness
      No ship-readiness contract — gate did not run.

      ## Suggestions Deferred
      None.

      ## Post-run Human PRs
      _None yet — back-filled by \`swarm learn-from-pr\`._
      "
    `);
  });
});

// ---------------------------------------------------------------------------
// readDeferredSuggestions — direct unit tests
// ---------------------------------------------------------------------------

describe("readDeferredSuggestions", () => {
  let tempSwarm: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    tempSwarm = await mkdtemp(join(tmpdir(), "swarm-deferred-"));
    tempDirs.push(tempSwarm);
  });

  afterAll(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns [] when the suggestions log file is missing", () => {
    expect(readDeferredSuggestions(tempSwarm)).toEqual([]);
  });

  it("returns [] when the suggestions log is malformed JSON", async () => {
    await writeFile(join(tempSwarm, ".suggestions-log.json"), "{ not valid json");
    expect(readDeferredSuggestions(tempSwarm)).toEqual([]);
  });

  it("returns [] when the parsed JSON has neither an entries field nor is an array", async () => {
    await writeFile(join(tempSwarm, ".suggestions-log.json"), JSON.stringify({ response: "no" }));
    expect(readDeferredSuggestions(tempSwarm)).toEqual([]);
  });

  it("maps and filters to declined ('no') entries only, preserving order — canonical SuggestionsLog shape", async () => {
    // The format /prepare-for-swarm actually writes: a SuggestionsLog object
    // with an `entries` sub-array. This is the production path.
    await writeFile(
      join(tempSwarm, ".suggestions-log.json"),
      suggestionsLog([
        { catalogEntryId: "cat-1", axis: "testing", response: "no", reason: "out of scope", offeredAt: "2026-03-22T14:00:00Z" },
        { catalogEntryId: "cat-2", axis: "perf", response: "yes", offeredAt: "2026-03-22T14:05:00Z" },
        { catalogEntryId: "cat-3", axis: "docs", response: "no", offeredAt: "2026-03-22T14:10:00Z" },
      ]),
    );

    expect(readDeferredSuggestions(tempSwarm)).toEqual([
      { catalogEntryId: "cat-1", axis: "testing", reason: "out of scope", offeredAt: "2026-03-22T14:00:00Z" },
      { catalogEntryId: "cat-3", axis: "docs", reason: undefined, offeredAt: "2026-03-22T14:10:00Z" },
    ]);
  });

  it("also accepts a bare top-level array (legacy/test fixtures)", async () => {
    // Back-compat: earlier fixtures wrote a bare array directly. The unwrap
    // logic falls back to treating the root as the entries list when the
    // canonical `entries` field is absent.
    await writeFile(
      join(tempSwarm, ".suggestions-log.json"),
      JSON.stringify([
        { catalogEntryId: "cat-1", axis: "testing", response: "no", reason: "legacy fixture", offeredAt: "2026-03-22T14:00:00Z" },
      ]),
    );
    expect(readDeferredSuggestions(tempSwarm)).toEqual([
      { catalogEntryId: "cat-1", axis: "testing", reason: "legacy fixture", offeredAt: "2026-03-22T14:00:00Z" },
    ]);
  });

  it("returns [] when no entries are declined", async () => {
    await writeFile(
      join(tempSwarm, ".suggestions-log.json"),
      suggestionsLog([{ catalogEntryId: "cat-1", axis: "perf", response: "yes", offeredAt: "2026-03-22T14:00:00Z" }]),
    );
    expect(readDeferredSuggestions(tempSwarm)).toEqual([]);
  });
});
