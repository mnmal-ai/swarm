/**
 * Goal/TaskExecution mirror — restart-durability harness (goal-9).
 *
 * The goal-9 mirror writes `swarm/Goal` and `swarm/TaskExecution` rows as a
 * fire-and-forget telemetry mirror of the orchestrator's in-memory dispatch
 * state. The memory-backed integration suite
 * (`tests/integration/task-execution-mirror.test.ts`) already proves the helpers
 * write/read/aggregate against a real sidecar. The one claim a memory store
 * CANNOT make is restart durability: a `memory` sidecar loses every row when it
 * stops, so a surviving mirror can only be demonstrated on Postgres.
 *
 * This file is that Postgres-backed harness. It spawns a Substrate sidecar
 * through the test setup's `startTestSubstrate()` with the swarm store on the
 * test stack's Postgres (`testPostgresUrl("cold")`: 42337, or a loopback
 * `SWARM_TEST_POSTGRES_URL` on that port — never the production
 * `SWARM_SUBSTRATE_POSTGRES_URL`), mirrors a Goal, stops it, spawns a SECOND
 * sidecar against the same Postgres, and reads the row back.
 *
 * E2E-gated (`SWARM_SDK_E2E=1`). When no Postgres answers it skips with the
 * reason rather than failing a durability claim it cannot observe.
 *
 * The single `it(...)` mirrors a Goal via `mirrorGoalStart` against sidecar #1,
 * simulates a crash by stopping it BEFORE any TaskExecution write, reboots
 * sidecar #2 against the same Postgres, and asserts the marker-matched Goal row
 * survived while NO TaskExecution row for this run's goalId was ever written.
 */

import { mirrorGoalStart } from "@mnmal-ai/swarm-orchestrator";
import { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { startTestSubstrate, stopTestSubstrate, type TestSubstrate } from "../setup/isolated-substrate.js";
import { testPostgresUrl } from "../setup/test-postgres.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

/**
 * Probe whether a Postgres is actually reachable at `url` with one trivial query
 * on a short-timeout, single-connection handle that is always `end()`-ed.
 * Returns false on any connect/query error.
 */
async function probePgReachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.end({ timeout: 5 });
    } catch {
      // never connected — nothing to drain.
    }
  }
}

// --- Per-test teardown (no orphaned sidecars) ----------------------------------

async function boot(pgUrl: string): Promise<TestSubstrate> {
  return startTestSubstrate({ meta: false, cortext: false, recall: "none", postgres: { cold: pgUrl } });
}

afterEach(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

const GOAL_FIELDS = { id: true, goalId: true, projectId: true, status: true, acceptanceCriteria: true } as const;

/** The `type` rows of `goalId`. */
async function readByGoal(
  client: SubstrateClient,
  type: "Goal" | "TaskExecution",
  goalId: string,
): Promise<Array<Record<string, unknown>>> {
  return client.query<Record<string, unknown>>(
    type,
    { where: { goalId: { eq: goalId } } },
    type === "Goal" ? GOAL_FIELDS : { id: true, goalId: true },
  );
}

/**
 * Poll for `goalId`'s Goal rows until at least one appears or the deadline
 * passes. `mirrorGoalStart` is fire-and-forget — it never resolves back to the
 * caller — so the only way to await it is to watch the store.
 */
async function pollForGoal(client: SubstrateClient, goalId: string, timeoutMs = 15000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matched = await readByGoal(client, "Goal", goalId);
    if (matched.length > 0) return matched;
    if (Date.now() >= deadline) return matched;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!RUN_E2E)(
  "Goal/TaskExecution mirror durability — survives a sidecar restart on Postgres",
  () => {
    it(
      "retains the mirrored Goal row after stop()+restart against the same Postgres, with no TaskExecution ever written",
      async (ctx) => {
        // Restart durability is observable only against a durable store: a
        // memory sidecar loses every row when it stops. When no Postgres answers
        // (no SWARM_SDK_PG=1 docker stack), skip rather than fail a claim we
        // cannot observe.
        const pgUrl = testPostgresUrl("cold");
        if (!(await probePgReachable(pgUrl))) {
          ctx.skip(
            `durability needs a reachable Postgres for the durable swarm store; none at ${pgUrl}. ` +
              "Bring up docker-compose.test.yml (alt-port 42337), e.g. with SWARM_SDK_PG=1, to exercise restart durability.",
          );
          return;
        }

        // Unique per-run marker embedded in the goalId so assertions stay robust
        // against rows prior runs left in the SHARED, persistent alt-port pg. We
        // never destructively wipe a shared store — we identify exactly this run's
        // row by marker.
        const marker = randomUUID();
        const goalId = `goal-durability-${marker}`;
        const timestamp = "2026-06-01T12:00:00.000Z";

        // --- Sidecar #1: mirror a Goal into the durable pg swarm store ----------
        const first = await boot(pgUrl);
        const writer = new SubstrateClient(first.cold.url);

        // Fire-and-forget create; match the param shape used by the memory-backed
        // mirror suite (task-execution-mirror.test.ts).
        mirrorGoalStart(writer, {
          goalId,
          projectId: "swarm",
          description: "Populate Goal/TaskExecution entities (durability)",
          priority: "high",
          status: "running",
          acceptanceCriteria: ["ac-1", "ac-2"],
          constraints: ["fire-and-forget"],
          dependsOn: ["goal-8"],
          timestamp,
        });

        // Await quiescence: mirrorGoalStart never resolves to us, so poll the pg
        // store until this run's Goal row lands, then assert it is present.
        const goalBefore = await pollForGoal(writer, goalId);
        expect(goalBefore).toHaveLength(1);
        expect(goalBefore[0]?.status).toBe("running");
        // Array fields round-trip through the plugin's string columns as JSON.
        expect(goalBefore[0]?.acceptanceCriteria).toBe('["ac-1","ac-2"]');

        // Simulate the crash BEFORE any TaskExecution write is issued — we never
        // call mirrorTaskExecutionStart, so no TaskExecution row was ever written.
        // The crash lands between createGoal and the first createTaskExecution.
        await first.stop();

        // --- Sidecar #2: restart against the SAME Postgres, fresh client --------
        const second = await boot(pgUrl);
        const reader = new SubstrateClient(second.cold.url);

        // The marker-matched Goal row survived the restart — durability proven.
        const goalAfter = await readByGoal(reader, "Goal", goalId);
        expect(goalAfter).toHaveLength(1);
        expect(goalAfter[0]?.goalId).toBe(goalId);
        expect(goalAfter[0]?.projectId).toBe("swarm");
        expect(goalAfter[0]?.status).toBe("running");

        // ...and NO TaskExecution scoped to this run's goalId exists: the crash
        // landed before the first createTaskExecution, so the mirror never wrote one.
        const teAfter = await readByGoal(reader, "TaskExecution", goalId);
        expect(teAfter).toHaveLength(0);
      },
      60000,
    );
  },
);
