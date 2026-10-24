/**
 * Tests for the DashboardServer REST API endpoints.
 *
 * Verifies:
 * 1. GET /api/tasks returns tasks from SessionState when no backend
 * 2. GET /api/tasks/:id returns single task
 * 3. PATCH /api/tasks/:id with pending task succeeds
 * 4. PATCH /api/tasks/:id with in_progress task returns 403
 * 5. PATCH /api/tasks/:id with completed task returns 403
 * 6. PATCH /api/tasks/:id with nonexistent task returns 404
 * 7. PATCH /api/tasks/:id broadcasts task:updated over WebSocket
 * 8. When TaskBackend is provided, GET /api/tasks merges backend data
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";
import type { Task, Goal, TaskUpdate, TaskResult, TaskBackend } from "@mnmal-ai/swarm-types";

// Use a high port to avoid conflicts
let nextPort = 14141;
function getPort(): number {
  return nextPort++;
}

/** Simple fetch wrapper for the test HTTP requests. */
async function apiFetch(port: number, path: string, options?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

/** Connect a WebSocket and wait for the initial state message. */
function connectWs(port: number, timeoutMs = 3000): Promise<{ ws: WebSocket; initialState: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for initial state")), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "state") {
        clearTimeout(timer);
        resolve({ ws, initialState: msg.payload });
      }
    });
  });
}

/** Wait for the next WebSocket message. */
function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Emit events to populate the dashboard with test tasks. */
function seedTasks(eventBus: SwarmEventBus, tasks: Array<{ id: string; description: string; intent: string; status?: string }>) {
  // Emit goal:decomposed to add tasks as pending
  eventBus.emit("goal:decomposed", {
    goalId: "test-goal",
    tasks: tasks.map(t => ({ id: t.id, description: t.description, intent: t.intent })),
    timestamp: Date.now(),
  });

  // Transition tasks that aren't pending
  for (const t of tasks) {
    if (t.status === "in_progress") {
      eventBus.emit("task:start", { taskId: t.id, goalId: "test-goal", description: t.description, intent: t.intent, timestamp: Date.now() });
    } else if (t.status === "completed") {
      eventBus.emit("task:start", { taskId: t.id, goalId: "test-goal", description: t.description, intent: t.intent, timestamp: Date.now() });
      eventBus.emit("task:verdict", { taskId: t.id, verdict: "approved", latencyMs: 100, retryCount: 0, timestamp: Date.now() });
    } else if (t.status === "failed") {
      eventBus.emit("task:start", { taskId: t.id, goalId: "test-goal", description: t.description, intent: t.intent, timestamp: Date.now() });
      eventBus.emit("task:verdict", { taskId: t.id, verdict: "rejected", latencyMs: 200, retryCount: 1, timestamp: Date.now() });
    }
  }
}

/** Create a mock TaskBackend for testing. */
function createMockBackend(tasks: Task[]): TaskBackend {
  const store = [...tasks];
  return {
    getGoals: async () => [],
    createGoal: async (goal: Goal) => goal.id,
    getTasks: async (goalId: string) => store.filter(t => t.goal_id === goalId),
    getAllTasks: async () => [...store],
    getTaskById: async (taskId: string) => store.find(t => t.id === taskId) ?? null,
    createTask: async (task: Task) => { store.push(task); return task.id; },
    updateTask: async (taskId: string, update: TaskUpdate) => {
      const t = store.find(t => t.id === taskId);
      if (!t) throw new Error("Not found");
      if (update.description !== undefined) t.description = update.description;
      if (update.status !== undefined) t.status = update.status;
      if (update.result !== undefined) t.result = update.result;
    },
    addComment: async () => {},
    escalate: async () => {},
  };
}

const servers: DashboardServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    await server.stop();
  }
  servers.length = 0;
});

