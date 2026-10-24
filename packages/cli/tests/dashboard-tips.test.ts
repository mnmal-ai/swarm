/**
 * Info tips on the live dashboard (src/server/dashboard.html), run in jsdom
 * against the REAL page: the ⓘ beside each metric tile and each drill-down
 * button opens a short explanation card.
 *
 * The tip text is read from the page's own TIPS object (between the
 * tips:start / tips:end sentinels), so these tests check the card shows
 * whatever the page defines rather than a copy of it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { JSDOM } from "jsdom";

const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");

interface Tip { title: string; body: string[]; steps?: string[] }

const tipsMatch = html.match(/\/\* tips:start \*\/([\s\S]*?)\/\* tips:end \*\//);
if (!tipsMatch) throw new Error("Could not find the tips:start / tips:end sentinels in src/server/dashboard.html");
const sandbox: { module: { exports: unknown } } = { module: { exports: undefined } };
createContext(sandbox);
runInContext(`${tipsMatch[1]}\nmodule.exports = TIPS;`, sandbox);
const TIPS = sandbox.module.exports as Record<string, Tip>;

/** Each tip, what its ⓘ is named for, and the element it sits beside. */
const TARGETS: Array<{ id: string; thing: string; near: string }> = [
  { id: "tokens", thing: "Tokens", near: "#mTokens" },
  { id: "firstPass", thing: "1st pass %", near: "#mFP" },
  { id: "tasksDone", thing: "Tasks done", near: "#mTD" },
  { id: "failed", thing: "Failed", near: "#mFail" },
  { id: "fnl", thing: "fnl", near: "#mFnl" },
  { id: "swarmContext", thing: "Swarm Context", near: "button[onclick=\"showView('swarm')\"]" },
  { id: "oversight", thing: "Oversight Detail", near: "button[onclick=\"showView('oversight')\"]" },
  { id: "events", thing: "Full Event Log", near: "button[onclick=\"showView('events')\"]" },
];

const DRILL_TIPS = new Set(["swarmContext", "oversight", "events"]);

function fixtureState(): Record<string, unknown> {
  const now = Date.now();
  return {
    startedAt: now,
    goals: [{ id: "goal-1", description: "Add the sample widget", status: "in_progress" }],
    tasks: [
      { id: "goal-1-task-1", goalId: "goal-1", description: "Build the widget", intent: "implementation", status: "completed", verdict: "approved", retryCount: 0 },
    ],
    tokens: { freshInput: 2_500, cacheRead: 1_450_000, cacheWrite: 30_000, output: 7_000 },
    cumulativeTokens: 1_489_500,
    tokenLimit: 0,
    worktrees: [],
    activeWorkerCount: 0,
    maxWorkers: 1,
    events: [
      { type: "session:start", payload: { sessionId: "s1", role: "worker", model: "model-a", project: "sample-project" }, timestamp: now },
    ],
  };
}

interface Page {
  window: JSDOM["window"];
  document: Document;
  send(type: string, payload: unknown): void;
}

const pages: JSDOM[] = [];

afterEach(() => {
  for (const dom of pages) dom.window.close();
  pages.length = 0;
});

