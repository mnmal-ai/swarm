import { describe, it, expect, beforeEach } from "vitest";
import type { SwarmEventMap, ExternalItem, ExternalTaskSource, Goal, ISwarmEventBus } from "@mnmal-ai/swarm-types";
import { formatLeftForPersonComment, syncGoalLifecycle } from "../src/external-source-sync.js";

/**
 * The source-item side of two run events: what reviewers left for a person
 * (a comment listing it), and an expired login (a comment, then the item
 * swarm started goes back to its queue, so a re-run picks it up).
 */

class TestBus implements ISwarmEventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  emit<K extends keyof SwarmEventMap>(event: K, payload: SwarmEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
  on<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (payload: unknown) => void);
  }
  off<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }
  once(): void {
    throw new Error("not used");
  }
  onAny(): () => void {
    throw new Error("not used");
  }
  removeAllListeners(): void {
    this.handlers.clear();
  }
}

class RecordingSource implements ExternalTaskSource {
  readonly name = "recording";
  calls: Array<[string, string, string?]> = [];
  async fetchItems(): Promise<ExternalItem[]> {
    return [];
  }
  parseGoal(): Goal {
    throw new Error("not used");
  }
  async pushGoal(): Promise<string> {
    throw new Error("not used");
  }
  async pushTask(): Promise<string> {
    throw new Error("not used");
  }
  async updateStatus(externalId: string, status: string): Promise<void> {
    this.calls.push(["status", externalId, status]);
  }
  async postComment(externalId: string, comment: string): Promise<void> {
    this.calls.push(["comment", externalId, comment]);
  }
  async returnToQueue(externalId: string): Promise<void> {
    this.calls.push(["requeue", externalId]);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const externalIdFor = (goalId: string) => (goalId.startsWith("trello-") ? goalId.slice("trello-".length) : undefined);

describe("syncGoalLifecycle — left for a person", () => {
  let bus: TestBus;
  let source: RecordingSource;

  beforeEach(() => {
    bus = new TestBus();
    source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor });
  });

  it("comments with the items, grouped by task", async () => {
    bus.emit("goal:left_for_person", {
      goalId: "trello-aaa111",
      groups: [
        { task: "Build the settings screen", items: ["Check it on a phone", "Review the copy"] },
        { task: "Wire the API", items: ["Add the production key"] },
      ],
      timestamp: 0,
    });
    await settle();

    expect(source.calls).toEqual([[
      "comment",
      "aaa111",
      [
        "Left for a person: the reviewers passed this card's work but left 3 items for a person.",
        "",
        "Build the settings screen:",
        "- Check it on a phone",
        "- Review the copy",
        "",
        "Wire the API:",
        "- Add the production key",
      ].join("\n"),
    ]]);
  });

  it("says nothing for a goal with no items, or one not from the source", async () => {
    bus.emit("goal:left_for_person", { goalId: "trello-aaa111", groups: [], timestamp: 0 });
    bus.emit("goal:left_for_person", { goalId: "goal-1", groups: [{ task: "T", items: ["x"] }], timestamp: 0 });
    await settle();

    expect(source.calls).toEqual([]);
  });

  it("cuts a long list short and points at the pull request", () => {
    const comment = formatLeftForPersonComment([{ task: "T", items: Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`) }]);
    expect(comment).toContain("left 25 items");
    expect(comment).toContain("- Item 20");
    expect(comment).not.toContain("- Item 21");
    expect(comment).toContain("…and 5 more; the pull request lists them all.");

    const long = formatLeftForPersonComment([{ task: "T", items: ["x".repeat(400)] }]);
    expect(long).toContain(`- ${"x".repeat(299)}…`);
  });
});

describe("syncGoalLifecycle — an expired login", () => {
  let bus: TestBus;
  let source: RecordingSource;

  beforeEach(() => {
    bus = new TestBus();
    source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor });
  });

  it("puts the started goal's item back in the queue, and never marks it failed", async () => {
    bus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 2, timestamp: 0 });
    bus.emit("run:login_expired", { message: "Claude login expired", detail: "OAuth session expired", goalId: "trello-aaa111", timestamp: 0 });
    await settle();

    expect(source.calls.map(([method, , value]) => (method === "comment" ? "comment" : `${method}${value ? `:${value}` : ""}`)))
      .toEqual(["status:in_progress", "comment", "comment", "requeue"]);
    expect(source.calls[2][2]).toMatch(/login expired/);
    expect(source.calls.some(([method, , value]) => method === "status" && value === "failed")).toBe(false);
  });

  it("leaves an item alone when its goal never started", async () => {
    bus.emit("run:login_expired", { message: "Claude login expired", detail: "OAuth session expired", goalId: "trello-bbb222", timestamp: 0 });
    bus.emit("run:login_expired", { message: "Claude login expired", detail: "OAuth session expired", timestamp: 0 });
    await settle();

    expect(source.calls).toEqual([]);
  });
});
