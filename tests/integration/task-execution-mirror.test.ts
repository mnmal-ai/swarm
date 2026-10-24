import { randomUUID } from "node:crypto";
import {
	mirrorGoalStart,
	mirrorTaskExecutionEnd,
	mirrorTaskExecutionStart,
	readTaskExecutionCounts,
} from "@mnmal-ai/swarm-orchestrator";
import { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { E2E_SKIP_REASON, startTestSubstrate, stopTestSubstrate, type TestSubstrate } from "../setup/isolated-substrate.js";

/**
 * Integration harness for the goal-9 Goal/TaskExecution mirror.
 *
 * Drives the mirror helpers through a REAL SubstrateClient against a spawned
 * Substrate sidecar running the swarm plugin (this suite's own, on the memory
 * store): rows are really written, really read back, and really aggregated
 * through the plugin's autoCRUD surface, proving the helpers are wired to the
 * Goal/TaskExecution types the plugin actually registers.
 *
 * Each test scopes its rows by its own goal ids, so tests share the sidecar.
 * The sidecar-backed cases run only under SWARM_SDK_E2E=1.
 *
 * The mock-stub unit suite at
 * packages/orchestrator/src/learning/task-execution-mirror.test.ts already pins
 * param shaping and the never-throw contract through recording stubs; the
 * failure-path cases at the end of this file keep their stub clients.
 */

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

let substrate: TestSubstrate | undefined;

beforeAll(async () => {
	if (!RUN_E2E) return;
	substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "none" });
});

afterAll(async () => {
	// Every pair this file started, including one still booting after a timeout.
	await stopTestSubstrate();
});

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

const GOAL_FIELDS = {
	id: true,
	goalId: true,
	projectId: true,
	priority: true,
	status: true,
	acceptanceCriteria: true,
	constraints: true,
	dependsOn: true,
} as const;

/**
 * A SubstrateClient on this suite's sidecar. `settle()` awaits the
 * fire-and-forget mutations the void helpers launch but never await, so reads
 * see a quiesced store.
 */
function makeSidecarClient(): { client: SubstrateClient; settle: () => Promise<unknown> } {
	const real = new SubstrateClient((substrate as TestSubstrate).cold.url);
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

/** A goal id no other test uses. */
function uniqueGoalId(label = "goal"): string {
	return `${label}-${randomUUID()}`;
}

/** Every `type` row whose goalId is one of `goalIds`. */
async function readByGoal(
	client: SubstrateClient,
	type: "Goal" | "TaskExecution",
	...goalIds: string[]
): Promise<Array<Record<string, unknown>>> {
	return client.query<Record<string, unknown>>(
		type,
		{ where: { goalId: { in: goalIds } } },
		type === "Goal" ? GOAL_FIELDS : TASK_EXECUTION_FIELDS,
	);
}

const VALID_STATUSES = ["pending", "running", "completed", "failed", "blocked"];

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	// The fire-and-forget failure paths log a non-blocking warning; silence it so
	// the suite output stays clean, and assert on it where it matters.
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warnSpy.mockRestore();
});

