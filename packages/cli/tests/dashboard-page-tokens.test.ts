/**
 * Renders the REAL live dashboard page (src/server/dashboard.html) in jsdom
 * against a fixture state snapshot, the way a browser gets it from the server
 * over the WebSocket, and checks what an operator would read.
 *
 * The page shows tokens, never currency: session (header and main tile), each
 * goal, each task and each subtask show input, cached input and output
 * tokens. The budget bar shows tokens against the session token limit, and is
 * hidden when no limit is set. Payloads from older emitters, without the token
 * fields, must not render NaN or undefined.
 *
 * An earlier change was checked only against a mock of the page, so it passed
 * while the page stayed dollars-only. This test runs the page's own script.
 * jsdom, not Playwright: Playwright needs a downloaded browser that the CI
 * test job does not install.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");

const TASK_TOKENS = { freshInput: 1_200, cacheRead: 340_000, cacheWrite: 15_000, output: 4_500 };
const SUBTASK_TOKENS = { freshInput: 800, cacheRead: 60_000, cacheWrite: 5_000, output: 1_500 };
const SESSION_TOKENS = { freshInput: 2_500, cacheRead: 1_450_000, cacheWrite: 30_000, output: 7_000 };
const SESSION_TOTAL = 1_489_500;

/** A state snapshot as DashboardServer sends it. */
function fixtureState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    startedAt: now,
    project: "sample-project",
    goals: [{ id: "goal-1", description: "Add the sample widget", status: "in_progress" }],
    tasks: [
      {
        id: "goal-1-task-1", goalId: "goal-1", title: "Build the widget", description: "Build the widget",
        intent: "implementation", status: "completed", verdict: "approved", latencyMs: 61_000,
        retryCount: 0, tokens: TASK_TOKENS,
      },
      {
        id: "goal-1-task-2", goalId: "goal-1", title: "Wire the widget", description: "Wire the widget",
        intent: "implementation", status: "interrupted", subTaskIds: ["goal-1-task-2-sub-1"],
      },
      {
        id: "goal-1-task-2-sub-1", goalId: "goal-1", description: "Wire the first half", intent: "implementation",
        status: "completed", verdict: "approved", latencyMs: 20_000, retryCount: 0,
        parentTaskId: "goal-1-task-2", tokens: SUBTASK_TOKENS,
      },
    ],
    currentGoal: "goal-1",
    currentTask: null,
    cumulativeTokens: SESSION_TOTAL,
    tokens: SESSION_TOKENS,
    tokenLimit: 5_000_000,
    worktrees: [],
    activeWorkerCount: 0,
    maxWorkers: 1,
    events: [
      { type: "session:start", payload: { sessionId: "s1", role: "worker", model: "model-a", project: "sample-project" }, timestamp: now },
      { type: "turn:end", payload: { turn: 0, inputTokens: 900, outputTokens: 300, toolCallCount: 2 }, timestamp: now },
      { type: "oversight:verdict", payload: { sessionId: "s1", verdict: "approved", arbiterInvolved: false, retryCount: 0, durationMs: 10 }, timestamp: now },
      { type: "task:verdict", payload: { taskId: "goal-1-task-1", verdict: "approved", latencyMs: 61_000, retryCount: 0, tokens: TASK_TOKENS }, timestamp: now },
      { type: "tokens:update", payload: { cumulativeTokens: SESSION_TOTAL, tokens: SESSION_TOKENS, sessionTokenLimit: 5_000_000, percentUsed: 29.79 }, timestamp: now },
      { type: "orchestration:event", payload: { id: "e1", eventType: "token_warning", project: "sample-project", trustLevel: "medium", detail: "Tokens at 4,000,000" }, timestamp: now },
      { type: "goal:completed", payload: { goalId: "goal-1", completedTasks: 1, totalTasks: 2, totalTokens: 426_000 }, timestamp: now },
      { type: "session:end", payload: { sessionId: "s1", role: "worker", totalInputTokens: 1_000, totalOutputTokens: 400, totalTurns: 3, latencyMs: 5 }, timestamp: now },
    ],
    ...overrides,
  };
}