describe("DashboardServer REST API: GET /api/tasks", () => {
  it("returns tasks from SessionState when no backend", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "First task", intent: "implementation" },
      { id: "task-2", description: "Second task", intent: "investigation" },
    ]);

    // Small delay for event processing
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    expect(res.status).toBe(200);

    const tasks = await res.json();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("task-1");
    expect(tasks[0].description).toBe("First task");
    expect(tasks[1].id).toBe("task-2");
  });

  it("returns empty array when no tasks exist", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    const res = await apiFetch(port, "/api/tasks");
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks).toHaveLength(0);
  });
});

describe("DashboardServer REST API: GET /api/tasks/:id", () => {
  it("returns single task by ID", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "First task", intent: "implementation" },
      { id: "task-2", description: "Second task", intent: "investigation" },
    ]);

    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-2");
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.id).toBe("task-2");
    expect(task.description).toBe("Second task");
  });

  it("returns 404 for nonexistent task", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    const res = await apiFetch(port, "/api/tasks/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DashboardServer REST API: PATCH /api/tasks/:id", () => {
  it("updates description of a pending task", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "Original description", intent: "implementation" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(res.status).toBe(200);

    const updated = await res.json();
    expect(updated.description).toBe("Updated description");

    // Verify the change persists in GET
    const getRes = await apiFetch(port, "/api/tasks/task-1");
    const fetched = await getRes.json();
    expect(fetched.description).toBe("Updated description");
  });

  it("returns 403 when editing in_progress task", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "In progress task", intent: "implementation", status: "in_progress" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Try to edit" }),
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain("in_progress");
  });

  it("returns 403 when editing completed task", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "Done task", intent: "implementation", status: "completed" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Try to edit" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when editing nonexistent task", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    const res = await apiFetch(port, "/api/tasks/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "New desc" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for empty description", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "Original", intent: "implementation" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("broadcasts task:updated over WebSocket", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "Original", intent: "implementation" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    // Connect a WS client
    const { ws } = await connectWs(port);

    // Patch the task and listen for the broadcast
    const msgPromise = waitForMessage(ws);
    await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated via API" }),
    });

    const msg = await msgPromise;
    expect(msg.type).toBe("task:updated");
    expect((msg.payload as Record<string, unknown>).taskId).toBe("task-1");
    expect((msg.payload as Record<string, unknown>).description).toBe("Updated via API");

    ws.close();
  });
});

describe("DashboardServer REST API: TaskBackend integration", () => {
  it("merges backend data with session state on GET /api/tasks", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();

    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Backend task 1", intent: "implementation", status: "pending", order: 1, subTaskIds: ["task-1a"], parentTaskId: undefined },
      { id: "task-2", goal_id: "goal-1", description: "Backend task 2", intent: "investigation", status: "completed", order: 2, result: { output: "done", latency_ms: 500, retry_count: 0, tokens: { freshInput: 5, cacheRead: 40, cacheWrite: 3, output: 2 } } },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    // Also seed session state with task-1 having in_progress status
    seedTasks(eventBus, [
      { id: "task-1", description: "Backend task 1", intent: "implementation", status: "in_progress" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    expect(res.status).toBe(200);

    const tasks = await res.json();
    expect(tasks.length).toBeGreaterThanOrEqual(2);

    // task-1 should have session state's in_progress status (overrides backend's pending)
    const t1 = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t1).toBeDefined();
    expect(t1.status).toBe("in_progress");
    expect(t1.goalId).toBe("goal-1");
    expect(t1.order).toBe(1);
    expect(t1.subTaskIds).toEqual(["task-1a"]);

    // task-2 should come from backend with its result data
    const t2 = tasks.find((t: Record<string, unknown>) => t.id === "task-2");
    expect(t2).toBeDefined();
    expect(t2.tokens).toEqual({ freshInput: 5, cacheRead: 40, cacheWrite: 3, output: 2 });
    expect(t2).not.toHaveProperty("costUsd");
  });

  it("writes through to backend on PATCH", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();

    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Original", intent: "implementation", status: "pending", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    seedTasks(eventBus, [
      { id: "task-1", description: "Original", intent: "implementation" },
    ]);
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated" }),
    });
    expect(res.status).toBe(200);

    // Verify backend was updated
    const backendTask = await backend.getTaskById("task-1");
    expect(backendTask?.description).toBe("Updated");
  });
});

