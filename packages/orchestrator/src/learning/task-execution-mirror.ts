/**
 * Swarm Learning — Goal/TaskExecution Substrate mirror (goal-9).
 *
 * The `swarm/Goal` and `swarm/TaskExecution` types are declared by the swarm
 * Substrate plugin (packages/substrate-plugin/src/types/swarm-types.ts). This
 * module mirrors the orchestrator's in-memory dispatch state into those
 * entities at goal-start and at each task transition
 * (running -> completed/failed/blocked).
 *
 * It is a MIRROR, not a replacement: the orchestrator's in-memory tracking
 * stays authoritative and drives the dispatch loop. These writes are
 * fire-and-forget telemetry — a Substrate failure logs a warning and continues; it
 * never throws and never blocks the hot path (same contract as
 * capture.ts's `substrateMutateSafe`). The only exception is
 * {@link mirrorTaskExecutionStart}, which awaits the create so the caller gets
 * the row id back to update later — but a failure there resolves to `null`
 * rather than throwing.
 *
 * The module is deliberately pure of run.ts concerns (no console formatting
 * beyond the inherited warn) so it is unit-testable against a
 * stub client (and, under SWARM_SDK_E2E=1, against a spawned sidecar).
 */

import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * The documented status string set (CLAUDE.md / plugin contract). Goal and
 * TaskExecution share the same vocabulary; helpers constrain `status` to these
 * values so callers cannot invent new ones.
 */
export type MirrorStatus = "pending" | "running" | "completed" | "failed" | "blocked";

/** Terminal statuses a TaskExecution flips to from `running`. */
export type TaskExecutionEndStatus = "completed" | "failed" | "blocked";

// ---------------------------------------------------------------------------
// Fire-and-forget helper (replicated from capture.ts's substrateMutateSafe —
// that function is module-private there, so we keep the identical pattern here)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget Substrate mutation. Logs a non-blocking warning on failure but
 * never throws and never blocks the caller. Identical contract to capture.ts's
 * `substrateMutateSafe`.
 */
