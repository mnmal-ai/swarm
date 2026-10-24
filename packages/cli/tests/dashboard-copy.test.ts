/**
 * Copy buttons on the dashboard's long text: an expanded event's detail in the
 * Event Log and the Full Event Log, a transcript's prompt and response, and an
 * expanded task's or subtask's description. Each copies its block's full text,
 * not the shortened preview, and says "Copied" for a moment.
 *
 * The page is often opened over plain http on the LAN from a phone, which is
 * not a secure context, so navigator.clipboard is missing there: the button
 * falls back to an off-screen textarea and execCommand('copy'), and when that
 * fails too it selects the block so the reader can copy it by hand.
 *
 * The log keeps drawing as events arrive, so a row someone is reading keeps its
 * expanded state, its open transcript and its copy feedback across an update.
 * Renders the real page in jsdom, as the other dashboard-*.test.ts files do.
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
type Opts = {
  /** window.isSecureContext: false is a plain-http LAN address. */
  secure?: boolean;
  /** navigator.clipboard.writeText; absent unless given, as on an insecure page. */
  writeText?: (text: string) => Promise<void>;
  /** document.execCommand. */
  execCommand?: (command: string) => boolean;
};

const PROMPT = `PROMPT START\n${"Add a recipes list to the acme app. ".repeat(200)}\nPROMPT END`;
const RESPONSE = `RESPONSE START\n${"Added RecipeListScreen with a search field. ".repeat(150)}\nRESPONSE END`;

async function open(events: Sent[], opts: Opts = {}): Promise<{ dom: JSDOM; send: (...e: Sent[]) => Promise<void> }> {
  let socket: { onopen?: () => void; onmessage?: (ev: { data: string }) => void } | undefined;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://192.168.1.20:3141/",
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
        if (String(url).startsWith("/api/transcript/")) return { ok: true, status: 200, json: async () => ({ sessionId: "s1", prompt: PROMPT, response: RESPONSE }) };
        return { ok: true, status: 200, json: async () => [] };
      };
      Object.defineProperty(window, "isSecureContext", { value: opts.secure ?? false, configurable: true });
      if (opts.writeText) Object.defineProperty(window.navigator, "clipboard", { value: { writeText: opts.writeText }, configurable: true });
      if (opts.execCommand) (window.document as unknown as { execCommand: unknown }).execCommand = opts.execCommand;
    },
  });
  doms.push(dom);
  if (!socket?.onmessage) throw new Error("dashboard.html did not open its WebSocket");
  socket.onopen?.();
  const s = socket;
  const send = async (...evs: Sent[]) => {
    for (const e of evs) s.onmessage!({ data: JSON.stringify({ type: e.type, payload: e.payload, timestamp: e.timestamp ?? Date.now() }) });
    await settle();
  };
  await send(...events);
  return { dom, send };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = (dom: JSDOM, log = "#logWrap") => Array.from(dom.window.document.querySelectorAll<HTMLElement>(`${log} .log-entry`));
const rowWith = (dom: JSDOM, text: string, log = "#logWrap") => rows(dom, log).find((r) => r.textContent?.includes(text))!;
const expand = (row: HTMLElement) => row.querySelector<HTMLElement>(".log-expand")!.click();
const copyIn = (el: Element) => el.querySelector<HTMLButtonElement>(".copy-btn")!;

/** A payload whose detail the log shortens: its JSON is far over the log's 2,000 characters. */
const BIG = { note: "recipes export", blob: "z".repeat(40_000) };
const bigEvent: Sent = { type: "custom:thing", payload: BIG };

