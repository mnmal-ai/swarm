import { describe, it, expect, beforeEach } from "vitest";
import type {
  SwarmEventMap,
  ExternalItem,
  ExternalTaskSource,
  Goal,
  ISwarmEventBus,
} from "@mnmal-ai/swarm-types";
import { syncGoalLifecycle } from "../src/external-source-sync.js";

// ---------------------------------------------------------------------------
// Test doubles: a minimal event bus and a source that records what it is told
// ---------------------------------------------------------------------------

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

type Call = [method: "status" | "comment", externalId: string, value: string];

class RecordingSource implements ExternalTaskSource {
  readonly name = "recording";
  calls: Call[] = [];
  failWith: Error | null = null;

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
    if (this.failWith) throw this.failWith;
    this.calls.push(["status", externalId, status]);
  }
  async postComment(externalId: string, comment: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.calls.push(["comment", externalId, comment]);
  }
}

/** A source whose every call stays in flight until the test finishes it. */
class SlowSource extends RecordingSource {
  inFlight: (() => void)[] = [];
  failNext = false;

  private async inFlightUntilFinished(): Promise<void> {
    await new Promise<void>((finish) => this.inFlight.push(finish));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("HTTP 502");
    }
  }
  override async updateStatus(externalId: string, status: string): Promise<void> {
    await this.inFlightUntilFinished();
    await super.updateStatus(externalId, status);
  }
  override async postComment(externalId: string, comment: string): Promise<void> {
    await this.inFlightUntilFinished();
    await super.postComment(externalId, comment);
  }

  /** Finish in-flight calls newest first, as a faster round-trip would. */
  async finishAllNewestFirst(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await settle();
      this.inFlight.pop()?.();
    }
  }
}

