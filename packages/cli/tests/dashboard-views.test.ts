/**
 * The live dashboard's four views (Summary, Swarm Context, Oversight, Full
 * Event Log) are siblings, so showing one never hides it with another. A stray
 * unclosed element in the summary markup once made the other three children of
 * the summary view: showView('swarm') hid the summary and with it the view it
 * had just shown, so those pages rendered nothing. Renders the real page in
 * jsdom, as the other dashboard-*.test.ts files do.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");
const VIEWS = ["summary", "swarm", "oversight", "events"] as const;

const doms: JSDOM[] = [];
afterEach(() => {
  for (const dom of doms) dom.window.close();
  doms.length = 0;
});

type Sent = { type: string; payload: unknown };

async function render(events: Sent[] = []): Promise<JSDOM> {
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
  return dom;
}

/** Whether an element would be drawn: neither it nor any ancestor is hidden. */
function shown(el: Element | null): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList.contains("hidden")) return false;
    if ((n as HTMLElement).style?.display === "none") return false;
  }
  return el !== null;
}

const showView = (dom: JSDOM, name: string) => (dom.window as unknown as { showView(n: string): void }).showView(name);

describe("dashboard: the four views", () => {
  it("are siblings under one container", async () => {
    const doc = (await render()).window.document;
    const parents = VIEWS.map((v) => doc.getElementById(`view-${v}`)?.parentElement);
    expect(parents.every((p) => p !== null && p !== undefined)).toBe(true);
    expect(new Set(parents).size).toBe(1);
  });

  for (const view of VIEWS) {
    it(`showView('${view}') shows that view and hides the others`, async () => {
      const dom = await render();
      showView(dom, view);
      const doc = dom.window.document;
      expect(shown(doc.getElementById(`view-${view}`))).toBe(true);
      for (const other of VIEWS.filter((v) => v !== view)) expect(shown(doc.getElementById(`view-${other}`)), other).toBe(false);
    });
  }

  it("shows the content each drill-down page renders, not just its container", async () => {
    const dom = await render([
      { type: "agent:role", payload: { role: "worker", model: "claude-x", timestamp: 1 } },
      {
        type: "context:loaded",
        payload: { sessionId: "s1", files: [{ path: "core/values.md", tier: "core", estimatedTokens: 600 }], totalTokens: 600, budgetMax: 1000, budgetUsedPercent: 60, timestamp: 2 },
      },
      { type: "oversight:verdict", payload: { taskId: "t1", verdict: "approved", role: "reviewer", timestamp: 3 } },
    ]);
    const doc = dom.window.document;

    showView(dom, "swarm");
    const files = doc.getElementById("ctxFiles");
    expect(files?.textContent).toContain("core/values.md");
    expect(shown(files)).toBe(true);

    showView(dom, "oversight");
    const verdicts = doc.getElementById("oversightList");
    expect(verdicts?.textContent).toContain("approved");
    expect(shown(verdicts)).toBe(true);

    showView(dom, "events");
    const log = doc.getElementById("logWrapFull");
    expect(log?.querySelectorAll(".log-entry").length).toBeGreaterThan(0);
    expect(shown(log)).toBe(true);
  });
});
