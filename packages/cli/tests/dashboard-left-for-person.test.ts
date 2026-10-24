/**
 * A task the reviewer passed with items left for a person shows them on its
 * card, as a list, in the reviewer's words (as text, never as markup).
 * Renders the real page in jsdom, as dashboard-goal-link.test.ts does.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

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

const run = (deferred?: string[]): Sent[] => [
  { type: "goal:start", payload: { goalId: "goal-1", description: "Add the export button", taskCount: 1, timestamp: 1 } },
  { type: "goal:decomposed", payload: { goalId: "goal-1", tasks: [{ id: "t1", title: "feat: export", description: "Add it", intent: "implementation" }], timestamp: 2 } },
  {
    type: "task:verdict",
    payload: {
      taskId: "t1", verdict: "completed_with_deferrals", latencyMs: 10, retryCount: 0,
      tokens: { freshInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      ...(deferred ? { deferred } : {}),
      timestamp: 3,
    },
  },
];

describe("dashboard: items left for a person", () => {
  it("lists them on the task's card", async () => {
    const doc = await render(run(["Check it on a physical phone", "<b>Review</b> the copy"]));
    const block = doc.querySelector(".task-left-for-person");
    expect(block?.textContent).toContain("Left for a person (2)");
    const items = Array.from(block?.querySelectorAll("li") ?? []).map((li) => li.textContent);
    expect(items).toEqual(["Check it on a physical phone", "<b>Review</b> the copy"]);
    expect(block?.querySelector("b")).toBeNull();
  });

  it("shows nothing for a task with none", async () => {
    const doc = await render(run());
    expect(doc.querySelector(".task-left-for-person")).toBeNull();
  });
});