/** Handlers are async; let their promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const externalIdFor = (goalId: string) => (goalId.startsWith("trello-") ? goalId.slice("trello-".length) : undefined);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncGoalLifecycle", () => {
  let bus: TestBus;
  let source: RecordingSource;
  let errors: unknown[];

  beforeEach(() => {
    bus = new TestBus();
    source = new RecordingSource();
    errors = [];
    syncGoalLifecycle(bus, source, { externalIdFor, onError: (err) => errors.push(err) });
  });

  it("marks the item in progress when its goal starts", async () => {
    bus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 3, timestamp: 0 });
    await settle();

    expect(source.calls[0]).toEqual(["status", "aaa111", "in_progress"]);
    expect(source.calls[1][0]).toBe("comment");
    expect(source.calls[1][2]).toMatch(/3 tasks/);
  });

  it("ignores goals that did not come from the source", async () => {
    bus.emit("goal:start", { goalId: "goal-1", description: "x", taskCount: 3, timestamp: 0 });
    await settle();

    expect(source.calls).toEqual([]);
  });

  it("posts the pull request and hands the item to review when a PR opens", async () => {
    bus.emit("source_control:pr_created", {
      goalId: "trello-aaa111",
      branch: "swarm/goal-trello-aaa111",
      prUrl: "https://github.com/o/r/pull/7",
      timestamp: 0,
    });
    await settle();

    expect(source.calls[0][0]).toBe("comment");
    expect(source.calls[0][2]).toContain("https://github.com/o/r/pull/7");
    expect(source.calls[1]).toEqual(["status", "aaa111", "completed"]);
  });

  it("does not hand a finished goal to review before its pull request exists", async () => {
    bus.emit("goal:completed", { goalId: "trello-aaa111", completedTasks: 3, totalTasks: 3, totalTokens: 0, timestamp: 0 });
    await settle();

    expect(source.calls.filter(([method]) => method === "status")).toEqual([]);
    expect(source.calls[0][0]).toBe("comment");
    expect(source.calls[0][2]).toMatch(/3 of 3 tasks/);
  });

  it("marks the item failed when any of its tasks did not complete", async () => {
    bus.emit("goal:completed", { goalId: "trello-aaa111", completedTasks: 1, totalTasks: 3, totalTokens: 0, timestamp: 0 });
    await settle();

    expect(source.calls[0][0]).toBe("comment");
    expect(source.calls[0][2]).toMatch(/1 of 3 tasks/);
    expect(source.calls[1]).toEqual(["status", "aaa111", "failed"]);
  });

  it("reports an escalated task on its goal's item, with the reason", async () => {
    bus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 1, timestamp: 0 });
    await settle();
    source.calls = [];

    bus.emit("task:escalated", {
      taskId: "trello-aaa111-task-2",
      reason: "turn_threshold",
      detail: "worker ran out of turns",
      timestamp: 0,
    });
    await settle();

    expect(source.calls).toHaveLength(1);
    expect(source.calls[0][1]).toBe("aaa111");
    expect(source.calls[0][2]).toContain("trello-aaa111-task-2");
    expect(source.calls[0][2]).toContain("turn_threshold");
  });

  it("never copies worker output onto the item", async () => {
    bus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 1, timestamp: 0 });
    await settle();
    source.calls = [];

    bus.emit("task:escalated", {
      taskId: "trello-aaa111-task-1",
      reason: "reviewer_rejection",
      detail: "const secretLookingThing = readFixture('people.ts')",
      timestamp: 0,
    });
    await settle();

    expect(source.calls[0][2]).not.toContain("secretLookingThing");
    expect(source.calls[0][2]).toMatch(/run log/);
  });

  it("reports failures to onError instead of throwing into the event bus", async () => {
    source.failWith = new Error("HTTP 429");

    expect(() =>
      bus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 1, timestamp: 0 }),
    ).not.toThrow();
    await settle();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("HTTP 429");
  });

  it("applies one item's updates in event order, even when a later call would finish first", async () => {
    const slowBus = new TestBus();
    const slow = new SlowSource();
    syncGoalLifecycle(slowBus, slow, { externalIdFor });

    slowBus.emit("goal:completed", { goalId: "trello-aaa111", completedTasks: 1, totalTasks: 3, totalTokens: 0, timestamp: 0 });
    slowBus.emit("source_control:pr_created", {
      goalId: "trello-aaa111",
      branch: "swarm/goal-trello-aaa111",
      prUrl: "https://github.com/o/r/pull/7",
      timestamp: 0,
    });
    await slow.finishAllNewestFirst();

    expect(slow.calls.map(([method, , value]) => (method === "status" ? value : "comment"))).toEqual([
      "comment", "failed", "comment", "completed",
    ]);
  });

  it("keeps applying an item's updates after one of them fails", async () => {
    const slowBus = new TestBus();
    const slow = new SlowSource();
    const slowErrors: unknown[] = [];
    syncGoalLifecycle(slowBus, slow, { externalIdFor, onError: (err) => slowErrors.push(err) });
    slow.failNext = true;

    slowBus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 1, timestamp: 0 });
    slowBus.emit("source_control:pr_created", {
      goalId: "trello-aaa111",
      branch: "swarm/goal-trello-aaa111",
      prUrl: "https://github.com/o/r/pull/7",
      timestamp: 0,
    });
    await slow.finishAllNewestFirst();

    expect(String(slowErrors[0])).toContain("HTTP 502");
    expect(slow.calls.at(-1)).toEqual(["status", "aaa111", "completed"]);
  });

  it("stops syncing once detached", async () => {
    const detachBus = new TestBus();
    const detachSource = new RecordingSource();
    const detach = syncGoalLifecycle(detachBus, detachSource, { externalIdFor });

    detach();
    detachBus.emit("goal:start", { goalId: "trello-aaa111", description: "x", taskCount: 1, timestamp: 0 });
    await settle();

    expect(detachSource.calls).toEqual([]);
  });
});

describe("syncGoalLifecycle with merge_prs", () => {
  const merged = { goalId: "trello-m1", branch: "swarm/goal-m1", prUrl: "https://example.test/pull/7", mergeCommit: "0123456789abcdef0123", base: "main", timestamp: 0 };

  it("names the merge commit and moves the item to merged after a merge", async () => {
    const bus = new TestBus();
    const source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor, mergePrs: { afterMerge: "done" } });
    bus.emit("source_control:pr_merged", merged);
    await settle();
    expect(source.calls).toEqual([
      ["comment", "m1", "Pull request merged into main as 0123456789ab: https://example.test/pull/7"],
      ["status", "m1", "merged"],
    ]);
  });

  it("leaves the item where it is when after_merge is review", async () => {
    const bus = new TestBus();
    const source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor, mergePrs: { afterMerge: "review" } });
    bus.emit("source_control:pr_merged", merged);
    await settle();
    expect(source.calls).toEqual([["comment", "m1", "Pull request merged into main as 0123456789ab: https://example.test/pull/7"]]);
  });

  it("posts swarm's reason when a PR is left open", async () => {
    const bus = new TestBus();
    const source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor, mergePrs: { afterMerge: "done" } });
    bus.emit("source_control:merge_skipped", {
      goalId: "trello-m2",
      branch: "swarm/goal-m2",
      prUrl: "https://example.test/pull/8",
      reason: "the merge gate failed (exit 1); its output is in the run log",
      timestamp: 0,
    });
    await settle();
    expect(source.calls).toEqual([
      ["comment", "m2", "Swarm did not merge https://example.test/pull/8: the merge gate failed (exit 1); its output is in the run log."],
    ]);
  });

  it("says the pull request follows now when a goal finishes", async () => {
    const bus = new TestBus();
    const source = new RecordingSource();
    syncGoalLifecycle(bus, source, { externalIdFor, mergePrs: { afterMerge: "done" } });
    bus.emit("goal:completed", { goalId: "trello-m3", completedTasks: 2, totalTasks: 2, totalTokens: 0, timestamp: 0 });
    await settle();
    expect(source.calls).toEqual([["comment", "m3", "Swarm finished 2 of 2 tasks. The pull request follows now."]]);
  });
});
