import { describe, it, expect, afterEach, vi } from "vitest";
import { captureRunObservation } from "../src/learning/capture.js";
import type { CaptureInput } from "../src/learning/capture.js";
import type { TaskOutcomeSummary } from "@mnmal-ai/swarm-types";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Regression — the goal-6d honest-run-summary must always be written at
// session end. Run-id 3dcd7f had a clean session_end event in telemetry yet
// learned/runs/<runId>.md was never written: capture.ts threw on a path guard
// and run.ts swallowed the throw into a dim log line, so the summary vanished.
//
// This file drives captureRunObservation() directly with a synthetic SUCCESSFUL
// run observation, runsDir resolved under an mkdtemp temp directory, and proves:
//   1. learned/runs/<runId>.md exists at the resolved path.
//   2. its contents carry all three goal-6d section headers.
//   3. a malformed/missing project-name guard input still WRITES the md under a
//      fallback slug rather than skipping it (the capture.ts hardening).
//
// Depends on the capture.ts guard hardening + run.ts always-invoke-capture
// sub-tasks already being in place.
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

// A synthetic, fully-successful run: every goal completed, every task approved,
// no conflicts, not paused. Fixed timestamps keep the rendered date stable.
function makeSuccessfulInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: "run-3dcd7f",
    project: "todo-app",
    swarmVersion: "v0.12.0",
    workerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-sonnet-4-6",
    startTime: Date.parse("2026-06-02T14:00:00Z"),
    endTime: Date.parse("2026-06-02T14:30:00Z"),
    goals: [{ id: "goal-1", description: "Build the model", status: "completed" }],
    taskOutcomes: [makeTask({ verdict: "approved", rejectionReasons: [] })],
    filesChanged: ["src/index.ts"],
    mergeConflicts: [],
    totalTokens: 1_500_000,
    paused: false,
    ...overrides,
  };
}

const GOAL_6D_SECTIONS = ["## Ship Readiness", "## Suggestions Deferred", "## Post-run Human PRs"];

describe("run-summary regression — goal-6d honest-run-summary always written", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function freshSwarm(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("writes learned/runs/<runId>.md with all three goal-6d sections for a successful session", async () => {
    const tempSwarm = await freshSwarm("swarm-run-summary-regression-");
    const input = makeSuccessfulInput();

    captureRunObservation(tempSwarm, input);

    // (1) The .md exists at the resolved path (swarmPath/domains/<slug>/learned/runs/<runId>.md).
    const runFile = join(tempSwarm, "domains", "todo-app", "learned", "runs", `${input.runId}.md`);
    expect(existsSync(runFile)).toBe(true);

    // (2) Its contents carry all three goal-6d section headers.
    const md = await readFile(runFile, "utf-8");
    for (const header of GOAL_6D_SECTIONS) {
      expect(md).toContain(header);
    }
    // Sanity: it really is this run's summary.
    expect(md).toContain('run_id: "run-3dcd7f"');
    expect(md).toContain("paused: false");
  });

  it("still writes the md under a fallback slug when the project name is malformed (capture.ts hardening)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tempSwarm = await freshSwarm("swarm-run-summary-malformed-");
      // A path-traversal-flavoured name the old guard threw on; the hardened
      // guard sanitizes it to a safe slug and continues to the write.
      const input = makeSuccessfulInput({ project: "../evil/project" });

      captureRunObservation(tempSwarm, input);

      // Written under the sanitized slug — no traversal escapes the domains dir,
      // and the summary is NOT skipped.
      const runFile = join(tempSwarm, "domains", "evil-project", "learned", "runs", `${input.runId}.md`);
      expect(existsSync(runFile)).toBe(true);

      const md = await readFile(runFile, "utf-8");
      for (const header of GOAL_6D_SECTIONS) {
        expect(md).toContain(header);
      }

      // The slug mismatch is surfaced as a warning, not silently swallowed.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a"));
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to a default slug and still writes when the project name has no safe characters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tempSwarm = await freshSwarm("swarm-run-summary-emptyslug-");
      const input = makeSuccessfulInput({ project: "///..." });

      captureRunObservation(tempSwarm, input);

      const runFile = join(tempSwarm, "domains", "unknown-project", "learned", "runs", `${input.runId}.md`);
      expect(existsSync(runFile)).toBe(true);

      const md = await readFile(runFile, "utf-8");
      for (const header of GOAL_6D_SECTIONS) {
        expect(md).toContain(header);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