describe.skipIf(!RUN_E2E)(`task-execution mirror against a real Substrate sidecar (${E2E_SKIP_REASON})`, () => {
	it("publishes the Goal/TaskExecution CRUD ops the helpers dispatch to", async () => {
		const { client } = makeSidecarClient();
		const schema = await client.getSchema();
		const swarm = schema.namespaces.swarm;

		// Criterion: the helpers must be wired to the ops the plugin actually
		// registers into the namespace — not to a private mock surface.
		expect(Object.keys(swarm.mutations)).toEqual(
			expect.arrayContaining(["createGoal", "createTaskExecution", "updateTaskExecution"]),
		);
		// The list queries are keyed by the bare type name.
		expect(Object.keys(swarm.types)).toEqual(expect.arrayContaining(["TaskExecution", "Goal"]));
	});

	it("mirrorGoalStart writes a Goal row with arrays stringified and a valid status", async () => {
		const { client, settle } = makeSidecarClient();
		const goalId = uniqueGoalId();

		mirrorGoalStart(client, {
			goalId,
			projectId: "swarm",
			description: "Populate Goal/TaskExecution entities",
			priority: "high",
			status: "running",
			acceptanceCriteria: ["ac-1", "ac-2"],
			constraints: ["fire-and-forget"],
			dependsOn: ["goal-8"],
			timestamp: "2026-06-01T12:00:00.000Z",
		});
		await settle();

		const [goal] = await readByGoal(client, "Goal", goalId);
		expect(goal).toBeDefined();
		expect(goal.goalId).toBe(goalId);
		expect(goal.projectId).toBe("swarm");
		expect(goal.priority).toBe("high");
		// Array fields round-trip through the plugin's string columns as JSON.
		expect(goal.acceptanceCriteria).toBe('["ac-1","ac-2"]');
		expect(goal.constraints).toBe('["fire-and-forget"]');
		expect(goal.dependsOn).toBe('["goal-8"]');
		expect(JSON.parse(goal.acceptanceCriteria as string)).toEqual([
			"ac-1",
			"ac-2",
		]);
		// Status is one of the documented values, never an invented string.
		expect(goal.status).toBe("running");
		expect(VALID_STATUSES).toContain(goal.status);
	});

	it("mirrorTaskExecutionStart writes a running TaskExecution and returns its id", async () => {
		const { client } = makeSidecarClient();
		const goalId = uniqueGoalId();

		// The start helper awaits the create, so the id is back before it resolves.
		const id = await mirrorTaskExecutionStart(client, {
			goalId,
			sessionId: "sess-1",
			status: "running",
			retries: 0,
			startedAt: "2026-06-01T12:00:00.000Z",
		});

		expect(id).toBeTruthy();
		expect(typeof id).toBe("string");

		const [row] = await readByGoal(client, "TaskExecution", goalId);
		expect(row).toBeDefined();
		expect(String(row.id)).toBe(id);
		expect(row.goalId).toBe(goalId);
		expect(row.sessionId).toBe("sess-1");
		expect(row.status).toBe("running");
		expect(VALID_STATUSES).toContain(row.status);
		// workerResultId is seeded empty at dispatch; the WorkerResult id is unknown
		// until the worker returns.
		expect(row.workerResultId).toBe("");
		// No terminal stamp yet.
		expect(row.completedAt == null).toBe(true);
	});

	it("mirrorTaskExecutionEnd flips the row terminal and stamps completedAt + workerResultId", async () => {
		const { client, settle } = makeSidecarClient();
		const goalId = uniqueGoalId();

		const id = await mirrorTaskExecutionStart(client, {
			goalId,
			sessionId: "sess-1",
			status: "running",
			retries: 0,
			startedAt: "2026-06-01T12:00:00.000Z",
		});
		expect(id).not.toBeNull();

		mirrorTaskExecutionEnd(client, id as string, {
			status: "completed",
			completedAt: "2026-06-01T12:05:00.000Z",
			retries: 2,
			workerResultId: "wr-42",
		});
		await settle();

		const rows = await readByGoal(client, "TaskExecution", goalId);
		// The end was an UPDATE, not a second insert.
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(String(row.id)).toBe(id);
		expect(row.status).toBe("completed");
		expect(row.completedAt).toBe("2026-06-01T12:05:00.000Z");
		expect(row.workerResultId).toBe("wr-42");
		expect(row.retries).toBe(2);
		// The merge preserved the create-time fields the update never sent.
		expect(row.goalId).toBe(goalId);
		expect(row.sessionId).toBe("sess-1");
		expect(row.startedAt).toBe("2026-06-01T12:00:00.000Z");
	});

	it("mirrorTaskExecutionEnd supports failed and blocked terminal states", async () => {
		const { client, settle } = makeSidecarClient();
		const goalA = uniqueGoalId("goal-a");
		const goalB = uniqueGoalId("goal-b");

		for (const [goalId, status] of [
			[goalA, "failed"],
			[goalB, "blocked"],
		] as const) {
			const id = await mirrorTaskExecutionStart(client, {
				goalId,
				sessionId: `sess-${goalId}`,
				status: "running",
				retries: 0,
				startedAt: "2026-06-01T12:00:00.000Z",
			});
			mirrorTaskExecutionEnd(client, id as string, {
				status,
				completedAt: "2026-06-01T12:05:00.000Z",
				retries: 1,
			});
		}
		await settle();

		const rows = await readByGoal(client, "TaskExecution", goalA, goalB);
		const byGoal = new Map(rows.map((r) => [r.goalId, r]));
		expect(byGoal.get(goalA)?.status).toBe("failed");
		expect(byGoal.get(goalB)?.status).toBe("blocked");
		// workerResultId was not supplied — the seeded empty value is left untouched.
		expect(byGoal.get(goalA)?.workerResultId).toBe("");
	});

	it("readTaskExecutionCounts aggregates the whole store when no goalIds are scoped", async () => {
		const { client, settle } = makeSidecarClient();
		const [g1, g2, g3] = [uniqueGoalId("goal-1"), uniqueGoalId("goal-2"), uniqueGoalId("goal-3")];
		// The store is shared by this file's tests, so the unscoped tally is
		// checked as the change these writes make to it.
		await settle();
		const before = await readTaskExecutionCounts(client);

		// Two completed, one failed, one blocked, one left running.
		const plan: Array<{
			goalId: string;
			end?: "completed" | "failed" | "blocked";
		}> = [
			{ goalId: g1, end: "completed" },
			{ goalId: g1, end: "completed" },
			{ goalId: g2, end: "failed" },
			{ goalId: g2, end: "blocked" },
			{ goalId: g3 }, // stays running
		];
		for (const [i, t] of plan.entries()) {
			const id = await mirrorTaskExecutionStart(client, {
				goalId: t.goalId,
				sessionId: `sess-${i}`,
				status: "running",
				retries: 0,
				startedAt: "2026-06-01T12:00:00.000Z",
			});
			if (t.end) {
				mirrorTaskExecutionEnd(client, id as string, {
					status: t.end,
					completedAt: "2026-06-01T12:05:00.000Z",
					retries: 0,
				});
			}
		}
		await settle();

		const after = await readTaskExecutionCounts(client);
		expect({
			total: after.total - before.total,
			completed: after.completed - before.completed,
			failed: after.failed - before.failed,
			blocked: after.blocked - before.blocked,
			running: after.running - before.running,
		}).toEqual({
			total: 5,
			completed: 2,
			failed: 1,
			blocked: 1,
			running: 1,
		});
	});

	it("readTaskExecutionCounts scopes the tally to the supplied goalIds", async () => {
		const { client, settle } = makeSidecarClient();
		const [g1, g2, g3] = [uniqueGoalId("goal-1"), uniqueGoalId("goal-2"), uniqueGoalId("goal-3")];

		const plan: Array<{
			goalId: string;
			end?: "completed" | "failed" | "blocked";
		}> = [
			{ goalId: g1, end: "completed" },
			{ goalId: g1 }, // running
			{ goalId: g2, end: "failed" },
			{ goalId: g3, end: "blocked" }, // excluded by the scope below
		];
		for (const [i, t] of plan.entries()) {
			const id = await mirrorTaskExecutionStart(client, {
				goalId: t.goalId,
				sessionId: `sess-${i}`,
				status: "running",
				retries: 0,
				startedAt: "2026-06-01T12:00:00.000Z",
			});
			if (t.end) {
				mirrorTaskExecutionEnd(client, id as string, {
					status: t.end,
					completedAt: "2026-06-01T12:05:00.000Z",
					retries: 0,
				});
			}
		}
		await settle();

		// goal-3 (blocked) is outside the scope, so it must not appear in the tally.
		const counts = await readTaskExecutionCounts(client, {
			goalIds: [g1, g2],
		});
		expect(counts).toEqual({
			total: 3,
			completed: 1,
			failed: 1,
			blocked: 0,
			running: 1,
		});
	});

});

