// Failure postmortem recorder unit tests.
//
// Covers the data-plane half of Stage 1 of the failure-introspection
// roadmap: that ring buffers cap correctly, that wedge events trigger
// artifact writes with active-tools populated, that oversight
// rejections AND arbiter escalations trigger writes via the verdict
// path, that approved verdicts do NOT trigger writes (verified via
// event-listening, not timing-based sleep), and that the synthesized
// tool-call entries from Claude Code's backend:progress stream get
// attributed to the active task.

import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FailurePostmortemRecorder,
  type LineageNode,
} from "../src/cli/failure-postmortem.js";

/**
 * Minimal Substrate-client stand-in: capture every `createFailurePostmortem`
 * mutation call so the test can assert on the persisted payload without
 * standing up a real Substrate sidecar.
 */
function makeFakeSubstrate() {
  const captures: Array<{ mutation: string; params: Record<string, unknown> }> = [];
  let nextId = 1;
  return {
    captures,
    client: {
      async mutate<T>(
        mutation: string,
        params: Record<string, unknown>,
        _fields: unknown,
      ): Promise<T> {
        captures.push({ mutation, params });
        return { id: `fp-${nextId++}` } as unknown as T;
      },
    } as unknown as import("@mnmal-ai/swarm-substrate").SubstrateClient,
  };
}

function lastPostmortem(captures: Array<{ mutation: string; params: Record<string, unknown> }>) {
  const last = captures.filter((c) => c.mutation === "createFailurePostmortem").pop();
  if (!last) throw new Error("no createFailurePostmortem capture found");
  return last.params;
}

let fake: ReturnType<typeof makeFakeSubstrate>;

beforeEach(() => {
  fake = makeFakeSubstrate();
});

afterEach(() => {
  fake.captures.length = 0;
});

function makeRecorder(eventBus: SwarmEventBus, opts?: {
  toolRingSize?: number;
  transcriptRingSize?: number;
  lineage?: LineageNode[];
  goalId?: string | null;
  substrateClient?: import("@mnmal-ai/swarm-substrate").SubstrateClient;
}): FailurePostmortemRecorder {
  const recorder = new FailurePostmortemRecorder({
    runId: "test-run",
    eventBus,
    substrateClient: opts?.substrateClient ?? fake.client,
    resolveLineage: async () =>
      opts?.lineage ?? [{ taskId: "t-1", intent: "implementation", description: "test", parentTaskId: null }],
    resolveGoalId: async () => opts?.goalId ?? "goal-1",
    toolRingSize: opts?.toolRingSize,
    transcriptRingSize: opts?.transcriptRingSize,
  });
  return recorder;
}

/**
 * Wait for the recorder to write a postmortem via Substrate. The recorder's
 * Substrate path is async (it awaits `substrateClient.mutate`), so a synchronous
 * event emit returns before the artifact is persisted. Race the
 * `task:postmortem_written` event against a deadline.
 */
