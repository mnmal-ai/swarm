import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import {
  mirrorGoalStart,
  mirrorTaskExecutionStart,
  mirrorTaskExecutionEnd,
  linkTaskExecutionWorkerResult,
  readTaskExecutionCounts,
} from "./task-execution-mirror.js";

// ---------------------------------------------------------------------------
// goal-9 — the orchestrator mirrors its in-memory dispatch state into the
// swarm/Goal and swarm/TaskExecution Substrate entities. These tests drive the
// helpers through a recording stub (the module only ever calls `.mutate`) and
// assert mutation names, param shaping (arrays JSON.stringify-ed, seeded
// workerResultId), id round-trip, and the never-throw fire-and-forget contract.
// ---------------------------------------------------------------------------

interface RecordedCall {
  mutationName: string;
  params: Record<string, unknown>;
}

/** A SubstrateClient whose `mutate` records calls and returns a canned row. */
function makeRecordingClient(returnRow: { id: string | number } = { id: "te-1" }): {
  client: SubstrateClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const mutate = vi.fn(async (mutationName: string, params: Record<string, unknown>) => {
    calls.push({ mutationName, params });
    return returnRow;
  });
  return { client: { mutate } as unknown as SubstrateClient, calls };
}

/** A SubstrateClient whose `mutate` always rejects — exercises the failure path. */
function makeRejectingClient(message = "boom"): SubstrateClient {
  return { mutate: vi.fn(async () => Promise.reject(new Error(message))) } as unknown as SubstrateClient;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.clearAllMocks();
});

