/**
 * The Full Event Log lists the newest events first, renders a bounded first
 * page with a "Show more" control, shows a transcript as a one-line summary
 * whose full text is fetched only when opened, and keeps any large payload
 * short until expanded. Renders the real page in jsdom.
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

type Sent = { type: string; payload: unknown; timestamp?: number };

async function render(events: Sent[], fetched: string[] = []): Promise<JSDOM> {
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
      w.fetch = async (url: string) => {
        fetched.push(String(url));
        if (String(url).startsWith("/api/transcript/")) {
          return { ok: true, status: 200, json: async () => ({ sessionId: "s9", prompt: "FULL PROMPT TEXT", response: "FULL RESPONSE TEXT" }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      };
    },
  });
  doms.push(dom);
  if (!socket?.onmessage) throw new Error("dashboard.html did not open its WebSocket");
  socket.onopen?.();
  for (const e of events) socket.onmessage({ data: JSON.stringify({ type: e.type, payload: e.payload, timestamp: e.timestamp ?? Date.now() }) });
  (dom.window as unknown as { showView(n: string): void }).showView("events");
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom;
}

const entries = (dom: JSDOM) => Array.from(dom.window.document.querySelectorAll("#logWrapFull .log-entry"));
const progress = (n: number): Sent => ({ type: "orchestration:event", payload: { eventType: "step", detail: `event ${n}` }, timestamp: 1_000 + n });

describe("dashboard: the Full Event Log", () => {
  it("lists the newest event first", async () => {
    const dom = await render([progress(1), progress(2), progress(3)]);
    const text = entries(dom).map((e) => e.textContent ?? "");
    expect(text[0]).toContain("event 3");
    expect(text[2]).toContain("event 1");
  });

  it("renders the newest 200 first, and more on request", async () => {
    const dom = await render(Array.from({ length: 250 }, (_, i) => progress(i)));
    expect(entries(dom)).toHaveLength(200);
    const more = dom.window.document.querySelector<HTMLButtonElement>("#logWrapFull .log-more");
    expect(more?.textContent).toMatch(/50 more/);
    more!.click();
    expect(entries(dom)).toHaveLength(250);
    expect(dom.window.document.querySelector("#logWrapFull .log-more")).toBeNull();
  });

  it("shows a transcript as a summary and fetches the full text only when opened", async () => {
    const fetched: string[] = [];
    const dom = await render(
      [{ type: "transcript", payload: { sessionId: "s9", transcriptId: "t7", role: "worker", backend: "claude-code", tokens: { input: 1200, output: 340 }, promptBytes: 300_000, responseBytes: 120_000 } }],
      fetched,
    );
    const entry = entries(dom).find((e) => e.textContent?.includes("worker"));
    expect(entry?.textContent).toMatch(/prompt 293 KB/);
    expect(entry?.textContent).toMatch(/response 117 KB/);
    expect(fetched.some((u) => u.startsWith("/api/transcript/"))).toBe(false);
    entry!.querySelector<HTMLButtonElement>(".log-open")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetched).toContain("/api/transcript/t7");
    expect(entries(dom).find((e) => e.textContent?.includes("FULL PROMPT TEXT"))).toBeDefined();
  });

  it("says so when the dashboard no longer holds a transcript", async () => {
    const dom = await render([{ type: "transcript", payload: { sessionId: "gone", transcriptId: "t8", role: "reviewer", backend: "claude-code", promptBytes: 10, responseBytes: 10 } }]);
    (dom.window as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "No transcript" }) });
    const entry = entries(dom).find((e) => e.textContent?.includes("reviewer"));
    entry!.querySelector<HTMLButtonElement>(".log-open")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entry?.textContent).toContain("no longer held");
  });

  it("keeps a large payload short until expanded", async () => {
    const dom = await render([{ type: "custom:thing", payload: { blob: "z".repeat(40_000) } }]);
    const detail = entries(dom)[0].querySelector(".log-detail")?.textContent ?? "";
    expect(detail.length).toBeLessThan(2_200);
    expect(detail).toMatch(/KB\)/);
  });
});
