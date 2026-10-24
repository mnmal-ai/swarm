/**
 * labelGoals names each goal for the live dashboard's badges: a label set in
 * goals.json, else (when the project names a model) the model's pick, cached
 * per source, goal and title, else the ticket's id from its URL.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Goal, ProjectConfig } from "@mnmal-ai/swarm-types";
import { assertValidLabelsConfig, labelGoals } from "../src/cli/goal-labels.js";

function goal(id: string, description: string, extra: Partial<Goal> = {}): Goal {
  return { id, description, priority: 0, status: "pending", constraints: [], acceptance_criteria: [], ...extra };
}

const card = (shortLink: string, title: string) =>
  goal(`trello-${shortLink}`, title, { url: `https://trello.com/c/${shortLink}/1-${title.toLowerCase().replace(/\W+/g, "-")}` });
const issue = (n: number, title: string) => goal(`gh-${n}`, title, { url: `https://github.com/acme/app/issues/${n}` });

/** A fake model: answers from `replies` by title, records each call, and throws for "FAIL". */
function fakeWriter(replies: Record<string, string>) {
  const calls: Array<{ title: string; source: string }> = [];
  return {
    calls,
    writer: {
      model: "test-model",
      async write(request: { title: string; source: string }) {
        calls.push(request);
        const reply = replies[request.title];
        if (reply === undefined || reply === "FAIL") throw new Error("model failed");
        return reply;
      },
    },
  };
}

let dir: string;
let cachePath: string;
let logs: string[];
const log = (line: string) => logs.push(line);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goal-labels-"));
  cachePath = join(dir, "state", "goal-labels.json");
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("labelGoals without a model (the default)", () => {
  it("labels a Trello card with its short link and a GitHub issue with its number", async () => {
    const labels = await labelGoals([card("aB3dE5fG", "Add export"), issue(42, "Fix the header")], { source: "trello", cachePath, log });
    expect(labels.get("trello-aB3dE5fG")).toBe("aB3dE5fG");
    expect(labels.get("gh-42")).toBe("#42");
  });

  it("leaves a goal with no URL unlabelled, so its badge keeps showing the goal id", async () => {
    const labels = await labelGoals([goal("goal-1", "Add export")], { source: "local", cachePath, log });
    expect(labels.has("goal-1")).toBe(false);
  });

  it("keeps a label set in goals.json, and ignores one that isn't a short single line", async () => {
    const labels = await labelGoals(
      [goal("goal-1", "Add export", { label: " Export " }), goal("goal-2", "Fix header", { label: "two\nlines" })],
      { source: "local", cachePath, log },
    );
    expect(labels.get("goal-1")).toBe("Export");
    expect(labels.has("goal-2")).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/goal-2.*label.*goals\.json/)]);
  });

  it("calls no model and writes no cache", async () => {
    await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, log });
    expect(() => readFileSync(cachePath)).toThrow();
    expect(logs).toEqual([]);
  });

  it("doesn't touch the goals, so goals.json never stores a computed label", async () => {
    const goals = [card("aB3dE5fG", "Add export")];
    await labelGoals(goals, { source: "trello", cachePath, log });
    expect(goals[0]).not.toHaveProperty("label");
  });
});

