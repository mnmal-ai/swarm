/**
 * Integration test: token budget enforcement.
 *
 * Budgets are in tokens only — all input (fresh, cache reads, cache writes)
 * plus output — at three levels. The session warns once at 80% of its limit
 * and pauses the moment it is exceeded; a goal stops once its limit is
 * exceeded; a task over its limit is flagged. A project that sets no limit
 * gets its trust level's, so enforcement is never inert.
 *
 * This drives a real Orchestrator (the source of the budget predicates and the
 * cumulative counter) through `evaluateSessionBudget` — the exact decision the
 * run loop uses at each task boundary.
 */

import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { AUTONOMY_PRESETS, Orchestrator } from "@mnmal-ai/swarm-orchestrator";
import { LocalTaskBackend } from "@mnmal-ai/swarm-task-backends";
import { evaluateSessionBudget } from "@mnmal-ai/swarm-cli";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BACKEND_DIR = join(__dirname, "__fixtures__", "token-budget-enforcement");

afterAll(() => {
  rmSync(BACKEND_DIR, { recursive: true, force: true });
});

function makeConfig(limits: { session?: number; goal?: number; task?: number } = {}): ProjectConfig {
  return {
    project: "token-budget-test",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency: {
      max_workers: 3,
      ...(limits.session === undefined ? {} : { max_tokens_per_session: limits.session }),
      ...(limits.goal === undefined ? {} : { max_tokens_per_goal: limits.goal }),
      ...(limits.task === undefined ? {} : { max_tokens_per_task: limits.task }),
    },
    task_backend: "local",
    created: "2026-06-01T00:00:00Z",
  };
}

let seq = 0;
function makeOrchestrator(limits: { session?: number; goal?: number; task?: number } = {}): Orchestrator {
  const backend = new LocalTaskBackend(join(BACKEND_DIR, `s${seq++}`));
  return new Orchestrator({ projectConfig: makeConfig(limits), backend });
}

// ---------------------------------------------------------------------------
// Session harness — mirrors the run-loop budget gate: at each task boundary
// evaluate the session budget, warn once, pause once exceeded; otherwise "run"
// the task and add its tokens.
// ---------------------------------------------------------------------------

interface SessionResult {
  warned: boolean;
  aborted: boolean;
  tasksRun: number;
}

function runBudgetedSession(orchestrator: Orchestrator, taskTokens: number[]): SessionResult {
  const r: SessionResult = { warned: false, aborted: false, tasksRun: 0 };

  for (const tokens of taskTokens) {
    const decision = evaluateSessionBudget(orchestrator, orchestrator.getCumulativeTokens(), {
      tokenWarningIssued: r.warned,
    });
    if (decision.warnTokens) r.warned = true;
    if (decision.abort) {
      r.aborted = true;
      break;
    }
    orchestrator.addTokens(tokens);
    r.tasksRun++;
  }

  return r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("token budget enforcement", () => {
  it("pauses the session once its token limit is exceeded", () => {
    const orch = makeOrchestrator({ session: 1000 });

    const result = runBudgetedSession(orch, [400, 400, 400, 400, 400]);

    // t1→400, t2→800, t3→1200; the gate before t4 sees 1200 > 1000 and pauses.
    expect(result.aborted).toBe(true);
    expect(result.tasksRun).toBe(3);
    expect(orch.getCumulativeTokens()).toBe(1200);
  });

  it("warns once at 80% of the session limit without pausing", () => {
    const orch = makeOrchestrator({ session: 1000 }); // 80% = 800

    const result = runBudgetedSession(orch, [450, 450, 0]);

    expect(result.warned).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.tasksRun).toBe(3);
  });

  it("does not re-warn once the warning was issued", () => {
    const orch = makeOrchestrator({ session: 1000 });
    orch.addTokens(900);

    expect(evaluateSessionBudget(orch, orch.getCumulativeTokens(), { tokenWarningIssued: false }).warnTokens).toBe(true);
    expect(evaluateSessionBudget(orch, orch.getCumulativeTokens(), { tokenWarningIssued: true }).warnTokens).toBe(false);
  });

  it("stops a goal once its token limit is exceeded", () => {
    const orch = makeOrchestrator({ goal: 1000 });

    expect(orch.isGoalTokenExceeded(1000)).toBe(false);
    expect(orch.isGoalTokenExceeded(1001)).toBe(true);
  });

  it("flags a task over its token limit, and honours a raised limit", () => {
    const orch = makeOrchestrator({ task: 500 });

    expect(orch.isTaskTokenExceeded(600)).toBe(true);
    orch.updateTaskTokenLimit(900);
    expect(orch.isTaskTokenExceeded(600)).toBe(false);
  });

  it("enforces the trust level's limits when the project sets none", () => {
    const orch = makeOrchestrator();
    const preset = AUTONOMY_PRESETS.medium.execution;

    const result = runBudgetedSession(orch, [preset.max_tokens_per_session, 1, 1]);

    // Exactly at the limit is not over it; the next token is.
    expect(result.aborted).toBe(true);
    expect(result.tasksRun).toBe(2);
    expect(orch.isGoalTokenExceeded(preset.max_tokens_per_goal + 1)).toBe(true);
    expect(orch.isTaskTokenExceeded(preset.max_tokens_per_task + 1)).toBe(true);
  });
});