async function render(): Promise<Page> {
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
      w.fetch = async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [] });
    },
  });
  pages.push(dom);
  if (!socket?.onmessage) throw new Error("dashboard.html did not open its WebSocket");
  socket.onopen?.();
  socket.onmessage({ data: JSON.stringify({ type: "state", payload: fixtureState() }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    window: dom.window,
    document: dom.window.document,
    send: (type, payload) => socket!.onmessage!({ data: JSON.stringify({ type, payload, timestamp: Date.now() }) }),
  };
}

function infoButton(page: Page, id: string): HTMLButtonElement {
  const btn = page.document.querySelector<HTMLButtonElement>(`button.tip-btn[data-tip="${id}"]`);
  if (!btn) throw new Error(`no ⓘ button for ${id}`);
  return btn;
}

function openCards(page: Page): HTMLElement[] {
  return Array.from(page.document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter((el) => !el.hidden);
}

/** The one open card, checked to be labelled by its title. */
function openCard(page: Page): { card: HTMLElement; title: string; text: string } {
  const cards = openCards(page);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  const titleEl = page.document.getElementById(card.getAttribute("aria-labelledby") ?? "");
  if (!titleEl || !card.contains(titleEl)) throw new Error("the open card is not labelled by a title inside it");
  return { card, title: titleEl.textContent ?? "", text: card.textContent ?? "" };
}

function gotIt(card: HTMLElement): HTMLButtonElement {
  const btn = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Got it");
  if (!btn) throw new Error("the card has no Got it button");
  return btn;
}

function pressEscape(page: Page): void {
  const target = page.document.activeElement ?? page.document.body;
  target.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("dashboard info tips", () => {
  it("defines a tip for each of the eight targets, 1–3 sentences plus optional steps", () => {
    expect(Object.keys(TIPS).sort()).toEqual(TARGETS.map((t) => t.id).sort());
    for (const { id, thing } of TARGETS) {
      expect(TIPS[id].title).toBe(thing);
      expect(TIPS[id].body.length).toBeGreaterThan(0);
    }
  });

  it("puts a labelled ⓘ button beside each tile label and each drill-down button", async () => {
    const page = await render();

    for (const { id, thing, near } of TARGETS) {
      const btn = infoButton(page, id);
      expect(btn.type).toBe("button");
      expect(btn.getAttribute("aria-label")).toBe(`What is ${thing}?`);
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      const controlled = page.document.getElementById(btn.getAttribute("aria-controls") ?? "");
      expect(controlled?.getAttribute("role")).toBe("dialog");

      const target = page.document.querySelector(near);
      if (!target) throw new Error(`no element matches ${near}`);
      if (DRILL_TIPS.has(id)) {
        // Beside the drill-down button, never inside it.
        expect(target.contains(btn)).toBe(false);
        expect(btn.parentElement).toBe(target.parentElement);
      } else {
        // In the same tile as the value, next to its label.
        expect(btn.closest(".mc")).toBe(target.closest(".mc"));
        expect(btn.parentElement?.querySelector(".mc-label")).not.toBeNull();
      }
    }
  });

  it("opens no tip on load or as events arrive", async () => {
    const page = await render();
    page.send("task:start", { taskId: "goal-1-task-2", goalId: "goal-1", description: "Another" });
    page.send("tokens:update", { cumulativeTokens: 10, tokens: { freshInput: 5, cacheRead: 0, cacheWrite: 0, output: 5 }, sessionTokenLimit: 0 });

    expect(openCards(page)).toHaveLength(0);
    for (const { id } of TARGETS) expect(infoButton(page, id).getAttribute("aria-expanded")).toBe("false");
  });

  it.each(TARGETS)("clicking the ⓘ for $thing opens its card with the page's tip text", async ({ id }) => {
    const page = await render();
    const btn = infoButton(page, id);

    btn.click();

    const { card, title, text } = openCard(page);
    expect(title).toBe(TIPS[id].title);
    for (const paragraph of TIPS[id].body) expect(text).toContain(paragraph);
    for (const step of TIPS[id].steps ?? []) expect(text).toContain(step);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(card.contains(page.document.activeElement)).toBe(true);
  });

  it("keeps only one card open: opening another closes the first", async () => {
    const page = await render();

    infoButton(page, "tokens").click();
    infoButton(page, "failed").click();

    expect(openCard(page).title).toBe(TIPS.failed.title);
    expect(infoButton(page, "tokens").getAttribute("aria-expanded")).toBe("false");
    expect(infoButton(page, "failed").getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when its ⓘ is clicked again", async () => {
    const page = await render();
    const btn = infoButton(page, "tasksDone");

    btn.click();
    btn.click();

    expect(openCards(page)).toHaveLength(0);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("Got it closes the card and returns focus to its ⓘ", async () => {
    const page = await render();
    const btn = infoButton(page, "firstPass");
    btn.click();

    gotIt(openCard(page).card).click();

    expect(openCards(page)).toHaveLength(0);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(page.document.activeElement).toBe(btn);
  });

  it("Esc closes the card and returns focus to its ⓘ", async () => {
    const page = await render();
    const btn = infoButton(page, "oversight");
    btn.click();

    pressEscape(page);

    expect(openCards(page)).toHaveLength(0);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(page.document.activeElement).toBe(btn);
  });

  it("a click outside closes the card and returns focus to its ⓘ", async () => {
    const page = await render();
    const btn = infoButton(page, "tokens");
    btn.click();

    (page.document.querySelector(".sh") as HTMLElement).click();

    expect(openCards(page)).toHaveLength(0);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(page.document.activeElement).toBe(btn);
  });

  it("a click outside on something that takes focus leaves focus there", async () => {
    const page = await render();
    infoButton(page, "tokens").click();
    const filter = page.document.querySelector<HTMLButtonElement>('#logFilters .log-filter[data-f="tools"]')!;

    filter.focus();
    filter.click();

    expect(openCards(page)).toHaveLength(0);
    expect(page.document.activeElement).toBe(filter);
  });

  it("a click inside the card keeps it open", async () => {
    const page = await render();
    infoButton(page, "tokens").click();
    const { card } = openCard(page);

    (card.querySelector("p") as HTMLElement).click();

    expect(openCards(page)).toHaveLength(1);
  });

  it.each(["swarmContext", "oversight", "events"])("clicking the ⓘ beside a drill-down button (%s) does not open its view", async (id) => {
    const page = await render();

    infoButton(page, id).click();

    expect(page.document.getElementById("view-summary")!.classList.contains("hidden")).toBe(false);
    for (const view of ["swarm", "oversight", "events"]) {
      expect(page.document.getElementById(`view-${view}`)!.classList.contains("hidden")).toBe(true);
    }
    expect(openCard(page).title).toBe(TIPS[id].title);
  });

  it("anchors the card under its ⓘ with the caret on it, inside a phone-width viewport", async () => {
    const page = await render();
    for (const vw of [375, 320]) {
      Object.defineProperty(page.window, "innerWidth", { value: vw, configurable: true });
      const btn = infoButton(page, "failed");
      const left = vw - 75;
      btn.getBoundingClientRect = () =>
        ({ left, right: left + 24, top: 100, bottom: 124, width: 24, height: 24, x: left, y: 100, toJSON: () => ({}) }) as DOMRect;

      btn.click();

      const { card } = openCard(page);
      const cardLeft = parseFloat(card.style.left);
      const cardWidth = parseFloat(card.style.width);
      expect(cardLeft).toBeGreaterThanOrEqual(16);
      expect(cardLeft + cardWidth).toBeLessThanOrEqual(vw - 16);
      expect(parseFloat(card.style.top)).toBeGreaterThan(124);
      const caret = card.querySelector<HTMLElement>(".tip-caret")!;
      const caretCentre = cardLeft + parseFloat(caret.style.left) + 8;
      expect(Math.abs(caretCentre - (left + 12))).toBeLessThanOrEqual(1);

      btn.click();
    }
  });

  it("turns off the card's motion under prefers-reduced-motion", async () => {
    const page = await render();
    const rules: string[] = [];
    for (const sheet of Array.from(page.document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof page.window.CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(rule.media.mediaText)) {
          for (const inner of Array.from(rule.cssRules)) rules.push(inner.cssText);
        }
      }
    }

    expect(rules.some((r) => r.includes(".tip-card") && /animation:\s*none/.test(r))).toBe(true);
  });
});
