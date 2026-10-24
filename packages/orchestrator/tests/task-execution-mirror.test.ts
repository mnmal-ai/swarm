import { randomUUID } from "node:crypto";
import { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import {
  SUCCESS_TASK_STATUSES,
  SUCCESS_VERDICTS,
  type OversightResult,
  type TaskStatus,
} from "@mnmal-ai/swarm-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mirrorGoalStart,
  mirrorTaskExecutionEnd,
  mirrorTaskExecutionStart,
  readTaskExecutionCounts,
  type TaskExecutionEndStatus,
} from "../src/learning/task-execution-mirror.js";

/**
 * Acceptance fixture for the goal-9 Goal/TaskExecution mirror — the primary
 * check on the status-transition criterion.
 *
 * Drives the mirror helpers through a REAL SubstrateClient against the spawned
 * test sidecar (`tests/setup/isolated-substrate.ts`, memory store, the real
 * swarm plugin): rows are really written, read back and aggregated through the
 * plugin's autoCRUD surface, and the terminal status is derived through the
 * SAME verdict mapping the dispatch loop uses (see {@link computeTaskStatus}).
 * Gated on SWARM_SDK_E2E=1, which is when the globalSetup starts the sidecar.
 *
 * The sidecar is shared by every test in the run, so each test scopes its rows
 * by its own goal id.
 *
 * This complements the param-shaping unit suite at
 * packages/orchestrator/src/learning/task-execution-mirror.test.ts: there rows
 * are inspected through recording stubs.
 */

const RUN_E2E = process.env.SWARM_SDK_E2E === "1" && Boolean(process.env.SWARM_SUBSTRATE_ENDPOINT);

/** The documented status vocabulary (CLAUDE.md / plugin contract). */
const VALID_STATUSES = ["pending", "running", "completed", "failed", "blocked"];

// ---------------------------------------------------------------------------
// Terminal-status derivation — reproduced from the CLI dispatch loop.
//
// run.ts maps an OversightResult to a TaskStatus via a module-private
// `computeTaskStatus`, then narrows that to the TaskExecution terminal set
// before calling mirrorTaskExecutionEnd. That function is not exported (and the
// orchestrator does not depend on the CLI package), so the mapping is duplicated
// here — but anchored on the SAME exported sets the original closes over
// (`SUCCESS_VERDICTS`, `SUCCESS_TASK_STATUSES`), so it cannot drift from the
// production behavior. If a verdict's success classification changes, both move
// together.
// ---------------------------------------------------------------------------

/** Faithful copy of run.ts's `computeTaskStatus(oversight)`. */
function computeTaskStatus(oversight: OversightResult): TaskStatus {
  if (oversight.humanEscalation) return "blocked";
  const { verdict } = oversight;
  if (verdict === "completed_with_notes") return "completed_with_notes";
  if (verdict === "completed_with_deferrals") return "completed_with_deferrals";
  return SUCCESS_VERDICTS.has(verdict) ? "completed" : "failed";
}

/** The dispatch-loop narrowing of a TaskStatus to the TaskExecution terminal set. */
function narrowToEndStatus(status: TaskStatus): TaskExecutionEndStatus {
  return status === "blocked"
    ? "blocked"
    : SUCCESS_TASK_STATUSES.has(status)
      ? "completed"
      : "failed";
}

// ---------------------------------------------------------------------------
// Sidecar harness: a real SubstrateClient whose fire-and-forget mutations can
// be awaited, and per-goal reads.
// ---------------------------------------------------------------------------

const TASK_EXECUTION_FIELDS = {
  id: true,
  goalId: true,
  sessionId: true,
  workerResultId: true,
  status: true,
  retries: true,
  startedAt: true,
  completedAt: true,
} as const;

const GOAL_FIELDS = { id: true, goalId: true, projectId: true, status: true, acceptanceCriteria: true } as const;

/**
 * A SubstrateClient on the test sidecar. `settle()` awaits the mutations the
 * void helpers launch but never await, so reads see a quiesced store.
 */