/** SessionEvent rows for the page's Substrate panel, which polls the sidecar
 *  separately. Rows stored before swarm stopped writing dollars still carry
 *  costUsd; the page must not show it. */
const SUBSTRATE_DATA = {
  "swarm/SessionEvent": [
    { role: "worker", costUsd: 2.5, inputTokens: 5000, outputTokens: 700, latencyMs: 60000, timestamp: new Date().toISOString() },
    { role: "reviewer", costUsd: 0.4, inputTokens: 1200, outputTokens: 100, latencyMs: 9000, timestamp: new Date().toISOString() },
  ],
  "swarm/ReviewVerdict": [{ verdict: "approved", timestamp: new Date().toISOString() }],
  "swarm/TranscriptEntry": [],
  "swarm/Goal": [],
};

interface RenderedPage {
  window: JSDOM["window"];
  document: Document;
  text(): string;
  send(type: string, payload: unknown): void;
}

const pages: JSDOM[] = [];

afterEach(() => {
  for (const dom of pages) dom.window.close();
  pages.length = 0;
});

/** Load the page, deliver `state` over its WebSocket, and let its polls settle. */
async function render(state: Record<string, unknown>): Promise<RenderedPage> {
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
      w.fetch = async (url: string) => ({
        ok: true,
        json: async () => (String(url).includes("/api/substrate/") ? { data: SUBSTRATE_DATA } : []),
      });
    },
  });
  pages.push(dom);
  if (!socket?.onmessage) throw new Error("dashboard.html did not open its WebSocket");
  socket.onopen?.();
  socket.onmessage({ data: JSON.stringify({ type: "state", payload: state }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const document = dom.window.document;
  return {
    window: dom.window,
    document,
    // The page's own <script> sits in <body>; its source is not page text.
    text: () => {
      const body = document.body.cloneNode(true) as HTMLElement;
      for (const el of Array.from(body.querySelectorAll("script, style"))) el.remove();
      return body.textContent ?? "";
    },
    send: (type, payload) => socket!.onmessage!({ data: JSON.stringify({ type, payload, timestamp: Date.now() }) }),
  };
}

function textOf(page: RenderedPage, selector: string): string {
  const el = page.document.querySelector(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el.textContent ?? "";
}

/** Text of every view: summary, then the oversight and full-event-log views,
 *  which render only when shown. */
function allViewsText(page: RenderedPage): string {
  const summary = page.text();
  const w = page.window as unknown as { showView(name: string): void };
  w.showView("oversight");
  const oversight = page.text();
  w.showView("events");
  const events = page.text();
  w.showView("summary");
  return [summary, oversight, events].join("\n");
}

describe("live dashboard page renders tokens, not currency", () => {
  it("shows no currency amount anywhere on the page", async () => {
    const page = await render(fixtureState());

    expect(allViewsText(page)).not.toMatch(/\$\s?\d/);
  });

  it("shows session input, cached input and output tokens in the header", async () => {
    const page = await render(fixtureState());

    expect(textOf(page, "#hTokens")).toBe("in 2.5k · cached 1.48M · out 7k");
  });

  it("shows session tokens in the main tile", async () => {
    const page = await render(fixtureState());

    expect(textOf(page, "#mTokens")).toBe("2.5k in · 7k out");
    expect(textOf(page, "#mTokensSub")).toBe("1.48M cached input");
  });

  it("sums each goal's tasks and subtasks into its token line", async () => {
    const page = await render(fixtureState());

    expect(textOf(page, ".goal-card .goal-stats")).toContain("in 2k · cached 420k · out 6k");
  });

  it("shows a task's input, cached input (reads and writes) and output tokens", async () => {
    const page = await render(fixtureState());

    const task = textOf(page, '.task-card[data-task-id="goal-1-task-1"] .task-expanded-body');
    expect(task).toContain("Input tokens1,200");
    expect(task).toContain("Cached input355,000 (340,000 read · 15,000 write)");
    expect(task).toContain("Output tokens4,500");
  });

  it("shows a subtask's tokens on its card and in its details", async () => {
    const page = await render(fixtureState());

    const sub = textOf(page, '.task-card[data-task-id="goal-1-task-2"] .subtask-card');
    expect(sub).toContain("in 800 · cached 65k · out 1.5k");
    expect(sub).toContain("Input tokens800");
    expect(sub).toContain("Cached input65,000 (60,000 read · 5,000 write)");
    expect(sub).toContain("Output tokens1,500");
  });

  it("draws the budget bar as tokens against the session token limit", async () => {
    const page = await render(fixtureState());

    const section = page.document.getElementById("tokSection")!;
    expect(section.classList.contains("hidden")).toBe(false);
    expect(textOf(page, "#tokAmt")).toBe("1.49M tokens");
    expect(textOf(page, "#tokLim")).toBe("limit: 5M tokens");
    expect(textOf(page, "#tokPct")).toBe("29.8%");
    expect(textOf(page, "#tokRemain")).toBe("3.51M remaining");
    expect((page.document.getElementById("tokBar") as HTMLElement).style.width).toBe("29.79%");
  });

  it("hides the budget bar when no session token limit is set", async () => {
    const page = await render(fixtureState({ tokenLimit: 0 }));

    expect(page.document.getElementById("tokSection")!.classList.contains("hidden")).toBe(true);
  });

  it("updates from live tokens:update and task:verdict events", async () => {
    const page = await render(fixtureState({ tokens: undefined, cumulativeTokens: 0, tokenLimit: 0, tasks: [
      { id: "goal-1-task-1", goalId: "goal-1", description: "Build the widget", intent: "implementation", status: "in_progress" },
    ] }));

    page.send("tokens:update", {
      cumulativeTokens: SESSION_TOTAL, tokens: SESSION_TOKENS, sessionTokenLimit: 5_000_000, percentUsed: 29.79,
    });
    page.send("task:verdict", {
      taskId: "goal-1-task-1", verdict: "approved", latencyMs: 1_000, retryCount: 0, tokens: TASK_TOKENS,
    });

    expect(textOf(page, "#hTokens")).toBe("in 2.5k · cached 1.48M · out 7k");
    expect(textOf(page, "#tokLim")).toBe("limit: 5M tokens");
    expect(textOf(page, '.task-card[data-task-id="goal-1-task-1"] .task-expanded-body')).toContain("Input tokens1,200");
    expect(allViewsText(page)).not.toMatch(/\$\s?\d/);
  });

  it("counts what a split task spent before its subtasks ran, from a live task:aborted", async () => {
    const page = await render(fixtureState());

    // The parent's decomposition call: 1,000 fresh, 20,000 cache reads, 0 writes, 500 out.
    page.send("task:aborted", {
      taskId: "goal-1-task-2", reason: "complexity_preemptive", subTaskCount: 1,
      tokens: { freshInput: 1_000, cacheRead: 20_000, cacheWrite: 0, output: 500 },
    });

    expect(textOf(page, ".goal-card .goal-stats")).toContain("in 3k · cached 440k · out 6.5k");
    const parent = textOf(page, '.task-card[data-task-id="goal-1-task-2"] .task-expanded-body');
    expect(parent).toContain("Input tokens1,000");
  });

  it("renders payloads without token fields without NaN or undefined", async () => {
    const legacy = fixtureState({
      tokens: undefined,
      tokenLimit: undefined,
      cumulativeTokens: undefined,
      tasks: [
        { id: "goal-1-task-1", goalId: "goal-1", description: "Build the widget", intent: "implementation", status: "completed", verdict: "approved", latencyMs: 1_000, retryCount: 0 },
      ],
      events: [
        { type: "tokens:update", payload: { percentUsed: 4 }, timestamp: Date.now() },
        { type: "task:verdict", payload: { taskId: "goal-1-task-1", verdict: "approved", latencyMs: 1_000, retryCount: 0 }, timestamp: Date.now() },
      ],
    });

    const page = await render(legacy);
    page.send("tokens:update", { percentUsed: 6 });

    const text = allViewsText(page);
    expect(text).not.toMatch(/NaN|undefined/);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(page.document.getElementById("tokSection")!.classList.contains("hidden")).toBe(true);
  });
});