// ---------------------------------------------------------------------------
// mergeOneTask terminal-status preference
//
// The reconcileTasks() frontend function in dashboard.html calls /api/tasks
// on a 5 s interval. Its correctness depends on mergeOneTask returning the
// right status — specifically, if the backend (tasks.json) has a terminal
// status and the session still shows a non-terminal status (stale in_progress
// after a missed task:verdict WebSocket event), the backend value must win.
// ---------------------------------------------------------------------------
describe("DashboardServer mergeOneTask terminal-status preference", () => {
  it("prefers backend terminal status over stale session in_progress", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();

    // Backend (tasks.json) has already marked the task completed
    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Task 1", intent: "implementation", status: "completed", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    // Session only saw goal:decomposed + task:start; task:verdict was never received
    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    expect(res.status).toBe(200);
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t).toBeDefined();
    // Backend's terminal "completed" must override session's stale "in_progress"
    expect(t.status).toBe("completed");
  });

  it("does not override session terminal status with same backend terminal status", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();

    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Task 1", intent: "implementation", status: "completed", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    // Session received task:verdict so it also knows the task completed
    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    eventBus.emit("task:verdict", { taskId: "task-1", verdict: "approved", latencyMs: 100, retryCount: 0, timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("completed");
  });

  it("prefers backend failed status over stale session in_progress", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();

    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Task 1", intent: "implementation", status: "failed", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    // Session stuck at in_progress — missed the task:verdict event
    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("failed");
  });

  it("task:verdict with rejected verdict sets status to failed in session state", async () => {
    // Verifies the WebSocket-path counterpart: when task:verdict fires with
    // rejected, the session marks the task failed (feeds into /api/tasks merge).
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    eventBus.emit("task:verdict", { taskId: "task-1", verdict: "rejected", latencyMs: 300, retryCount: 2, timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("failed");
    expect(t.verdict).toBe("rejected");
  });

  it("task:verdict with completed_with_notes sets status to completed_with_notes", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    eventBus.emit("task:verdict", { taskId: "task-1", verdict: "completed_with_notes", latencyMs: 200, retryCount: 0, timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("completed_with_notes");
    expect(t.verdict).toBe("completed_with_notes");
  });

  it("task:verdict with completed_with_deferrals sets status to completed_with_deferrals", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    eventBus.emit("task:verdict", { taskId: "task-1", verdict: "completed_with_deferrals", latencyMs: 200, retryCount: 0, timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("completed_with_deferrals");
    expect(t.verdict).toBe("completed_with_deferrals");
  });

  it("backend completed_with_notes preferred over stale session in_progress (reconcile path)", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Task 1", intent: "implementation", status: "completed_with_notes", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("completed_with_notes");
  });

  it("backend completed_with_deferrals preferred over stale session in_progress (reconcile path)", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const backendTasks: Task[] = [
      { id: "task-1", goal_id: "goal-1", description: "Task 1", intent: "implementation", status: "completed_with_deferrals", order: 1 },
    ];
    const backend = createMockBackend(backendTasks);
    const server = new DashboardServer(eventBus, port, backend);
    servers.push(server);

    eventBus.emit("goal:decomposed", { goalId: "goal-1", tasks: [{ id: "task-1", description: "Task 1", intent: "implementation" }], timestamp: Date.now() });
    eventBus.emit("task:start", { taskId: "task-1", goalId: "goal-1", description: "Task 1", intent: "implementation", timestamp: Date.now() });
    await new Promise(r => setTimeout(r, 50));

    const res = await apiFetch(port, "/api/tasks");
    const tasks = await res.json();
    const t = tasks.find((t: Record<string, unknown>) => t.id === "task-1");
    expect(t.status).toBe("completed_with_deferrals");
  });
});