describe("dashboard: copy buttons", () => {
  it("puts a copy button on an expanded event's detail, which copies the full text, not the shortened preview", async () => {
    const copied: string[] = [];
    const { dom } = await open([bigEvent], { secure: true, writeText: async (t) => { copied.push(t); } });
    const row = rowWith(dom, "recipes export");
    expect(row.querySelector(".log-detail")!.textContent!.length).toBeLessThan(2_200);

    expand(row);
    const btn = copyIn(row);
    expect(btn.getAttribute("aria-label")).toBe("Copy");
    expect(btn.querySelector("svg")).not.toBeNull();
    btn.click();
    await settle();
    expect(copied).toEqual([JSON.stringify(BIG)]);
    expect(btn.textContent).toBe("Copied");
    expect(row.classList.contains("expanded")).toBe(true);
  });

  it("puts the same button on an expanded event in the Full Event Log", async () => {
    const copied: string[] = [];
    const { dom } = await open([bigEvent], { secure: true, writeText: async (t) => { copied.push(t); } });
    (dom.window as unknown as { showView(n: string): void }).showView("events");
    const row = rowWith(dom, "recipes export", "#logWrapFull");
    expand(row);
    copyIn(row).click();
    await settle();
    expect(copied).toEqual([JSON.stringify(BIG)]);
    expect(copyIn(row).textContent).toBe("Copied");
  });

  it("copies with an off-screen textarea and execCommand on a plain-http page, where the Clipboard API is missing", async () => {
    const seen: Array<{ command: string; value?: string; readOnly?: boolean; start?: number | null; end?: number | null }> = [];
    let doc: Document | undefined;
    const { dom } = await open([bigEvent], {
      secure: false,
      execCommand: (command) => {
        const ta = doc!.querySelector("textarea");
        seen.push({ command, value: ta?.value, readOnly: ta?.readOnly, start: ta?.selectionStart, end: ta?.selectionEnd });
        return true;
      },
    });
    doc = dom.window.document;
    const row = rowWith(dom, "recipes export");
    expand(row);
    copyIn(row).click();
    await settle();
    const full = JSON.stringify(BIG);
    expect(seen).toEqual([{ command: "copy", value: full, readOnly: true, start: 0, end: full.length }]);
    expect(doc.querySelector("textarea")).toBeNull();
    expect(copyIn(row).textContent).toBe("Copied");
  });

  it("falls back to execCommand when the Clipboard API refuses", async () => {
    const commands: string[] = [];
    const { dom } = await open([bigEvent], {
      secure: true,
      writeText: async () => { throw new Error("NotAllowedError"); },
      execCommand: (c) => { commands.push(c); return true; },
    });
    const row = rowWith(dom, "recipes export");
    expand(row);
    copyIn(row).click();
    await settle();
    expect(commands).toEqual(["copy"]);
    expect(copyIn(row).textContent).toBe("Copied");
  });

  it("selects the block so it can be copied by hand when neither way works, and says so", async () => {
    const { dom } = await open([{ type: "transcript", payload: { sessionId: "s1", transcriptId: "t1", role: "worker", backend: "claude-code", promptBytes: 9_000, responseBytes: 6_000 } }], {
      secure: false,
      execCommand: () => false,
    });
    const row = rowWith(dom, "worker");
    row.querySelector<HTMLButtonElement>(".log-open")!.click();
    await settle();
    const prompt = Array.from(row.querySelectorAll(".log-tpart")).find((p) => p.textContent?.includes("PROMPT START"))!;
    copyIn(prompt).click();
    await settle();
    expect(copyIn(prompt).textContent).toBe("Select and copy");
    expect(dom.window.getSelection()!.toString()).toBe(PROMPT);
  });

  it("gives a transcript's prompt and response a copy button each, copying its own full text", async () => {
    const copied: string[] = [];
    const { dom } = await open([{ type: "transcript", payload: { sessionId: "s1", transcriptId: "t1", role: "worker", backend: "claude-code", promptBytes: 9_000, responseBytes: 6_000 } }], {
      secure: true,
      writeText: async (t) => { copied.push(t); },
    });
    const row = rowWith(dom, "worker");
    row.querySelector<HTMLButtonElement>(".log-open")!.click();
    await settle();
    const parts = Array.from(row.querySelectorAll(".log-tpart"));
    expect(parts.map((p) => p.querySelector(".log-tpart-label")?.textContent)).toEqual(["PROMPT", "RESPONSE"]);
    for (const p of parts) expect(copyIn(p).getAttribute("aria-label")).toBe("Copy");
    copyIn(parts[1]).click();
    copyIn(parts[0]).click();
    await settle();
    expect(copied).toEqual([RESPONSE, PROMPT]);
  });

  it("keeps a row expanded, its transcript open and its feedback showing across a live update, then shows the icon again", async () => {
    const copied: string[] = [];
    const { dom, send } = await open(
      [bigEvent, { type: "transcript", payload: { sessionId: "s1", transcriptId: "t1", role: "reviewer", backend: "claude-code", promptBytes: 9_000, responseBytes: 6_000 } }],
      { secure: true, writeText: async (t) => { copied.push(t); } },
    );
    const row = rowWith(dom, "recipes export");
    expand(row);
    const tRow = rowWith(dom, "reviewer");
    tRow.querySelector<HTMLButtonElement>(".log-open")!.click();
    await settle();
    copyIn(row).click();
    await settle();

    await send({ type: "orchestration:event", payload: { eventType: "step", detail: "another event arrives" } });
    expect(rows(dom).some((r) => r.textContent?.includes("another event arrives"))).toBe(true);
    // The same rows, not redrawn ones: a selection or a reader's place in them survives.
    expect(row.isConnected).toBe(true);
    expect(tRow.isConnected).toBe(true);
    expect(row.classList.contains("expanded")).toBe(true);
    expect(copyIn(row).textContent).toBe("Copied");
    expect(tRow.textContent).toContain("PROMPT START");

    await settle(1_700);
    expect(copyIn(row).getAttribute("aria-label")).toBe("Copy");
    expect(copyIn(row).querySelector("svg")).not.toBeNull();
  });

  it("keeps a transcript open when its row is drawn again, as after a filter change", async () => {
    const { dom } = await open([{ type: "transcript", payload: { sessionId: "s1", transcriptId: "t1", role: "worker", backend: "claude-code", promptBytes: 9_000, responseBytes: 6_000 } }], { secure: true, writeText: async () => {} });
    rowWith(dom, "worker").querySelector<HTMLButtonElement>(".log-open")!.click();
    await settle();
    const w = dom.window as unknown as { setFilter(f: string): void };
    w.setFilter("tools");
    w.setFilter("all");
    const again = rowWith(dom, "worker");
    expect(again.textContent).toContain("RESPONSE START");
    expect(again.querySelector(".log-open")?.textContent).toBe("Close");
  });

  it("copies an expanded task's description without collapsing the card, and a subtask's", async () => {
    const copied: string[] = [];
    const desc = "Build the recipes list screen.\n\nA search field filters by title and by ingredient; an empty search shows every recipe.";
    const subDesc = "Add the search field to the acme recipes list header.";
    const { dom, send } = await open(
      [
        { type: "goal:start", payload: { goalId: "goal-1", description: "Add a recipes list" } },
        { type: "goal:decomposed", payload: { goalId: "goal-1", tasks: [{ id: "goal-1-task-1", title: "feat(recipes): list screen", description: desc, intent: "implementation" }] } },
        { type: "task:start", payload: { taskId: "goal-1-task-1-sub-1", goalId: "goal-1", parentTaskId: "goal-1-task-1", description: subDesc, intent: "implementation" } },
      ],
      { secure: true, writeText: async (t) => { copied.push(t); } },
    );
    const doc = dom.window.document;
    const card = () => doc.querySelector<HTMLElement>('.task-card[data-task-id="goal-1-task-1"]')!;
    card().click();
    expect(card().classList.contains("expanded")).toBe(true);
    const btn = copyIn(card().querySelector(".task-expanded-body")!);
    expect(btn.getAttribute("aria-label")).toBe("Copy");
    btn.click();
    await settle();
    expect(copied).toEqual([desc]);
    expect(card().classList.contains("expanded")).toBe(true);

    const sub = () => card().querySelector<HTMLElement>(".subtask-card")!;
    sub().click();
    expect(sub().classList.contains("expanded")).toBe(true);
    copyIn(sub().querySelector(".subtask-expanded-body")!).click();
    await settle();
    expect(copied).toEqual([desc, subDesc]);
    expect(sub().classList.contains("expanded")).toBe(true);
    expect(card().classList.contains("expanded")).toBe(true);

    // The board is drawn again on every event; the feedback carries over to the new button.
    await send({ type: "orchestration:event", payload: { eventType: "step", detail: "tick" } });
    expect(copyIn(card().querySelector(".task-expanded-body")!).textContent).toBe("Copied");
  });
});