describe("mirrorGoalStart", () => {
  it("calls createGoal with array fields JSON-stringified and status passed through", () => {
    const { client, calls } = makeRecordingClient();

    mirrorGoalStart(client, {
      goalId: "goal-9",
      projectId: "swarm",
      description: "Populate Goal/TaskExecution entities",
      priority: "high",
      status: "running",
      acceptanceCriteria: ["ac-1", "ac-2"],
      constraints: ["fire-and-forget"],
      dependsOn: ["goal-8"],
      timestamp: "2026-06-01T12:00:00.000Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].mutationName).toBe("createGoal");
    expect(calls[0].params).toEqual({
      goalId: "goal-9",
      projectId: "swarm",
      description: "Populate Goal/TaskExecution entities",
      priority: "high",
      status: "running",
      acceptanceCriteria: '["ac-1","ac-2"]',
      constraints: '["fire-and-forget"]',
      dependsOn: '["goal-8"]',
      timestamp: "2026-06-01T12:00:00.000Z",
    });
  });

  it("serializes empty arrays as [] rather than dropping the fields", () => {
    const { client, calls } = makeRecordingClient();

    mirrorGoalStart(client, {
      goalId: "goal-1",
      projectId: "swarm",
      description: "d",
      priority: "low",
      status: "pending",
      acceptanceCriteria: [],
      constraints: [],
      dependsOn: [],
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    expect(calls[0].params.acceptanceCriteria).toBe("[]");
    expect(calls[0].params.constraints).toBe("[]");
    expect(calls[0].params.dependsOn).toBe("[]");
  });

  it("never throws and logs a warning when the mutation rejects", async () => {
    const client = makeRejectingClient();

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

    // The rejection is handled asynchronously; wait for the warn to land.
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0][0])).toContain("createGoal");
  });
});

describe("mirrorTaskExecutionStart", () => {
  it("calls createTaskExecution with a seeded empty workerResultId and returns the row id", async () => {
    const { client, calls } = makeRecordingClient({ id: "te-42" });

    const id = await mirrorTaskExecutionStart(client, {
      goalId: "goal-9",
      sessionId: "sess-1",
      status: "running",
      retries: 0,
      startedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(id).toBe("te-42");
    expect(calls).toHaveLength(1);
    expect(calls[0].mutationName).toBe("createTaskExecution");
    expect(calls[0].params).toEqual({
      goalId: "goal-9",
      sessionId: "sess-1",
      workerResultId: "",
      status: "running",
      retries: 0,
      startedAt: "2026-06-01T12:00:00.000Z",
    });
  });

  it("coerces a numeric row id to a string", async () => {
    const { client } = makeRecordingClient({ id: 7 });

    const id = await mirrorTaskExecutionStart(client, {
      goalId: "goal-1",
      sessionId: "sess-1",
      status: "running",
      retries: 1,
      startedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(id).toBe("7");
  });

  it("resolves to null (not throw) when the mutation rejects, and warns", async () => {
    const client = makeRejectingClient("dataset offline");

    const id = await mirrorTaskExecutionStart(client, {
      goalId: "goal-9",
      sessionId: "sess-1",
      status: "running",
      retries: 0,
      startedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(id).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("createTaskExecution");
  });
});

describe("mirrorTaskExecutionEnd", () => {
  it("calls updateTaskExecution flipping status and stamping completedAt", () => {
    const { client, calls } = makeRecordingClient();

    mirrorTaskExecutionEnd(client, "te-42", {
      status: "completed",
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: 2,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].mutationName).toBe("updateTaskExecution");
    expect(calls[0].params).toEqual({
      id: "te-42",
      status: "completed",
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: 2,
    });
  });

  it("includes workerResultId in the update when provided", () => {
    const { client, calls } = makeRecordingClient();

    mirrorTaskExecutionEnd(client, "te-42", {
      status: "failed",
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: 3,
      workerResultId: "wr-9",
    });

    expect(calls[0].params).toEqual({
      id: "te-42",
      status: "failed",
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: 3,
      workerResultId: "wr-9",
    });
  });

  it("omits workerResultId entirely when not provided (does not overwrite with undefined)", () => {
    const { client, calls } = makeRecordingClient();

    mirrorTaskExecutionEnd(client, "te-42", {
      status: "blocked",
      completedAt: "2026-06-01T12:05:00.000Z",
      retries: 0,
    });

    expect("workerResultId" in calls[0].params).toBe(false);
  });

  it("never throws and warns when the update rejects", async () => {
    const client = makeRejectingClient();

    expect(() =>
      mirrorTaskExecutionEnd(client, "te-42", {
        status: "completed",
        completedAt: "2026-06-01T12:05:00.000Z",
        retries: 0,
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0][0])).toContain("updateTaskExecution");
  });
});

// ---------------------------------------------------------------------------
// linkTaskExecutionWorkerResult — best-effort follow-up that resolves the
// WorkerResult persisted for a worker session and stamps its id onto the
// terminal TaskExecution row. Drives a combined query+mutate stub; asserts the
// query/update shaping, most-recent selection, the no-op guards, and the
// never-throw fire-and-forget contract.
// ---------------------------------------------------------------------------

/**
 * A SubstrateClient that records both `query` and `mutate`. `query` returns the
 * supplied WorkerResult rows (or rejects when `queryError` is set); `mutate`
 * records the call (or rejects when `mutateError` is set).
 */
function makeLinkClient(opts: {
  rows?: Array<{ id: string | number; timestamp?: string }>;
  queryError?: boolean;
  mutateError?: boolean;
}): {
  client: SubstrateClient;
  queries: RecordedQuery[];
  mutations: RecordedCall[];
} {
  const queries: RecordedQuery[] = [];
  const mutations: RecordedCall[] = [];
  const query = vi.fn(async (typeName: string, params: Record<string, unknown>) => {
    queries.push({ typeName, params });
    if (opts.queryError) throw new Error("query offline");
    return opts.rows ?? [];
  });
  const mutate = vi.fn(async (mutationName: string, params: Record<string, unknown>) => {
    mutations.push({ mutationName, params });
    if (opts.mutateError) throw new Error("mutate offline");
    return { id: params.id };
  });
  return { client: { query, mutate } as unknown as SubstrateClient, queries, mutations };
}

describe("linkTaskExecutionWorkerResult", () => {
  it("queries WorkerResult by sessionId then stamps the resolved id via updateTaskExecution", async () => {
    const { client, queries, mutations } = makeLinkClient({
      rows: [{ id: "wr-7", timestamp: "2026-06-01T12:00:00.000Z" }],
    });

    linkTaskExecutionWorkerResult(client, "te-42", "sess-1");

    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(queries).toHaveLength(1);
    expect(queries[0].typeName).toBe("WorkerResult");
    // Operator-keyed: Substrate refuses a bare `{ sessionId }` (unknown_param).
    expect(queries[0].params).toEqual({ where: { sessionId: { eq: "sess-1" } } });
    expect(mutations[0].mutationName).toBe("updateTaskExecution");
    // Only the id + the link are sent — field-disjoint from the terminal flip.
    expect(mutations[0].params).toEqual({ id: "te-42", workerResultId: "wr-7" });
  });

  it("links the most recent WorkerResult when a session carries several", async () => {
    const { client, mutations } = makeLinkClient({
      rows: [
        { id: "wr-old", timestamp: "2026-06-01T12:00:00.000Z" },
        { id: "wr-new", timestamp: "2026-06-01T12:05:00.000Z" },
        { id: "wr-mid", timestamp: "2026-06-01T12:02:00.000Z" },
      ],
    });

    linkTaskExecutionWorkerResult(client, "te-42", "sess-1");

    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0].params.workerResultId).toBe("wr-new");
  });

  it("coerces a numeric WorkerResult id to a string", async () => {
    const { client, mutations } = makeLinkClient({ rows: [{ id: 9 }] });

    linkTaskExecutionWorkerResult(client, "te-42", "sess-1");

    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0].params.workerResultId).toBe("9");
  });

  it("does not update when no WorkerResult row matches the session", async () => {
    const { client, queries, mutations } = makeLinkClient({ rows: [] });

    linkTaskExecutionWorkerResult(client, "te-42", "sess-1");

    // Let any pending microtasks flush, then assert the query ran but no update.
    await Promise.resolve();
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    expect(mutations).toHaveLength(0);
  });

  it("is a no-op (no query) when the sessionId is empty", async () => {
    const { client, queries, mutations } = makeLinkClient({ rows: [{ id: "wr-1" }] });

    linkTaskExecutionWorkerResult(client, "te-42", "");

    await Promise.resolve();
    expect(queries).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  it("never throws and warns when the WorkerResult query rejects", async () => {
    const { client, mutations } = makeLinkClient({ queryError: true });

    expect(() => linkTaskExecutionWorkerResult(client, "te-42", "sess-1")).not.toThrow();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0][0])).toContain("linkTaskExecutionWorkerResult");
    expect(mutations).toHaveLength(0);
  });

  it("never throws and warns when the updateTaskExecution mutation rejects", async () => {
    const { client } = makeLinkClient({
      rows: [{ id: "wr-7" }],
      mutateError: true,
    });

    expect(() => linkTaskExecutionWorkerResult(client, "te-42", "sess-1")).not.toThrow();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0][0])).toContain("linkTaskExecutionWorkerResult");
  });
});

