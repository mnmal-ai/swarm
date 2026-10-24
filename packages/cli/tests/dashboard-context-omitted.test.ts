/**
 * The live dashboard's swarm-context budget section names each file the
 * budget left out with the tokens it would have cost, and still lists any
 * other truncated entry (an unseeded remote URL has no size). Renders the real
 * page in jsdom, as dashboard-page-tokens.test.ts does.
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

async function renderWithEvent(type: string, payload: unknown): Promise<string> {
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
  socket.onmessage({ data: JSON.stringify({ type, payload, timestamp: Date.now() }) });
  // The budget section renders on the Swarm Context view.
  (dom.window as unknown as { showView(name: string): void }).showView("swarm");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const section = dom.window.document.getElementById("ctxBudget");
  return section?.textContent ?? "";
}

const LOADED = {
  sessionId: "s1",
  files: [{ path: "core/values.md", tier: "core", estimatedTokens: 600 }],
  totalTokens: 600,
  budgetMax: 1000,
  budgetUsedPercent: 60,
};

describe("dashboard: what the context budget left out", () => {
  it("names each left-out file with its tokens, and any other truncated entry", async () => {
    const text = await renderWithEvent("context:loaded", {
      ...LOADED,
      truncated: ["capabilities/git.md", "https://example.com/skill.md"],
      omitted: [{ path: "capabilities/git.md", tier: "capabilities", estimatedTokens: 900 }],
    });
    expect(text).toContain("Left out for budget: capabilities/git.md (900 tok)");
    expect(text).toContain("Truncated: https://example.com/skill.md");
    expect(text).not.toContain("Truncated: capabilities/git.md");
  });

  it("falls back to the truncated list for an event without omitted", async () => {
    const text = await renderWithEvent("context:loaded", { ...LOADED, truncated: ["capabilities/git.md"] });
    expect(text).toContain("Truncated: capabilities/git.md");
    expect(text).not.toContain("Left out");
  });
});