describe("labelGoals with a model", () => {
  it("labels each goal with the model's pick, sending the title and the source", async () => {
    const { writer, calls } = fakeWriter({ "Add export": "Export", "Fix the header": "Header fix" });
    const labels = await labelGoals([card("aB3dE5fG", "Add export"), issue(42, "Fix the header")], { source: "trello", cachePath, writer, log });
    expect(labels.get("trello-aB3dE5fG")).toBe("Export");
    expect(labels.get("gh-42")).toBe("Header fix");
    expect(calls).toEqual(expect.arrayContaining([{ title: "Add export", source: "trello" }, { title: "Fix the header", source: "trello" }]));
    expect(logs).toEqual(["labels: 2 picked by test-model, 0 from cache, 0 kept the ticket id"]);
  });

  it("reuses the cached label on the next run, without calling the model", async () => {
    await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: fakeWriter({ "Add export": "Export" }).writer, log });
    const second = fakeWriter({ "Add export": "Something else" });
    logs = [];
    const labels = await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: second.writer, log });
    expect(labels.get("trello-aB3dE5fG")).toBe("Export");
    expect(second.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("asks again when the title changes", async () => {
    await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: fakeWriter({ "Add export": "Export" }).writer, log });
    const second = fakeWriter({ "Add CSV export": "CSV export" });
    const labels = await labelGoals([card("aB3dE5fG", "Add CSV export")], { source: "trello", cachePath, writer: second.writer, log });
    expect(labels.get("trello-aB3dE5fG")).toBe("CSV export");
    expect(second.calls).toHaveLength(1);
  });

  it("keys the cache by source as well as goal id", async () => {
    await labelGoals([goal("goal-1", "Add export")], { source: "local", cachePath, writer: fakeWriter({ "Add export": "Export" }).writer, log });
    const other = fakeWriter({ "Add export": "Exports" });
    const labels = await labelGoals([goal("goal-1", "Add export")], { source: "github", cachePath, writer: other.writer, log });
    expect(labels.get("goal-1")).toBe("Exports");
    expect(other.calls).toHaveLength(1);
  });

  it("falls back to the URL id when the model fails, and asks again next run", async () => {
    const failing = fakeWriter({ "Add export": "FAIL" });
    const labels = await labelGoals([card("aB3dE5fG", "Add export"), issue(42, "Fix the header")], { source: "trello", cachePath, writer: failing.writer, log });
    expect(labels.get("trello-aB3dE5fG")).toBe("aB3dE5fG");
    expect(labels.get("gh-42")).toBe("#42");
    expect(logs).toEqual(["labels: 0 picked by test-model, 0 from cache, 2 kept the ticket id"]);

    const working = fakeWriter({ "Add export": "Export", "Fix the header": "Header fix" });
    const again = await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: working.writer, log });
    expect(again.get("trello-aB3dE5fG")).toBe("Export");
    expect(working.calls).toHaveLength(1);
  });

  it("falls back to the goal id's badge for a goal with no URL when the model fails", async () => {
    const labels = await labelGoals([goal("goal-1", "Add export")], { source: "local", cachePath, writer: fakeWriter({}).writer, log });
    expect(labels.has("goal-1")).toBe(false);
  });

  it("ends the model call at the time budget and keeps the ticket id", async () => {
    let signal: AbortSignal | undefined;
    const slow = {
      model: "slow-model",
      write: (_request: unknown, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise<string>((resolve) => setTimeout(() => resolve("Too late"), 1_000));
      },
    };
    const started = Date.now();
    const labels = await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: slow, log, budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
    expect(labels.get("trello-aB3dE5fG")).toBe("aB3dE5fG");
    expect(logs).toEqual(["labels: 0 picked by slow-model, 0 from cache, 1 kept the ticket id"]);
  });

  it("keeps the labels another run saved while this one was waiting", async () => {
    const other = { model: "m", write: async () => "Other" };
    const writer = {
      model: "m",
      // While this run waits on its model, a second run labels its own goal and saves it.
      async write() {
        await labelGoals([goal("goal-2", "Fix header")], { source: "local", cachePath, writer: other, log });
        return "Mine";
      },
    };
    await labelGoals([goal("goal-1", "Add export")], { source: "local", cachePath, writer, log });
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(Object.keys(cache.entries).sort()).toEqual(["local:goal-1", "local:goal-2"]);
  });

  it("runs a few calls at once", async () => {
    let running = 0;
    let most = 0;
    const writer = {
      model: "m",
      async write() {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running--;
        return "Label";
      },
    };
    const goals = Array.from({ length: 10 }, (_, i) => goal(`goal-${i}`, `Ticket ${i}`));
    await labelGoals(goals, { source: "local", cachePath, writer, log });
    expect(most).toBe(4);
  });

  it("prefers a label set in goals.json over the model", async () => {
    const { writer, calls } = fakeWriter({ "Add export": "Export" });
    const labels = await labelGoals([goal("goal-1", "Add export", { label: "Mine" })], { source: "local", cachePath, writer, log });
    expect(labels.get("goal-1")).toBe("Mine");
    expect(calls).toEqual([]);
  });

  it("ignores an unreadable cache, and a cached label that isn't one", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "state"));
    writeFileSync(cachePath, "not json");
    const first = fakeWriter({ "Add export": "Export" });
    expect((await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: first.writer, log })).get("trello-aB3dE5fG")).toBe("Export");

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    for (const entry of Object.values(cache.entries) as Array<{ label: string }>) entry.label = "a label much too long for a badge";
    writeFileSync(cachePath, JSON.stringify(cache));
    const second = fakeWriter({ "Add export": "Export again" });
    expect((await labelGoals([card("aB3dE5fG", "Add export")], { source: "trello", cachePath, writer: second.writer, log })).get("trello-aB3dE5fG")).toBe("Export again");
  });

  it("keeps the cache small, dropping the oldest entries", async () => {
    let clock = 0;
    const writer = { model: "m", write: async (r: { title: string }) => r.title.slice(0, 16) };
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      await labelGoals([goal(`goal-${i}`, `T${i}`)], { source: "local", cachePath, writer, log, maxEntries: 3, now: () => clock });
    }
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(Object.keys(cache.entries).sort()).toEqual(["local:goal-2", "local:goal-3", "local:goal-4"]);
  });
});

describe("assertValidLabelsConfig", () => {
  const config = (labels: unknown) => ({ taskBackendConfig: { type: "trello", labels } }) as unknown as ProjectConfig;

  it("accepts no labels block or a model id", () => {
    expect(() => assertValidLabelsConfig({} as ProjectConfig, "config.json")).not.toThrow();
    expect(() => assertValidLabelsConfig(config({ model: "claude-haiku-4-5-20251001" }), "config.json")).not.toThrow();
  });

  it("refuses a malformed block, naming the file and each problem", () => {
    expect(() => assertValidLabelsConfig(config({ model: "", mode: "model" }), "/p/config.json")).toThrow(
      /Invalid taskBackendConfig.labels in \/p\/config.json:\n  - labels.mode is not a setting.*\n  - labels.model must be a model id/s,
    );
  });
});
