/**
 * DashboardServer carries the token split into its state snapshot.
 *
 * The live page shows tokens: per session and per task, fresh input apart
 * from cache reads and cache writes, plus output. The server keeps that split
 * from `tokens:update` and `task:verdict`, hands it to every new WebSocket
 * client in the state snapshot along with the session token limit, and holds
 * no dollar figure. A payload missing a field leaves the previous value.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";
import type { Goal, Task, TaskBackend, TaskUpdate } from "@mnmal-ai/swarm-types";

let nextPort = 16141;
function getPort(): number {
  return nextPort++;
}

/** Connect a WebSocket and resolve with the initial state snapshot. */
function snapshot(port: number, timeoutMs = 3000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for initial state")), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "state") {
        clearTimeout(timer);
        ws.close();
        resolve(msg.payload);
      }
    });
  });
}

const servers: DashboardServer[] = [];

function startServer(backend?: TaskBackend): { port: number; bus: SwarmEventBus; server: DashboardServer } {
  const port = getPort();
  const bus = new SwarmEventBus();
  const server = new DashboardServer(bus, port, backend);
  servers.push(server);
  return { port, bus, server };
}

afterEach(async () => {
  for (const server of servers) await server.stop();
  servers.length = 0;
});

const TASK_TOKENS = { freshInput: 1_200, cacheRead: 48_000, cacheWrite: 3_100, output: 900 };
const SESSION_TOKENS = { freshInput: 5_000, cacheRead: 210_000, cacheWrite: 9_000, output: 4_200 };

describe("DashboardServer token state", () => {
  it("starts with a zero token split, no token limit and no dollar fields", async () => {
    const { port } = startServer();

    const state = await snapshot(port);

    expect(state.tokens).toEqual({ freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    expect(state.tokenLimit).toBe(0);
    expect(state).not.toHaveProperty("costUsd");
    expect(state).not.toHaveProperty("costLimitUsd");
  });

  it("takes the session token limit from setProject", async () => {
    const { port, server } = startServer();

    server.setProject("sample-project", 2_000_000);

    expect((await snapshot(port)).tokenLimit).toBe(2_000_000);
  });

  it("keeps the session split and token limit from tokens:update", async () => {
    const { port, bus } = startServer();

    bus.emit("tokens:update", {
      cumulativeTokens: 228_200,
      tokens: SESSION_TOKENS,
      sessionTokenLimit: 500_000,
      percentUsed: 45.64,
      timestamp: Date.now(),
    });

    const state = await snapshot(port);
    expect(state.tokens).toEqual(SESSION_TOKENS);
    expect(state.cumulativeTokens).toBe(228_200);
    expect(state.tokenLimit).toBe(500_000);
  });

  it("leaves the split and limit in place when a tokens:update payload omits them", async () => {
    const { port, bus, server } = startServer();
    server.setProject("sample-project", 500_000);
    bus.emit("tokens:update", {
      cumulativeTokens: 228_200,
      tokens: SESSION_TOKENS,
      sessionTokenLimit: 500_000,
      percentUsed: 45.64,
      timestamp: Date.now(),
    });

    (bus as unknown as { emit(e: string, p: unknown): void }).emit("tokens:update", { cumulativeTokens: 300_000, percentUsed: 60, timestamp: Date.now() });

    const state = await snapshot(port);
    expect(state.tokens).toEqual(SESSION_TOKENS);
    expect(state.tokenLimit).toBe(500_000);
  });

  it("stores each task's split from task:verdict", async () => {
    const { port, bus } = startServer();
    bus.emit("goal:decomposed", {
      goalId: "goal-1",
      tasks: [{ id: "goal-1-task-1", description: "Add the widget", intent: "implementation" }],
      timestamp: Date.now(),
    });

    bus.emit("task:verdict", {
      taskId: "goal-1-task-1",
      verdict: "approved",
      latencyMs: 1_000,
      retryCount: 0,
      tokens: TASK_TOKENS,
      timestamp: Date.now(),
    });

    const task = (await snapshot(port)).tasks.find((t: { id: string }) => t.id === "goal-1-task-1");
    expect(task.tokens).toEqual(TASK_TOKENS);
  });

  it("adds what a split task spent (its run and the decomposition call) to that task, from task:aborted", async () => {
    const { port, bus } = startServer();
    bus.emit("goal:decomposed", {
      goalId: "goal-1",
      tasks: [{ id: "goal-1-task-1", description: "Add the widget", intent: "implementation" }],
      timestamp: Date.now(),
    });

    bus.emit("task:aborted", { taskId: "goal-1-task-1", reason: "timeout", subTaskCount: 2, tokens: TASK_TOKENS, timestamp: Date.now() });
    bus.emit("task:aborted", { taskId: "goal-1-task-1", reason: "timeout", subTaskCount: 2, tokens: TASK_TOKENS, timestamp: Date.now() });
    bus.emit("task:aborted", { taskId: "goal-1-task-1", reason: "timeout", subTaskCount: 2, timestamp: Date.now() });

    const task = (await snapshot(port)).tasks.find((t: { id: string }) => t.id === "goal-1-task-1");
    expect(task.tokens).toEqual({ freshInput: 2_400, cacheRead: 96_000, cacheWrite: 6_200, output: 1_800 });
  });

  it("fills a task's split from the backend's task record when the session never saw its verdict", async () => {
    const record: Task = {
      id: "goal-1-task-1",
      goal_id: "goal-1",
      description: "Add the widget",
      intent: "implementation",
      status: "completed",
      result: { output: "done", latency_ms: 1_000, retry_count: 0, tokens: TASK_TOKENS },
    };
    const backend: TaskBackend = {
      getGoals: async () => [],
      createGoal: async (goal: Goal) => goal.id,
      getTasks: async () => [record],
      getAllTasks: async () => [record],
      getTaskById: async () => record,
      createTask: async (task: Task) => task.id,
      updateTask: async (_id: string, _update: TaskUpdate) => {},
      addComment: async () => {},
      escalate: async () => {},
    };
    const { port } = startServer(backend);

    const tasks = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();

    expect(tasks[0].tokens).toEqual(TASK_TOKENS);
  });
});