function makeSidecarClient(): { client: SubstrateClient; settle: () => Promise<unknown> } {
  const real = new SubstrateClient(process.env.SWARM_SUBSTRATE_ENDPOINT as string);
  const pending: Promise<unknown>[] = [];
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "mutate") {
        return (...args: Parameters<SubstrateClient["mutate"]>) => {
          const p = target.mutate(...args);
          pending.push(p.catch(() => {}));
          return p;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client, settle: () => Promise.allSettled(pending) };
}

/** A goal id no other test (or earlier run against a shared store) uses. */
function uniqueGoalId(): string {
  return `goal-9-${randomUUID()}`;
}

/** Every TaskExecution row of `goalId`. */
async function readTaskExecutions(client: SubstrateClient, goalId: string): Promise<Array<Record<string, unknown>>> {
  return client.query<Record<string, unknown>>("TaskExecution", { where: { goalId: { eq: goalId } } }, TASK_EXECUTION_FIELDS);
}

/** Every Goal row of `goalId`. */
async function readGoals(client: SubstrateClient, goalId: string): Promise<Array<Record<string, unknown>>> {
  return client.query<Record<string, unknown>>("Goal", { where: { goalId: { eq: goalId } } }, GOAL_FIELDS);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // Fire-and-forget failure paths log a non-blocking warning; silence it so the
  // suite output stays clean. None of the happy-path assertions below should
  // trigger it — asserted explicitly where it matters.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.clearAllMocks();
});