// ---------------------------------------------------------------------------
// readTaskExecutionCounts — read-side aggregate for goal-6d's run summary.
// Drives a query-recording stub; asserts status tallying, goalId scoping
// (one filtered query per id), and the never-throw zeroed-fallback contract.
// ---------------------------------------------------------------------------

interface RecordedQuery {
  typeName: string;
  params: Record<string, unknown>;
}

/**
 * A SubstrateClient whose `query` records each call and returns the rows the test
 * supplies — either a fixed list (unfiltered case) or a per-goalId map (scoped
 * case, keyed by the `where: { goalId: { eq } }` predicate).
 */
function makeQueryClient(
  rows: Array<{ status?: string }> | Record<string, Array<{ status?: string }>>,
): { client: SubstrateClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const query = vi.fn(async (typeName: string, params: Record<string, unknown>) => {
    queries.push({ typeName, params });
    if (Array.isArray(rows)) return rows;
    const where = params.where as { goalId?: { eq?: string } } | undefined;
    const goalId = where?.goalId?.eq;
    return goalId !== undefined ? (rows[goalId] ?? []) : [];
  });
  return { client: { query } as unknown as SubstrateClient, queries };
}

describe("readTaskExecutionCounts", () => {
  it("tallies every row by status with no goalIds filter (single unfiltered query)", async () => {
    const { client, queries } = makeQueryClient([
      { status: "completed" },
      { status: "completed" },
      { status: "failed" },
      { status: "blocked" },
      { status: "running" },
    ]);

    const counts = await readTaskExecutionCounts(client);

    expect(counts).toEqual({ total: 5, completed: 2, failed: 1, blocked: 1, running: 1 });
    expect(queries).toHaveLength(1);
    expect(queries[0].typeName).toBe("TaskExecution");
    expect(queries[0].params).toEqual({});
  });

  it("scopes to the provided goalIds with one equality-filtered query each", async () => {
    const { client, queries } = makeQueryClient({
      "goal-1": [{ status: "completed" }, { status: "running" }],
      "goal-2": [{ status: "failed" }],
    });

    const counts = await readTaskExecutionCounts(client, { goalIds: ["goal-1", "goal-2"] });

    expect(counts).toEqual({ total: 3, completed: 1, failed: 1, blocked: 0, running: 1 });
    expect(queries).toHaveLength(2);
    expect(queries.map(q => q.params)).toEqual([
      { where: { goalId: { eq: "goal-1" } } },
      { where: { goalId: { eq: "goal-2" } } },
    ]);
  });

  it("treats an empty goalIds array as unfiltered", async () => {
    const { client, queries } = makeQueryClient([{ status: "completed" }]);

    const counts = await readTaskExecutionCounts(client, { goalIds: [] });

    expect(counts.total).toBe(1);
    expect(queries[0].params).toEqual({});
  });

  it("counts unrecognized or pending statuses toward total only, not a bucket", async () => {
    const { client } = makeQueryClient([
      { status: "pending" },
      { status: "completed" },
      { status: undefined },
      { status: "bogus" },
    ]);

    const counts = await readTaskExecutionCounts(client);

    expect(counts).toEqual({ total: 4, completed: 1, failed: 0, blocked: 0, running: 0 });
  });

  it("returns zeroed counts (not throw) and warns when the query rejects", async () => {
    const client = {
      query: vi.fn(async () => Promise.reject(new Error("dataset offline"))),
    } as unknown as SubstrateClient;

    const counts = await readTaskExecutionCounts(client, { goalIds: ["goal-1"] });

    expect(counts).toEqual({ total: 0, completed: 0, failed: 0, blocked: 0, running: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("readTaskExecutionCounts");
  });
});
