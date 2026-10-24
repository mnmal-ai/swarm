/**
 * A goal's badge on the live dashboard shows its label (the ticket's id from
 * its URL, or a model's pick) when swarm gave it one, else its goal id as
 * before. The full goal id and the ticket's title stay one hover away, in the
 * badge's tooltip and accessible name. Renders the real page in jsdom, as
 * dashboard-goal-link.test.ts does.
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

type Sent = { type: string; payload: unknown };

async function render(events: Sent[]): Promise<Document> {
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
  for (const e of events) socket.onmessage({ data: JSON.stringify({ ...e, timestamp: Date.now() }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom.window.document;
}

const goal = (goalId: string, extra: Record<string, unknown> = {}): Sent[] => [
  { type: "goal:start", payload: { goalId, description: "Add the export button", taskCount: 1, ...extra, timestamp: 1 } },
  { type: "goal:decomposed", payload: { goalId, tasks: [{ id: "t1", title: "feat: export", description: "Add it", intent: "implementation" }], timestamp: 2 } },
];

const pills = (doc: Document) => Array.from(doc.querySelectorAll(".task-goal-pill"));
const status = (doc: Document) => doc.getElementById("hStatus")?.textContent ?? "";

describe("dashboard: goal badges show the goal's label", () => {
  it("shows the label on the goal card and its task cards, still linking to the ticket", async () => {
    const doc = await render(goal("trello-AbC123", { url: "https://trello.com/c/AbC123", label: "AbC123" }));
    const found = pills(doc);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const pill of found) {
      expect(pill.tagName).toBe("A");
      expect(pill.getAttribute("href")).toBe("https://trello.com/c/AbC123");
      expect(pill.textContent).toBe("AbC123 ↗");
    }
  });

  it("puts the full goal id and the ticket's title in the tooltip and the accessible name", async () => {
    const doc = await render(goal("gh-42", { url: "https://github.com/acme/app/issues/42", label: "#42" }));
    for (const pill of pills(doc)) {
      expect(pill.getAttribute("title")).toContain("gh-42");
      expect(pill.getAttribute("title")).toContain("Add the export button");
      expect(pill.getAttribute("aria-label")).toContain("gh-42");
      expect(pill.getAttribute("aria-label")).toContain("Add the export button");
      expect(pill.getAttribute("aria-label")).toMatch(/opens the ticket/i);
    }
  });

  it("shows the goal id, as before, for a goal with no label", async () => {
    const doc = await render(goal("goal-1"));
    for (const pill of pills(doc)) {
      expect(pill.tagName).toBe("SPAN");
      expect(pill.textContent).toBe("G1");
      expect(pill.getAttribute("title")).toContain("goal-1");
      expect(pill.getAttribute("aria-label")).toContain("Add the export button");
    }
  });

  it("shows the label of a goal from the server's state snapshot", async () => {
    const doc = await render([
      {
        type: "state",
        payload: {
          goals: [{ id: "gh-42", description: "Fix the crash", status: "in_progress", url: "https://github.com/acme/app/issues/42", label: "#42" }],
          tasks: [{ id: "t1", goalId: "gh-42", title: "fix: crash", description: "Fix it", intent: "implementation", status: "in_progress" }],
          events: [],
        },
      },
    ]);
    const found = pills(doc);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const pill of found) expect(pill.textContent).toBe("#42 ↗");
  });

  it("names the goal by its label in the status line, from planning to finished", async () => {
    const planning = await render([{ type: "goal:planning", payload: { goalId: "trello-AbC123", label: "Export button", timestamp: Date.now() } }]);
    expect(status(planning)).toMatch(/^Planning Export button/);

    const finished = await render([
      ...goal("trello-AbC123", { label: "Export button" }),
      { type: "goal:completed", payload: { goalId: "trello-AbC123", completedTasks: 1, totalTasks: 1, timestamp: Date.now() } },
    ]);
    expect(status(finished)).toMatch(/^Finished Export button/);
  });

  it("keeps a long label to the badge's width, with an ellipsis", () => {
    const rule = /\.task-goal-pill\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toMatch(/max-width:/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });
});

describe("DashboardServer: a goal's label reaches dashboards that connect later", () => {
  const servers: DashboardServer[] = [];
  afterEach(async () => {
    for (const server of servers) await server.stop();
    servers.length = 0;
  });

  function initialState(port: number): Promise<{ ws: WebSocket; state: { goals: Array<Record<string, unknown>>; phase?: Record<string, unknown> } }> {
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

  it("keeps the goal's label in the snapshot, and the planning goal's label in the phase", async () => {
    const port = 13401;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("goal:start", { goalId: "trello-AbC123", description: "Add export", taskCount: 1, url: "https://trello.com/c/AbC123", label: "AbC123", timestamp: Date.now() });
    bus.emit("goal:start", { goalId: "goal-2", description: "Tidy up", taskCount: 1, timestamp: Date.now() });
    bus.emit("goal:planning", { goalId: "gh-42", label: "#42", timestamp: Date.now() });
    const { ws, state } = await initialState(port);
    expect(state.goals[0]).toMatchObject({ id: "trello-AbC123", label: "AbC123" });
    expect(state.goals[1]).not.toHaveProperty("label");
    expect(state.phase).toMatchObject({ kind: "planning", goalId: "gh-42", goalLabel: "#42" });
    ws.close();
  });
});