function substrateMutateSafe(
  substrateClient: SubstrateClient,
  mutationName: string,
  params: Record<string, unknown>,
): void {
  substrateClient.mutate(mutationName, params, { id: true }).catch(err => {
    console.warn(
      `[swarm] Substrate ${mutationName} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// mirrorGoalStart — createGoal at goal-start
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link mirrorGoalStart}. The array fields
 * (`acceptanceCriteria`, `constraints`, `dependsOn`) are JSON-stringified into
 * the plugin's string fields before the write — the caller passes real arrays.
 */
export interface MirrorGoalStartParams {
  goalId: string;
  projectId: string;
  description: string;
  priority: string;
  status: MirrorStatus;
  acceptanceCriteria: string[];
  constraints: string[];
  dependsOn: string[];
  /** ISO-8601 timestamp for the goal-start event. */
  timestamp: string;
}

/**
 * Mirror a goal into the `swarm/Goal` entity at goal-start via `createGoal`.
 * Fire-and-forget: a Substrate failure logs + continues, never blocks dispatch.
 *
 * The `swarm/Goal` Substrate type stores `acceptanceCriteria`, `constraints`, and
 * `dependsOn` as plain string fields, so the arrays are JSON.stringify-ed here
 * to round-trip cleanly. `status` is constrained to {@link MirrorStatus}.
 */
export function mirrorGoalStart(substrateClient: SubstrateClient, params: MirrorGoalStartParams): void {
  substrateMutateSafe(substrateClient, "createGoal", {
    goalId: params.goalId,
    projectId: params.projectId,
    description: params.description,
    priority: params.priority,
    status: params.status,
    acceptanceCriteria: JSON.stringify(params.acceptanceCriteria),
    constraints: JSON.stringify(params.constraints),
    dependsOn: JSON.stringify(params.dependsOn),
    timestamp: params.timestamp,
  });
}

// ---------------------------------------------------------------------------
// mirrorTaskExecutionStart — createTaskExecution at dispatch
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link mirrorTaskExecutionStart}. A task is mirrored the moment
 * it is dispatched, so its WorkerResult does not exist yet — `workerResultId` is
 * filled in later by {@link mirrorTaskExecutionEnd}.
 */
export interface MirrorTaskExecutionStartParams {
  goalId: string;
  sessionId: string;
  /** Always `'running'` at dispatch — a started task is, by definition, running. */
  status: "running";
  retries: number;
  /** ISO-8601 timestamp for when the task started. */
  startedAt: string;
}

/**
 * Mirror a dispatched task into the `swarm/TaskExecution` entity via
 * `createTaskExecution`, returning the created row id so the caller can link the
 * WorkerResult and flip the status later via {@link mirrorTaskExecutionEnd}.
 *
 * Unlike the other helpers this AWAITS the mutate (the id is needed downstream),
 * but it stays wrapped: a Substrate failure logs a warning and resolves to `null`
 * rather than throwing, preserving the never-block-the-hot-path contract.
 *
 * `TaskExecution.workerResultId` is a required (non-nullable) string in the
 * plugin schema, but the WorkerResult id is unknown at dispatch — so we seed it
 * with an empty string and overwrite it in {@link mirrorTaskExecutionEnd} once
 * the worker returns.
 */
export async function mirrorTaskExecutionStart(
  substrateClient: SubstrateClient,
  params: MirrorTaskExecutionStartParams,
): Promise<string | null> {
  try {
    const row = await substrateClient.mutate<{ id: string | number }>(
      "createTaskExecution",
      {
        goalId: params.goalId,
        sessionId: params.sessionId,
        // Seeded empty; linked later by mirrorTaskExecutionEnd. The field is
        // non-nullable in the plugin, so it must be present at create time.
        workerResultId: "",
        status: params.status,
        retries: params.retries,
        startedAt: params.startedAt,
      },
      { id: true },
    );
    return row?.id != null ? String(row.id) : null;
  } catch (err) {
    console.warn(
      `[swarm] Substrate createTaskExecution failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// mirrorTaskExecutionEnd — updateTaskExecution at terminal transition
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link mirrorTaskExecutionEnd}. Flips a running TaskExecution to
 * its terminal state and stamps `completedAt`. `workerResultId` links the
 * persisted WorkerResult when its id is known (it is omitted from the update when
 * absent, leaving the seeded value untouched).
 */
export interface MirrorTaskExecutionEndParams {
  status: TaskExecutionEndStatus;
  /** ISO-8601 timestamp for when the task reached its terminal state. */
  completedAt: string;
  retries: number;
  /** Set once the WorkerResult is persisted; omitted when not yet known. */
  workerResultId?: string;
}

/**
 * Flip a mirrored TaskExecution from `running` to its terminal state via
 * `updateTaskExecution`, setting `completedAt` and (when known) linking the
 * WorkerResult. Fire-and-forget: a Substrate failure logs + continues.
 *
 * @param taskExecutionId - The row id returned by {@link mirrorTaskExecutionStart}.
 */
export function mirrorTaskExecutionEnd(
  substrateClient: SubstrateClient,
  taskExecutionId: string,
  params: MirrorTaskExecutionEndParams,
): void {
  substrateMutateSafe(substrateClient, "updateTaskExecution", {
    id: taskExecutionId,
    status: params.status,
    completedAt: params.completedAt,
    retries: params.retries,
    ...(params.workerResultId !== undefined ? { workerResultId: params.workerResultId } : {}),
  });
}

// ---------------------------------------------------------------------------
// linkTaskExecutionWorkerResult — stamp the WorkerResult id after the worker returns
// ---------------------------------------------------------------------------

/**
 * Best-effort follow-up that links a terminal TaskExecution to the WorkerResult
 * persisted for its worker session.
 *
 * The WorkerResult id is not known when {@link mirrorTaskExecutionEnd} flips the
 * row terminal: Swarm writes the WorkerResult inside its atomic
 * `persistTaskTelemetry` flush and does not surface that id back to the
 * orchestrator. So this resolves it after the fact — query the WorkerResult
 * written for `sessionId` (the flush keys it by the worker session, and it has
 * already landed by the time `runWithOversight` returns), then stamp its id onto
 * the TaskExecution row via `updateTaskExecution`.
 *
 * The update sends ONLY `{ id, workerResultId }`, so it is field-disjoint from
 * the terminal flip's `{ status, completedAt, retries }`. AutoCRUD update merges
 * just the supplied fields onto the row's current state, so the two updates are
 * safe to race — neither clobbers the other's columns even when this follow-up
 * and the terminal flip are both in flight. The row is already terminal before
 * this runs, so any failure here (substrate hiccup, no matching WorkerResult, a
 * missing id, a review-skipped task that never produced an atomic flush) simply
 * leaves `workerResultId` at its seeded-empty default and nothing else.
 *
 * Fire-and-forget in the strongest sense: returns void, never throws, never
 * blocks the dispatch hot path. Do NOT await it.
 *
 * @param taskExecutionId - The row id returned by {@link mirrorTaskExecutionStart}.
 * @param sessionId - The worker session id (`SwarmOversightRunResult.sessionId`).
 */
export function linkTaskExecutionWorkerResult(
  substrateClient: SubstrateClient,
  taskExecutionId: string,
  sessionId: string,
): void {
  // No session id (or no row to link to) — nothing to resolve.
  if (!sessionId || !taskExecutionId) return;
  void (async () => {
    try {
      // Operator-keyed: Substrate refuses a bare `{ sessionId }` as an unknown param.
      const rows = await substrateClient.query<{ id: string | number; timestamp?: string }>(
        "WorkerResult",
        { where: { sessionId: { eq: sessionId } } },
        { id: true, timestamp: true },
      );
      if (!rows || rows.length === 0) return;
      // A session can carry more than one WorkerResult (e.g. a re-emit); link the
      // most recent by timestamp so the row points at the final result.
      const latest = rows.reduce((newest, row) =>
        (row.timestamp ?? "") >= (newest.timestamp ?? "") ? row : newest,
      );
      if (latest.id == null) return;
      await substrateClient.mutate(
        "updateTaskExecution",
        { id: taskExecutionId, workerResultId: String(latest.id) },
        { id: true },
      );
    } catch (err) {
      console.warn(
        `[swarm] Substrate linkTaskExecutionWorkerResult failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// readTaskExecutionCounts — aggregate counts for the run-summary axis
// ---------------------------------------------------------------------------

/** Options for {@link readTaskExecutionCounts}. */
export interface ReadTaskExecutionCountsOptions {
  /**
   * Scope the tally to these goal ids (the goals dispatched in the current run).
   * Omit (or pass empty) to count every TaskExecution row in the store.
   */
  goalIds?: string[];
}

/**
 * Aggregate TaskExecution counts for goal-6d's run summary. `total` is every
 * matched row; the status buckets count only rows whose `status` is one of the
 * documented {@link TaskExecutionEndStatus} values plus `running`. A `pending`
 * or otherwise-unrecognized status still contributes to `total` but to no
 * bucket — so the buckets need not sum to `total`.
 */
export interface TaskExecutionCounts {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  running: number;
}

/** A fresh zeroed counts object — the graceful-degradation return value. */
function zeroedTaskExecutionCounts(): TaskExecutionCounts {
  return { total: 0, completed: 0, failed: 0, blocked: 0, running: 0 };
}

/**
 * Read the `swarm/TaskExecution` rows and tally them by status for the
 * run-summary axis. When `goalIds` is supplied the count is scoped to those
 * goals — pushed to the substrate as one `where: { goalId: { eq } }` list query
 * per goal id, rather than pulling unrelated history. With no
 * `goalIds` it issues a single unfiltered query over all rows.
 *
 * Read-side analogue of the write helpers' contract: a Substrate failure logs a
 * non-blocking warning and resolves to a zeroed counts object rather than
 * throwing, so the run summary never blocks or crashes on a substrate hiccup.
 */
export async function readTaskExecutionCounts(
  substrateClient: SubstrateClient,
  { goalIds }: ReadTaskExecutionCountsOptions = {},
): Promise<TaskExecutionCounts> {
  try {
    const rows =
      goalIds && goalIds.length > 0
        ? (
            await Promise.all(
              goalIds.map(goalId =>
                substrateClient.query<{ status?: string }>(
                  "TaskExecution",
                  { where: { goalId: { eq: goalId } } },
                  { status: true },
                ),
              ),
            )
          ).flat()
        : await substrateClient.query<{ status?: string }>("TaskExecution", {}, { status: true });

    const counts = zeroedTaskExecutionCounts();
    for (const row of rows) {
      counts.total += 1;
      // Only the documented status strings move a bucket; anything else
      // (e.g. a seeded `pending`) counts toward `total` alone.
      switch (row.status) {
        case "completed":
          counts.completed += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        case "blocked":
          counts.blocked += 1;
          break;
        case "running":
          counts.running += 1;
          break;
      }
    }
    return counts;
  } catch (err) {
    console.warn(
      `[swarm] Substrate readTaskExecutionCounts failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
    return zeroedTaskExecutionCounts();
  }
}
