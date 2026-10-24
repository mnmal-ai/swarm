/**
 * The live dashboard shows fnl coverage: a tile with the run's total (how
 * many build and test commands fnl wrapped, why it left the others alone, and
 * the tokens the digests saved), and each session's line in the event log.
 * The server keeps the total in its state, so a page opened mid-run shows it
 * too. Renders the real page in jsdom and runs the real server, as the other
 * dashboard tests do.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { FnlCoverage, FnlSavings } from "@mnmal-ai/swarm-types";
import { DashboardServer } from "../src/server/index.js";

const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");
const cov = (over: Partial<FnlCoverage> = {}): FnlCoverage => ({ buildCommands: 0, wrapped: 0, leftAlone: {}, byTool: {}, unanswered: 0, ...over });
const saved = (over: Partial<FnlSavings> = {}): FnlSavings => ({ calls: 0, rawTokens: 0, sentTokens: 0, withoutFnlTokens: 0, savedTokens: 0, unmeasured: 0, oversized: 0, ...over });

const doms: JSDOM[] = [];
const servers: DashboardServer[] = [];
afterEach(async () => {
  for (const dom of doms) dom.window.close();
  doms.length = 0;
  for (const server of servers) await server.stop();
  servers.length = 0;
});

async function render(messages: Array<{ type: string; payload: unknown }>): Promise<Document> {
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
  for (const m of messages) socket.onmessage({ data: JSON.stringify({ ...m, timestamp: Date.now() }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom.window.document;
}

const text = (doc: Document, id: string) => doc.getElementById(id)?.textContent ?? "";

describe("dashboard: fnl coverage", () => {
  it("shows the run's total in its tile, adding up each session's coverage", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 } }), timestamp: 1 } },
      { type: "backend:fnl_coverage", payload: { role: "reviewer", coverage: cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 } }), timestamp: 2 } },
    ]);
    expect(text(doc, "mFnl")).toBe("2/4");
    expect(text(doc, "mFnlSub")).toBe("wrapped · 2 left alone: structure");
  });

  it("adds the tokens the digests saved, keeping the coverage numbers", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 }, savings: saved({ calls: 1, savedTokens: 300_000 }) }), timestamp: 1 } },
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 } }), timestamp: 2 } },
      { type: "backend:fnl_coverage", payload: { role: "reviewer", coverage: cov({ savings: saved({ calls: 2, savedTokens: 112_000, unmeasured: 1 }) }), timestamp: 3 } },
    ]);
    expect(text(doc, "mFnl")).toBe("2/4");
    expect(text(doc, "mFnlSub")).toBe("wrapped · 2 left alone: structure · saved ~412k tokens");
  });

  it("adds how many large logs the agents got as digests", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 3, wrapped: 3, savings: saved({ calls: 3, savedTokens: 12_000, oversized: 2 }) }), timestamp: 1 } },
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 1, wrapped: 1, savings: saved({ calls: 1, savedTokens: 400, oversized: 1 }) }), timestamp: 2 } },
    ]);
    expect(text(doc, "mFnl")).toBe("4/4");
    expect(text(doc, "mFnlSub")).toBe("wrapped · saved ~12.4k tokens · 3 large logs digested");
  });

  it("shows no saving when no wrapped call could be measured", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 1, wrapped: 1, savings: saved({ unmeasured: 1 }) }), timestamp: 1 } },
    ]);
    expect(text(doc, "mFnlSub")).toBe("wrapped");
  });

  it("says so when no build or test command has run yet", async () => {
    const doc = await render([]);
    expect(text(doc, "mFnl")).toBe("--");
    expect(text(doc, "mFnlSub")).toBe("no build/test commands yet");
  });

  it("logs each session's coverage in the event log", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "reviewer", coverage: cov({ buildCommands: 3, wrapped: 0, leftAlone: { structure: 3 } }), timestamp: 1 } },
    ]);
    expect(doc.body.textContent).toContain("reviewer: wrapped 0 of 3 build/test commands (3 left alone: structure)");
  });

  it("logs each session's saving with its coverage", async () => {
    const doc = await render([
      { type: "backend:fnl_coverage", payload: { role: "worker", coverage: cov({ buildCommands: 2, wrapped: 2, savings: saved({ calls: 2, savedTokens: 15_400, oversized: 1 }) }), timestamp: 1 } },
    ]);
    expect(doc.body.textContent).toContain("worker: wrapped 2 of 2 build/test commands · saved ~15.4k tokens · 1 large log digested");
  });

  it("shows the total from the server's state snapshot for a page opened mid-run", async () => {
    const doc = await render([
      { type: "state", payload: { goals: [], tasks: [], events: [], fnl: { sessions: 3, total: cov({ buildCommands: 5, wrapped: 5 }) } } },
    ]);
    expect(text(doc, "mFnl")).toBe("5/5");
    expect(text(doc, "mFnlSub")).toBe("wrapped");
  });

  it("shows the saving from the server's state snapshot", async () => {
    const doc = await render([
      { type: "state", payload: { goals: [], tasks: [], events: [], fnl: { sessions: 3, total: cov({ buildCommands: 5, wrapped: 5, savings: saved({ calls: 5, savedTokens: 1_200_000 }) }) } } },
    ]);
    expect(text(doc, "mFnlSub")).toBe("wrapped · saved ~1.2M tokens");
  });
});

describe("DashboardServer: fnl coverage in its state", () => {
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

  it("adds each session's coverage to the run's total", async () => {
    const port = 13397;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("backend:fnl_coverage", { role: "worker", coverage: cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 }, byTool: { gradlew: { wrapped: 1, leftAlone: 1 } } }), timestamp: 1 });
    bus.emit("backend:fnl_coverage", { role: "reviewer", coverage: cov({ buildCommands: 1, wrapped: 1, byTool: { gradlew: { wrapped: 1, leftAlone: 0 } } }), timestamp: 2 });
    const { ws, state } = await initialState(port);
    expect(state.fnl).toEqual({
      sessions: 2,
      total: { buildCommands: 3, wrapped: 2, leftAlone: { structure: 1 }, byTool: { gradlew: { wrapped: 2, leftAlone: 1 } }, unanswered: 0 },
    });
    ws.close();
  });

  it("adds each session's savings to the run's total", async () => {
    const port = 13399;
    const bus = new SwarmEventBus();
    servers.push(new DashboardServer(bus, port));
    bus.emit("backend:fnl_coverage", { role: "worker", coverage: cov({ buildCommands: 1, wrapped: 1, savings: saved({ calls: 1, rawTokens: 9_000, sentTokens: 100, withoutFnlTokens: 7_500, savedTokens: 7_400, oversized: 1 }) }), timestamp: 1 });
    bus.emit("backend:fnl_coverage", { role: "worker", coverage: cov({ buildCommands: 1, wrapped: 1, savings: saved({ calls: 1, rawTokens: 1_000, sentTokens: 50, withoutFnlTokens: 500, savedTokens: 450, unmeasured: 1 }) }), timestamp: 2 });
    const { ws, state } = await initialState(port);
    expect((state.fnl as { total: FnlCoverage }).total.savings).toEqual({ calls: 2, rawTokens: 10_000, sentTokens: 150, withoutFnlTokens: 8_000, savedTokens: 7_850, unmeasured: 1, oversized: 1 });
    ws.close();
  });

  it("has no fnl total before any session counted one", async () => {
    const port = 13398;
    servers.push(new DashboardServer(new SwarmEventBus(), port));
    const { ws, state } = await initialState(port);
    expect(state).not.toHaveProperty("fnl");
    ws.close();
  });
});