describe("task-execution mirror failure paths (stub clients)", () => {
	// -------------------------------------------------------------------------
	// Fire-and-forget contract: a substrate failure must degrade gracefully —
	// the helper resolves (null / zeroed counts) and never throws, so a
	// Substrate hiccup can never block or crash the orchestrator's hot path.
	// -------------------------------------------------------------------------

	/** A client whose ops always reject — a stand-in for a substrate outage. */
	function makeFailingClient(): SubstrateClient {
		return {
			mutate: vi.fn(async () => Promise.reject(new Error("substrate offline"))),
			query: vi.fn(async () => Promise.reject(new Error("substrate offline"))),
		} as unknown as SubstrateClient;
	}

	it("mirrorGoalStart does not throw when the create mutation fails", async () => {
		const client = makeFailingClient();

		expect(() =>
			mirrorGoalStart(client, {
				goalId: "goal-9",
				projectId: "swarm",
				description: "d",
				priority: "high",
				status: "running",
				acceptanceCriteria: [],
				constraints: [],
				dependsOn: [],
				timestamp: "2026-06-01T12:00:00.000Z",
			}),
		).not.toThrow();

		await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
		expect(String(warnSpy.mock.calls[0][0])).toContain("createGoal");
	});

	it("mirrorTaskExecutionStart resolves to null (not throw) when the create fails", async () => {
		const client = makeFailingClient();

		const id = await mirrorTaskExecutionStart(client, {
			goalId: "goal-9",
			sessionId: "sess-1",
			status: "running",
			retries: 0,
			startedAt: "2026-06-01T12:00:00.000Z",
		});

		expect(id).toBeNull();
		expect(warnSpy).toHaveBeenCalled();
		expect(String(warnSpy.mock.calls[0][0])).toContain("createTaskExecution");
	});

	it("mirrorTaskExecutionEnd does not throw when the update fails", async () => {
		const client = makeFailingClient();

		expect(() =>
			mirrorTaskExecutionEnd(client, "te-1", {
				status: "completed",
				completedAt: "2026-06-01T12:05:00.000Z",
				retries: 0,
			}),
		).not.toThrow();

		await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
		expect(String(warnSpy.mock.calls[0][0])).toContain("updateTaskExecution");
	});

	it("readTaskExecutionCounts returns zeroed counts (not throw) when the query fails", async () => {
		const client = makeFailingClient();

		const counts = await readTaskExecutionCounts(client, {
			goalIds: ["goal-1"],
		});

		expect(counts).toEqual({
			total: 0,
			completed: 0,
			failed: 0,
			blocked: 0,
			running: 0,
		});
		expect(warnSpy).toHaveBeenCalled();
		expect(String(warnSpy.mock.calls[0][0])).toContain(
			"readTaskExecutionCounts",
		);
	});
});
