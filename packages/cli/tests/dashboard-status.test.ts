/**
 * The live dashboard says what swarm is doing right now, in the header:
 * preparing context (with how many synopses are written), planning a goal,
 * working on a task, reviewing it, or between tasks, with how long it has been
 * at it. A page opened part way through gets the same from the server's state
 * snapshot. Renders the real page in jsdom, as dashboard-goal-link.test.ts does.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";

const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");

const doms: JSDOM[] = [];
afterEach(() => {
  for (const dom of doms) dom.window.close();
  doms.length = 0;
});

type Sent = { type: string; payload: unknown; timestamp?: number };

async function open(): Promise<{ send: (...events: Sent[]) => Promise<void>; status: () => string }> {
  let socket: { onopen?: () => void; onmessage?: (ev: { data: string }) => void } | undefined;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:3141/",
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>;
      w.WebSocket = class {
        onopen?: () => void;
        onmessage?: (ev: { data: string }) => void;
        constructor() { socket = this; }
        send(): void {}
        close(): void {}
      };
      w.fetch = async () => ({ ok: true, json: async () => [] });
    },
  });
  doms.push(dom);
  if (!socket?.onmessage) throw new Error("dashboard.html did not open its WebSocket");
  socket.onopen?.();
  const s = socket;
  return {
    async send(...events) {
      for (const e of events) s.onmessage!({ data: JSON.stringify({ timestamp: Date.now(), ...e }) });
      await new Promise((r) => setTimeout(r, 10));
    },
    status: () => dom.window.document.getElementById("hStatus")?.textContent ?? "",
  };
}

describe("dashboard: what swarm is doing now", () => {
  it("follows a goal from planning, through preparing context, to working, reviewing and between tasks", async () => {
    const page = await open();
    await page.send({ type: "goal:planning", payload: { goalId: "trello-AbC123", timestamp: Date.now() } });
    expect(page.status()).toMatch(/^Planning trello-AbC123/);

    await page.send(
      { type: "context:sync-start", payload: { changedFiles: 23, totalFiles: 57, changedBytes: 1000, timestamp: Date.now() } },
      { type: "context:sync-progress", payload: { done: 1, total: 23, bytesDone: 30, bytesTotal: 1000, timestamp: Date.now() } },
    );
    // Too little measured yet for an estimate.
    expect(page.status()).toContain("preparing context: synopses 1/23 · 3% · estimating…");
    await page.send({ type: "context:sync-progress", payload: { done: 12, total: 23, bytesDone: 520, bytesTotal: 1000, etaMs: 240_000, bytesPerMinute: 130_000, timestamp: Date.now() } });
    expect(page.status()).toContain("Planning trello-AbC123");
    expect(page.status()).toContain("preparing context: synopses 12/23 · 52% · about 4 min left");

    await page.send({ type: "context:sync-done", payload: { done: 23, total: 23, bytesDone: 1000, bytesTotal: 1000, failures: 0, ms: 1000, timestamp: Date.now() } });
    expect(page.status()).not.toContain("synopses");

    await page.send(
      { type: "goal:decomposed", payload: { goalId: "trello-AbC123", tasks: [{ id: "t1", title: "feat: export", description: "Add it", intent: "implementation" }], timestamp: Date.now() } },
      { type: "task:start", payload: { taskId: "t1", goalId: "trello-AbC123", title: "feat: export", description: "Add it", intent: "implementation", timestamp: Date.now() } },
    );
    expect(page.status()).toMatch(/^Working on: feat: export/);

    await page.send({ type: "oversight:start", payload: { sessionId: "s", role: "reviewer", model: "m", timestamp: Date.now() } });
    expect(page.status()).toMatch(/^Reviewing: feat: export/);

    await page.send({ type: "task:verdict", payload: { taskId: "t1", verdict: "approved", latencyMs: 1, retryCount: 0 } });
    expect(page.status()).toMatch(/^Between tasks/);
  });

  it("keeps up with tasks running side by side", async () => {
    const page = await open();
    const start = (id: string, title: string) => ({ type: "task:start", payload: { taskId: id, goalId: "goal-1", title, description: "d", intent: "implementation", timestamp: Date.now() } });
    await page.send(start("t1", "feat: one"), start("t2", "feat: two"));
    expect(page.status()).toMatch(/^Working on 2 tasks: feat: two/);
    // One finishing leaves the other at work, not "between tasks".
    await page.send({ type: "task:verdict", payload: { taskId: "t2", verdict: "approved", latencyMs: 1, retryCount: 0 } });
    expect(page.status()).toMatch(/^Working on: feat: one/);
    await page.send({ type: "task:verdict", payload: { taskId: "t1", verdict: "approved", latencyMs: 1, retryCount: 0 } });
    expect(page.status()).toMatch(/^Between tasks/);
  });

  it("keeps a sync's progress when a parallel task starts or finishes during it", async () => {
    const page = await open();
    const start = (id: string, title: string) => ({ type: "task:start", payload: { taskId: id, goalId: "goal-1", title, description: "d", intent: "implementation", timestamp: Date.now() } });
    await page.send(start("t1", "feat: one"), { type: "context:sync-start", payload: { changedFiles: 4, totalFiles: 9, changedBytes: 400, timestamp: Date.now() } });
    await page.send(start("t2", "feat: two"));
    expect(page.status()).toContain("preparing context: synopses 0/4");
    await page.send({ type: "task:verdict", payload: { taskId: "t2", verdict: "approved", latencyMs: 1, retryCount: 0 } });
    expect(page.status()).toContain("preparing context: synopses 0/4");
  });

  it("keeps the active tasks from the snapshot, so a later finish names the one still at work", async () => {
    const page = await open();
    const t0 = Date.now() - 10_000;
    await page.send({
      type: "state",
      payload: {
        goals: [], tasks: [], events: [],
        phase: { kind: "working", since: t0, taskId: "t2", title: "feat: two", activeTasks: 2 },
        activeTasks: [{ taskId: "t1", title: "feat: one", since: t0 }, { taskId: "t2", title: "feat: two", since: t0 }],
      },
    });
    await page.send({ type: "task:verdict", payload: { taskId: "t2", verdict: "approved", latencyMs: 1, retryCount: 0 } });
    expect(page.status()).toMatch(/^Working on: feat: one/);
  });

  it("shows preparing context on its own when nothing else is under way, and nothing when no files changed", async () => {
    const page = await open();
    await page.send({ type: "context:sync-start", payload: { changedFiles: 4, totalFiles: 9, changedBytes: 400, timestamp: Date.now() } });
    expect(page.status()).toMatch(/^Preparing context: synopses 0\/4 · 0% · estimating…/);
    const quiet = await open();
    await quiet.send({ type: "context:sync-start", payload: { changedFiles: 0, totalFiles: 9, changedBytes: 0, timestamp: Date.now() } });
    expect(quiet.status()).toBe("");
  });

  it("says how long it has been at it", async () => {
    const page = await open();
    await page.send({ type: "goal:planning", payload: { goalId: "goal-1", timestamp: Date.now() - 125_000 }, timestamp: Date.now() - 125_000 });
    expect(page.status()).toContain("2m 05s");
  });

  it("picks the current phase up from the server's state snapshot", async () => {
    const page = await open();
    await page.send({
      type: "state",
      payload: { goals: [], tasks: [], events: [], phase: { kind: "working", since: Date.now() - 65_000, taskId: "t1", title: "fix: crash", sync: { done: 3, total: 9, bytesDone: 250, bytesTotal: 1000, etaMs: 30_000, at: Date.now() } } },
    });
    expect(page.status()).toContain("Working on: fix: crash");
    expect(page.status()).toContain("preparing context: synopses 3/9 · 25% · under a minute left");
    expect(page.status()).toContain("1m 05s");
  });

  it("says when the run waits for another run's merge, and moves on when its turn comes", async () => {
    const page = await open();
    await page.send({ type: "goal:completed", payload: { goalId: "g1", timestamp: Date.now() } });
    await page.send({ type: "source_control:merge_waiting", payload: { goalId: "g1", repoKey: "github.com/o/r#main", ahead: 1, holderProject: "app-ios", holderPrUrl: "https://github.com/o/r/pull/14", timestamp: Date.now() } });
    expect(page.status()).toMatch(/^Waiting to merge: app-ios is gating https:\/\/github\.com\/o\/r\/pull\/14 \(1 ahead\)/);
    await page.send({ type: "source_control:merge_turn_taken", payload: { goalId: "g1", repoKey: "github.com/o/r#main", waitedMs: 5000, timestamp: Date.now() } });
    expect(page.status()).toMatch(/^Merging g1/);
  });
});

describe("DashboardServer: the current phase in the state snapshot", () => {
  const servers: DashboardServer[] = [];
  afterEach(async () => {
    for (const server of servers) await server.stop();
    servers.length = 0;
  });

  function initialState(port: number): Promise<{ ws: WebSocket; state: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for initial state")), 3000);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "state") { clearTimeout(timer); resolve({ ws, state: msg.payload }); }
      });
    });
  }

  it("tracks planning, the sync's counts, and the task being worked on", async () => {
    const port = 13392;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("goal:planning", { goalId: "goal-1", timestamp: Date.now() });
    bus.emit("context:sync-start", { changedFiles: 23, totalFiles: 57, changedBytes: 1000, timestamp: Date.now() });
    bus.emit("context:sync-progress", { done: 7, total: 23, bytesDone: 300, bytesTotal: 1000, etaMs: 420_000, bytesPerMinute: 100, timestamp: Date.now() });
    const first = await initialState(port);
    expect(first.state.phase).toMatchObject({ kind: "planning", goalId: "goal-1", sync: { done: 7, total: 23, bytesDone: 300, bytesTotal: 1000, etaMs: 420_000 } });
    first.ws.close();

    bus.emit("context:sync-done", { done: 23, total: 23, bytesDone: 1000, bytesTotal: 1000, failures: 0, ms: 5, fallbacks: 0, timestamp: Date.now() });
    bus.emit("task:start", { taskId: "t1", goalId: "goal-1", title: "feat: export", description: "d", intent: "implementation" } as never);
    const second = await initialState(port);
    expect(second.state.phase).toMatchObject({ kind: "working", taskId: "t1", title: "feat: export" });
    expect((second.state.phase as Record<string, unknown>).sync).toBeUndefined();
    second.ws.close();
  });

  it("knows a run is waiting for the merge turn, and then merging", async () => {
    const port = 13394;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("goal:completed", { goalId: "g1", timestamp: Date.now() } as never);
    bus.emit("source_control:merge_waiting", { goalId: "g1", repoKey: "github.com/o/r#main", ahead: 2, holderProject: "app-ios", holderPrUrl: "https://github.com/o/r/pull/14", timestamp: Date.now() });
    const first = await initialState(port);
    expect(first.state.phase).toMatchObject({ kind: "waiting-to-merge", goalId: "g1", ahead: 2, holderProject: "app-ios", holderPrUrl: "https://github.com/o/r/pull/14" });
    first.ws.close();
    bus.emit("source_control:merge_turn_taken", { goalId: "g1", repoKey: "github.com/o/r#main", waitedMs: 1, timestamp: Date.now() });
    const second = await initialState(port);
    expect(second.state.phase).toMatchObject({ kind: "merging", goalId: "g1" });
    second.ws.close();
    bus.emit("source_control:pr_merged", { goalId: "g1", branch: "b", prUrl: "u", mergeCommit: "c", base: "main", timestamp: Date.now() });
    const third = await initialState(port);
    expect(third.state.phase).toMatchObject({ kind: "goal-finished", goalId: "g1" });
    third.ws.close();
  });

  it("keeps the other task working when one of two parallel tasks finishes", async () => {
    const port = 13393;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("task:start", { taskId: "t1", goalId: "g", title: "feat: one", description: "d", intent: "implementation" } as never);
    bus.emit("task:start", { taskId: "t2", goalId: "g", title: "feat: two", description: "d", intent: "implementation" } as never);
    bus.emit("task:verdict", { taskId: "t2", verdict: "approved", latencyMs: 1, retryCount: 0 } as never);
    const { ws, state } = await initialState(port);
    expect(state.phase).toMatchObject({ kind: "working", taskId: "t1", title: "feat: one", activeTasks: 1 });
    expect(state.activeTasks).toEqual([expect.objectContaining({ taskId: "t1", title: "feat: one" })]);
    ws.close();
  });
});