describe.skipIf(!RUN_E2E)("task-execution mirror — status-transition acceptance fixture (real sidecar)", () => {
  // -------------------------------------------------------------------------
  // (1) Happy path: running -> completed, same id, completedAt stamped.
  // -------------------------------------------------------------------------
  it("transitions a TaskExecution running -> completed, preserving its id and stamping completedAt", async () => {
    const { client, settle } = makeSidecarClient();
    const goalId = uniqueGoalId();

    // Dispatch: the start helper awaits the create, so the id is back before it
    // resolves. A started task is, by definition, running.
    const id = await mirrorTaskExecutionStart(client, {
      goalId,
      sessionId: "sess-1",
      status: "running",
      retries: 0,
      startedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(id).toBeTruthy();

    // Read the row back mid-flight: it must be parked at `running` with no
    // terminal stamp yet — the exact pre-transition state.
    const [running] = await readTaskExecutions(client, goalId);
    expect(String(running.id)).toBe(id);
    expect(running.status).toBe("running");
    expect(running.completedAt == null).toBe(true);

    // A successful oversight result maps to a `completed` terminal status
    // through the same verdict mapping the dispatch loop uses.
    const oversight: OversightResult = {
      verdict: "approved",
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
      rejectionReasons: [],
      totalResolutionTimeMs: 1200,
    };
    expect(computeTaskStatus(oversight)).toBe("completed");
    const endStatus = narrowToEndStatus(computeTaskStatus(oversight));
    expect(endStatus).toBe("completed");

    mirrorTaskExecutionEnd(client, id as string, {
      status: endStatus,
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: oversight.retryCount,
      workerResultId: "wr-1",
    });
    await settle();

    // Read the SAME row back: running -> completed, id unchanged, completedAt set.
    const [completed] = await readTaskExecutions(client, goalId);
    expect(String(completed.id)).toBe(id);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe("2026-06-01T12:05:00.000Z");
    expect(completed.workerResultId).toBe("wr-1");
    // The update merged onto the create-time fields it never sent.
    expect(completed.goalId).toBe(goalId);
    expect(completed.sessionId).toBe("sess-1");
    expect(completed.startedAt).toBe("2026-06-01T12:00:00.000Z");
    // Exactly one row was written — the end was an UPDATE, not a second insert.
    expect(await readTaskExecutions(client, goalId)).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (2) Retry-exhausted path: a task whose final computeTaskStatus is 'failed'
  //     transitions running -> failed.
  // -------------------------------------------------------------------------
  it("transitions a retry-exhausted (computeTaskStatus 'failed') TaskExecution running -> failed", async () => {
    const { client, settle } = makeSidecarClient();
    const goalId = uniqueGoalId();

    const id = await mirrorTaskExecutionStart(client, {
      goalId,
      sessionId: "sess-retry",
      // Three retries already consumed when the task was last (re)dispatched.
      status: "running",
      retries: 3,
      startedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(id).toBeTruthy();
    const [beforeEnd] = await readTaskExecutions(client, goalId);
    expect(beforeEnd.status).toBe("running");

    // Retries exhausted, still rejected, NOT escalated to a human: the verdict
    // mapping resolves to a literal `failed` (not blocked, not completed).
    const oversight: OversightResult = {
      verdict: "rejected",
      retryCount: 3,
      arbiterInvolved: true,
      humanEscalation: false,
      rejectionReasons: ["still failing after 3 retries"],
      totalResolutionTimeMs: 9000,
    };
    expect(computeTaskStatus(oversight)).toBe("failed");
    const endStatus = narrowToEndStatus(computeTaskStatus(oversight));
    expect(endStatus).toBe("failed");

    mirrorTaskExecutionEnd(client, id as string, {
      status: endStatus,
      completedAt: "2026-06-01T12:10:00.000Z",
      retries: oversight.retryCount,
    });
    await settle();

    const [failed] = await readTaskExecutions(client, goalId);
    expect(String(failed.id)).toBe(id);
    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBe("2026-06-01T12:10:00.000Z");
    expect(failed.retries).toBe(3);
    // workerResultId was not supplied at the terminal flip — the seeded empty
    // value is left untouched (no overwrite-with-undefined).
    expect(failed.workerResultId).toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (3) mirrorGoalStart writes a Goal row whose id+status match goals.json
  //     reality, and a subsequent updateGoal can find it by goalId.
  // -------------------------------------------------------------------------
  it("mirrorGoalStart writes a Goal whose goalId+status match the manifest, then updateGoal finds it by goalId", async () => {
    const { client, settle } = makeSidecarClient();
    const goalId = uniqueGoalId();

    // A realistic goals.json manifest entry: a goal in flight carries the
    // documented `running` status and its own goal id.
    const manifestGoalId = goalId;
    const manifestStatus = "running" as const;
    expect(VALID_STATUSES).toContain(manifestStatus);

    mirrorGoalStart(client, {
      goalId: manifestGoalId,
      projectId: "swarm",
      description: "Populate Goal/TaskExecution entities at runtime",
      priority: "high",
      status: manifestStatus,
      acceptanceCriteria: ["status transitions mirrored", "run summary sources TaskExecution"],
      constraints: ["fire-and-forget"],
      dependsOn: ["goal-8"],
      timestamp: "2026-06-01T12:00:00.000Z",
    });
    await settle();

    // The written Goal row's id+status match the manifest reality.
    const [goal] = await readGoals(client, goalId);
    expect(goal).toBeDefined();
    expect(goal.goalId).toBe(manifestGoalId);
    expect(goal.status).toBe(manifestStatus);
    // Array fields round-trip through the plugin's string columns as JSON.
    expect(JSON.parse(goal.acceptanceCriteria as string)).toEqual([
      "status transitions mirrored",
      "run summary sources TaskExecution",
    ]);

    // A subsequent updateGoal can find the row by goalId: locate it through its
    // goalId field, then flip its status via the engine-assigned id.
    const found = await client.query("Goal", { where: { goalId: { eq: manifestGoalId } } }, GOAL_FIELDS);
    expect(found).toHaveLength(1);
    const rowId = (found[0] as { id: string | number }).id;

    await client.mutate("updateGoal", { id: rowId, status: "completed" }, { id: true });

    // Re-find by goalId: the same row, now completed, goalId unchanged.
    const refound = (await client.query("Goal", { where: { goalId: { eq: manifestGoalId } } }, GOAL_FIELDS)) as Array<
      Record<string, unknown>
    >;
    expect(refound).toHaveLength(1);
    expect(String(refound[0].id)).toBe(String(rowId));
    expect(refound[0].goalId).toBe(manifestGoalId);
    expect(refound[0].status).toBe("completed");
    expect(VALID_STATUSES).toContain(refound[0].status);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (4) Only the documented status strings ever appear on mirrored rows.
  //     (5) readTaskExecutionCounts matches the dispatched-task reality,
  //     cross-checked row-by-row by id + status.
  // -------------------------------------------------------------------------
  it("aggregates counts matching the dispatched-task reality (by id+status) using only documented statuses", async () => {
    const { client, settle } = makeSidecarClient();
    const goalId = uniqueGoalId();

    // The goal under which the run dispatches; mirrored at goal-start.
    mirrorGoalStart(client, {
      goalId,
      projectId: "swarm",
      description: "Populate Goal/TaskExecution entities at runtime",
      priority: "high",
      status: "running",
      acceptanceCriteria: [],
      constraints: [],
      dependsOn: [],
      timestamp: "2026-06-01T12:00:00.000Z",
    });

    // The dispatched-task reality: each entry is one task with the oversight
    // result it ended on (or none → left running). The terminal status is
    // DERIVED through computeTaskStatus, exactly as the dispatch loop derives it.
    const dispatched: Array<{ sessionId: string; oversight?: OversightResult }> = [
      { sessionId: "sess-a", oversight: oversightFor("approved", false) }, // completed
      { sessionId: "sess-b", oversight: oversightFor("completed_with_notes", false) }, // completed
      { sessionId: "sess-c", oversight: oversightFor("rejected", false) }, // failed
      { sessionId: "sess-d", oversight: oversightFor("rejected", true) }, // blocked (escalated)
      { sessionId: "sess-e" }, // stays running
    ];

    // Dispatch each task, recording the id Substrate assigned and the status we
    // expect that id to carry — the ground-truth (id -> status) map.
    const expectedById = new Map<string, string>();
    for (const task of dispatched) {
      const id = await mirrorTaskExecutionStart(client, {
        goalId,
        sessionId: task.sessionId,
        status: "running",
        retries: 0,
        startedAt: "2026-06-01T12:00:00.000Z",
      });
      expect(id).toBeTruthy();
      if (task.oversight) {
        const endStatus = narrowToEndStatus(computeTaskStatus(task.oversight));
        mirrorTaskExecutionEnd(client, id as string, {
          status: endStatus,
          completedAt: "2026-06-01T12:05:00.000Z",
          retries: task.oversight.retryCount,
        });
        expectedById.set(id as string, endStatus);
      } else {
        expectedById.set(id as string, "running");
      }
    }
    await settle();

    // (4) Every mirrored row — Goal + TaskExecution — carries only a documented
    // status string. No invented values leak through the helpers.
    const goalRows = await readGoals(client, goalId);
    const taskRows = await readTaskExecutions(client, goalId);
    for (const row of [...goalRows, ...taskRows]) {
      expect(VALID_STATUSES).toContain(row.status);
    }

    // (5a) Row-by-row: the stored (id -> status) map equals the dispatched
    // reality exactly — same ids, same statuses, no extra or missing rows.
    const actualById = new Map(taskRows.map(r => [String(r.id), String(r.status)]));
    expect(actualById).toEqual(expectedById);

    // (5b) The aggregate from readTaskExecutionCounts matches the tally derived
    // from that same reality, scoped to the dispatched goal.
    const expectedCounts = tallyExpected(expectedById);
    const counts = await readTaskExecutionCounts(client, { goalIds: [goalId] });
    expect(counts).toEqual(expectedCounts);
    // Sanity-anchor the derived expectation against the known plan.
    expect(expectedCounts).toEqual({
      total: 5,
      completed: 2,
      failed: 1,
      blocked: 1,
      running: 1,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/** Build an OversightResult for `verdict`, optionally human-escalated. */
function oversightFor(
  verdict: OversightResult["verdict"],
  humanEscalation: boolean,
): OversightResult {
  return {
    verdict,
    retryCount: humanEscalation ? 3 : 0,
    arbiterInvolved: humanEscalation,
    humanEscalation,
    rejectionReasons: [],
    totalResolutionTimeMs: 1000,
  };
}

/** Tally a ground-truth (id -> status) map into the TaskExecutionCounts shape. */
function tallyExpected(byId: Map<string, string>): {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  running: number;
} {
  const counts = { total: 0, completed: 0, failed: 0, blocked: 0, running: 0 };
  for (const status of byId.values()) {
    counts.total += 1;
    if (status === "completed") counts.completed += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "running") counts.running += 1;
  }
  return counts;
}