async function waitForWrite(bus: SwarmEventBus, timeoutMs = 1000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("postmortem never written")), timeoutMs);
    bus.on("task:postmortem_written", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("FailurePostmortemRecorder", () => {
  it("persists a postmortem when a tool wedge fires", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    bus.emit("task:start", {
      taskId: "t-1",
      goalId: "goal-1",
      description: "smoke task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    bus.emit("tool:start", {
      turn: 1,
      toolName: "Bash",
      toolInput: { command: "pnpm verify:vercel" },
      toolUseId: "toolu_01",
      taskId: "t-1",
      timestamp: Date.now(),
    });

    bus.emit("task:tool_wedged", {
      taskId: "t-1",
      activeToolCount: 1,
      elapsedMs: 305_000,
      thresholdMs: 300_000,
      activeTools: [
        { toolUseId: "toolu_01", name: "Bash", startedAt: Date.now() - 305_000, ageMs: 305_000, inputPreview: "pnpm verify" },
      ],
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    const params = lastPostmortem(fake.captures);

    expect(params.schemaVersion).toBe(1);
    expect(params.taskId).toBe("t-1");
    expect(params.goalId).toBe("goal-1");
    expect(params.failureCategory).toBe("tool_wedge");

    const activeTools = JSON.parse(params.activeToolsAtFailure as string);
    expect(activeTools).toHaveLength(1);
    expect(activeTools[0].toolUseId).toBe("toolu_01");

    const recentToolCalls = JSON.parse(params.recentToolCalls as string);
    expect(recentToolCalls).toHaveLength(1);
    expect(recentToolCalls[0].outcome).toBe("in_flight");

    const lineage = JSON.parse(params.lineage as string);
    expect(lineage[0].taskId).toBe("t-1");

    recorder.stop();
  });

  it("persists a postmortem when a task verdict is rejected", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    bus.emit("task:start", {
      taskId: "t-2",
      goalId: "goal-1",
      description: "verdict task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    bus.emit("task:verdict", {
      taskId: "t-2",
      verdict: "rejected",
      latencyMs: 42_000,
      tokens: { freshInput: 1_000, cacheRead: 40_000, cacheWrite: 2_000, output: 800 },
      retryCount: 1,
      arbiterInvolved: false,
      failureReason: "Reviewer rejected: missing curl evidence for AC3.",
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    const params = lastPostmortem(fake.captures);
    expect(params.failureCategory).toBe("oversight_rejected");
    const verdict = JSON.parse(params.taskVerdict as string);
    expect(verdict.failureReason).toContain("missing curl evidence");
    // Tokens only: the postmortem records the task's split and no dollar figure.
    expect(verdict.tokens).toEqual({ freshInput: 1_000, cacheRead: 40_000, cacheWrite: 2_000, output: 800 });
    expect(verdict).not.toHaveProperty("costUsd");

    recorder.stop();
  });

  it("persists a postmortem when an arbiter escalation fires (verdict='escalate')", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    bus.emit("task:start", {
      taskId: "t-esc",
      goalId: "goal-1",
      description: "escalation task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    bus.emit("task:verdict", {
      taskId: "t-esc",
      verdict: "escalate",
      latencyMs: 60_000,
      retryCount: 0,
      arbiterInvolved: true,
      failureReason: "Arbiter: ambiguous — needs human judgment",
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    const params = lastPostmortem(fake.captures);
    // Same category as rejected — both are "not approved" failures.
    expect(params.failureCategory).toBe("oversight_rejected");
    const verdict = JSON.parse(params.taskVerdict as string);
    expect(verdict.failureReason).toContain("ambiguous");

    recorder.stop();
  });

  it("does NOT persist a postmortem when a verdict is approved", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    // Race: a postmortem write would fire `task:postmortem_written`
    // before the 200ms timeout. If no event fires, the timer resolves
    // and the assertion passes. Replaces the timing-based fs.access
    // probe from the prior revision (a review comment).
    const noWriteWithin200ms = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      bus.on("task:postmortem_written", () => {
        clearTimeout(timer);
        reject(new Error("postmortem was written for an approved verdict"));
      });
    });

    bus.emit("task:start", {
      taskId: "t-3",
      goalId: "goal-1",
      description: "happy task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    bus.emit("task:verdict", {
      taskId: "t-3",
      verdict: "approved",
      latencyMs: 20_000,
      retryCount: 0,
      arbiterInvolved: false,
      timestamp: Date.now(),
    });

    await noWriteWithin200ms;
    expect(fake.captures.length).toBe(0);

    recorder.stop();
  });

  it("caps the tool-call ring buffer at the configured size", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus, { toolRingSize: 3 });
    recorder.start();

    bus.emit("task:start", {
      taskId: "t-4",
      goalId: "goal-1",
      description: "ring task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    for (let i = 0; i < 7; i++) {
      bus.emit("tool:start", {
        turn: 1,
        toolName: "Read",
        toolInput: { file_path: `/tmp/file-${i}.txt` },
        toolUseId: `toolu_${i}`,
        taskId: "t-4",
        timestamp: Date.now(),
      });
    }

    bus.emit("task:tool_wedged", {
      taskId: "t-4",
      activeToolCount: 1,
      elapsedMs: 305_000,
      thresholdMs: 300_000,
      activeTools: [],
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    const params = lastPostmortem(fake.captures);
    const recentToolCalls = JSON.parse(params.recentToolCalls as string);
    expect(recentToolCalls).toHaveLength(3);
    // The oldest 4 entries should be dropped; the last 3 (4, 5, 6) survive.
    expect(recentToolCalls[0].toolUseId).toBe("toolu_4");
    expect(recentToolCalls[2].toolUseId).toBe("toolu_6");

    recorder.stop();
  });

  it("synthesizes tool-call entries from backend:progress events when tool:start is absent", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    bus.emit("task:start", {
      taskId: "t-5",
      goalId: "goal-1",
      description: "claude-code task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    // Simulate the Claude Code backend's progress event shape.
    bus.emit("backend:progress", {
      type: "tool_call",
      detail: "Calling: Bash, Read",
      timestamp: Date.now(),
      meta: {
        tools: ["Bash", "Read"],
        count: 2,
        inputs: [
          { tool: "Bash", preview: "pnpm typecheck" },
          { tool: "Read", preview: "/etc/passwd" },
        ],
        toolUseIds: ["toolu_a", "toolu_b"],
      },
    });

    bus.emit("task:tool_wedged", {
      taskId: "t-5",
      activeToolCount: 2,
      elapsedMs: 305_000,
      thresholdMs: 300_000,
      activeTools: [],
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    const params = lastPostmortem(fake.captures);
    const recentToolCalls = JSON.parse(params.recentToolCalls as string);
    expect(recentToolCalls).toHaveLength(2);
    expect(recentToolCalls.map((t: { toolName: string }) => t.toolName)).toEqual(["Bash", "Read"]);
    expect(recentToolCalls.map((t: { toolUseId: string }) => t.toolUseId)).toEqual(["toolu_a", "toolu_b"]);
    expect(recentToolCalls[0].outcome).toBe("in_flight");

    recorder.stop();
  });

  it("emits task:postmortem_written with the Substrate entity id", async () => {
    const bus = new SwarmEventBus();
    const recorder = makeRecorder(bus);
    recorder.start();

    const writtenEvents: Array<{ taskId: string; postmortemId: string; failureCategory: string }> = [];
    bus.on("task:postmortem_written", (e) => {
      writtenEvents.push({
        taskId: e.taskId,
        postmortemId: e.postmortemId,
        failureCategory: e.failureCategory,
      });
    });

    bus.emit("task:start", {
      taskId: "t-id",
      goalId: "goal-1",
      description: "id task",
      intent: "implementation",
      timestamp: Date.now(),
    });

    bus.emit("task:tool_wedged", {
      taskId: "t-id",
      activeToolCount: 1,
      elapsedMs: 305_000,
      thresholdMs: 300_000,
      activeTools: [],
      timestamp: Date.now(),
    });

    await waitForWrite(bus);
    expect(writtenEvents).toHaveLength(1);
    expect(writtenEvents[0]?.taskId).toBe("t-id");
    expect(writtenEvents[0]?.postmortemId).toMatch(/^fp-\d+$/);
    expect(writtenEvents[0]?.failureCategory).toBe("tool_wedge");

    recorder.stop();
  });
});
