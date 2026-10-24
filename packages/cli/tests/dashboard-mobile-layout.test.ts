/**
 * On a phone (360–430 px wide) the header once made the whole page wider than
 * the screen, about 790 px, so it scrolled sideways and the summary cards and
 * goals sat off to one side. The header row could neither wrap nor shrink: its
 * left half had flex's automatic minimum width, set by the status line's
 * nowrap text (up to 56 characters) beside the logo, the role and the model id.
 *
 * jsdom does no layout, so this checks what makes the page fit: the header's
 * pieces carry the classes and rules that let them wrap or truncate with an
 * ellipsis, the elapsed time sits apart from the text that truncates, and the
 * full status line and model id stay readable in their title attributes. The
 * layout itself was checked in WebKit and Chromium at 360, 390 and 430 px.
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

/** The declarations of the page's own rule for `selector`, at the top level or inside the given media query. */
function rule(dom: JSDOM, selector: string, media?: string): CSSStyleDeclaration | undefined {
  for (const sheet of Array.from(dom.window.document.styleSheets)) {
    for (const r of Array.from(sheet.cssRules)) {
      if (media === undefined && r instanceof dom.window.CSSStyleRule && r.selectorText === selector) return r.style;
      if (media !== undefined && r instanceof dom.window.CSSMediaRule && r.media.mediaText === media) {
        for (const inner of Array.from(r.cssRules)) {
          if (inner instanceof dom.window.CSSStyleRule && inner.selectorText === selector) return inner.style;
        }
      }
    }
  }
  return undefined;
}

const PHONE = "(max-width: 768px)";
const MODEL = "claude-code:claude-opus-5-5";
const TITLE = "feat(recipes): detail screen and navigation from the list to each recipe in the acme app";

const reviewing: Sent[] = [
  { type: "agent:role", payload: { sessionId: "s2", role: "reviewer", model: MODEL } },
  { type: "goal:start", payload: { goalId: "goal-1", description: "Add a recipes list" } },
  { type: "goal:decomposed", payload: { goalId: "goal-1", tasks: [{ id: "goal-1-task-1", title: TITLE, description: "d", intent: "implementation" }] } },
  { type: "task:start", payload: { taskId: "goal-1-task-1", goalId: "goal-1", title: TITLE, description: "d", intent: "implementation" } },
  { type: "oversight:start", payload: { sessionId: "s2", role: "reviewer", model: MODEL } },
];

describe("dashboard: the header fits a phone", () => {
  it("truncates the status text on its own, keeps the elapsed time apart, and keeps the full line in a title", async () => {
    const doc = (await render(reviewing)).window.document;
    const status = doc.getElementById("hStatus")!;
    const text = status.querySelector(".hdr-status-text");
    const time = status.querySelector(".hdr-status-time");
    expect(text?.textContent).toBe(`Reviewing: ${TITLE}`);
    expect(time?.textContent).toMatch(/^ · \d+s$/);
    expect(status.textContent).toBe(`Reviewing: ${TITLE}${time?.textContent}`);
    expect(status.getAttribute("title")).toBe(status.textContent);
    // A phone has no hover for the title: a tap lets the line wrap to show all of it.
    (status as HTMLElement).click();
    expect(status.classList.contains("hdr-status-open")).toBe(true);
    (status as HTMLElement).click();
    expect(status.classList.contains("hdr-status-open")).toBe(false);
  });

  it("gives the model id an element that truncates, with the full id in its title", async () => {
    const doc = (await render(reviewing)).window.document;
    const model = doc.getElementById("hModel")!;
    expect(model.classList.contains("hdr-model")).toBe(true);
    expect(model.textContent).toBe(MODEL);
    expect(model.getAttribute("title")).toBe(MODEL);
  });

  it("lets the header's pieces shrink and truncate with an ellipsis at any width", async () => {
    const dom = await render();
    expect(rule(dom, ".hdr-left")?.getPropertyValue("min-width")).toMatch(/^0(px)?$/);
    for (const sel of [".hdr-status-text", ".hdr-model"]) {
      const r = rule(dom, sel);
      expect(r?.getPropertyValue("min-width"), sel).toMatch(/^0(px)?$/);
      expect(r?.getPropertyValue("overflow"), sel).toBe("hidden");
      expect(r?.getPropertyValue("text-overflow"), sel).toBe("ellipsis");
      expect(r?.getPropertyValue("white-space"), sel).toBe("nowrap");
    }
    expect(rule(dom, ".hdr-status-time")?.getPropertyValue("flex-shrink")).toBe("0");
  });

  it("wraps the header onto rows on a phone, the status line on a row of its own", async () => {
    const dom = await render();
    expect(rule(dom, ".hdr", PHONE)?.getPropertyValue("flex-wrap")).toBe("wrap");
    expect(rule(dom, ".hdr-left", PHONE)?.getPropertyValue("flex-wrap")).toBe("wrap");
    expect(rule(dom, ".hdr-status", PHONE)?.getPropertyValue("flex-basis")).toBe("100%");
    expect(rule(dom, ".hdr-status", PHONE)?.getPropertyValue("max-width")).toBe("100%");
  });

  it("wraps the log filters, and keeps a goal's pill and task count whole beside a long description", async () => {
    const dom = await render();
    expect(rule(dom, ".log-filters")?.getPropertyValue("flex-wrap")).toBe("wrap");
    expect(rule(dom, ".goal-top-left .task-goal-pill")?.getPropertyValue("flex-shrink")).toBe("0");
    expect(rule(dom, ".goal-info")?.getPropertyValue("white-space")).toBe("nowrap");
    expect(rule(dom, ".goal-desc")?.getPropertyValue("overflow-wrap")).toBe("anywhere");
  });

  it("wraps an Oversight Detail row on a phone, so a task id and its tokens stay on the page", async () => {
    const dom = await render();
    expect(rule(dom, ".verdict-item", PHONE)?.getPropertyValue("flex-wrap")).toBe("wrap");
  });
});
