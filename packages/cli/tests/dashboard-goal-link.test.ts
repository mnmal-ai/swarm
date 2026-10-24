/**
 * A goal that came from a ticket (a Trello card, a GitHub issue) carries the
 * ticket's URL, and the live dashboard turns its goal pill into a link to it:
 * on the goal's progress card and on each of its task cards. Only https links
 * are made; anything else stays plain text. Renders the real page in jsdom,
 * as dashboard-context-omitted.test.ts does.
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

const goal = (goalId: string, url?: string): Sent[] => [
  { type: "goal:start", payload: { goalId, description: "Add the export button", taskCount: 1, ...(url === undefined ? {} : { url }), timestamp: 1 } },
  { type: "goal:decomposed", payload: { goalId, tasks: [{ id: "t1", title: "feat: export", description: "Add it", intent: "implementation" }], timestamp: 2 } },
];

const pills = (doc: Document) => Array.from(doc.querySelectorAll(".task-goal-pill"));

describe("dashboard: goal pills link to the goal's source ticket", () => {
  it("links the pill on the goal card and on its task cards, opening in a new tab", async () => {
    const doc = await render(goal("trello-AbC123", "https://trello.com/c/AbC123"));
    const found = pills(doc);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const pill of found) {
      expect(pill.tagName).toBe("A");
      expect(pill.getAttribute("href")).toBe("https://trello.com/c/AbC123");
      expect(pill.getAttribute("target")).toBe("_blank");
      expect(pill.getAttribute("rel")).toContain("noopener");
      expect(pill.textContent).toContain("trello-AbC123");
    }
  });

  it("keeps a plain pill for a goal with no source ticket", async () => {
    const doc = await render(goal("goal-1"));
    const found = pills(doc);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const pill of found) expect(pill.tagName).toBe("SPAN");
  });

  it("never links anything but https", async () => {
    for (const url of ["javascript:alert(1)", "http://trello.com/c/AbC123", "data:text/html,hi", " https://trello.com/c/x"]) {
      const doc = await render(goal("trello-AbC123", url));
      for (const pill of pills(doc)) expect(pill.tagName, url).toBe("SPAN");
    }
  });

  it("links the pills of a dashboard opened mid-run, from the server's state snapshot", async () => {
    const doc = await render([
      {
        type: "state",
        payload: {
          goals: [{ id: "github-org-repo-42", description: "Fix the crash", status: "in_progress", url: "https://github.com/org/repo/issues/42" }],
          tasks: [{ id: "t1", goalId: "github-org-repo-42", title: "fix: crash", description: "Fix it", intent: "implementation", status: "in_progress" }],
          events: [],
        },
      },
    ]);
    const found = pills(doc);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const pill of found) expect(pill.getAttribute("href")).toBe("https://github.com/org/repo/issues/42");
  });
});

describe("DashboardServer: a goal's source URL reaches dashboards that connect later", () => {
  const servers: DashboardServer[] = [];
  afterEach(async () => {
    for (const server of servers) await server.stop();
    servers.length = 0;
  });

  function initialState(port: number): Promise<{ ws: WebSocket; state: { goals: Array<Record<string, unknown>> } }> {
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

  it("keeps the goal's url in the state snapshot, and leaves it out when there is none", async () => {
    const port = 13391;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("goal:start", { goalId: "trello-AbC123", description: "Add export", taskCount: 1, url: "https://trello.com/c/AbC123", timestamp: Date.now() });
    bus.emit("goal:start", { goalId: "goal-2", description: "Tidy up", taskCount: 1, timestamp: Date.now() });
    const { ws, state } = await initialState(port);
    expect(state.goals[0]).toMatchObject({ id: "trello-AbC123", url: "https://trello.com/c/AbC123" });
    expect(state.goals[1]).not.toHaveProperty("url");
    ws.close();
  });
});
