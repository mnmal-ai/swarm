import { describe, it, expect, vi, beforeEach } from "vitest";
import { Oversight } from "../src/index.js";
import type { ISwarmEventBus, IWorkerBackend, ModelProvider, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";

/** Records the events Oversight emits; Oversight only ever calls emit(). */
function recordingBus(): ISwarmEventBus & { events: Array<{ event: string; payload: any }> } {
  const events: Array<{ event: string; payload: any }> = [];
  return {
    events,
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  } as unknown as ISwarmEventBus & { events: Array<{ event: string; payload: any }> };
}

/**
 * The arbiter's sign-off policy. By default the arbiter only rules when the
 * reviewer and worker disagree past the retry limit — which a healthy run
 * never reaches, so the arbiter never runs. With `arbiterPolicy:
 * "always"`, the arbiter also signs off on every approval, and an arbiter that
 * overturns the reviewer sends the task to a person.
 */

const WORKER_OUTPUT = "I fixed the permission check and added a test for every role; all tests pass locally.";

function provider(response: string): ModelProvider {
  return {
    name: "anthropic",
    execute: vi.fn().mockResolvedValue({
      output: response,
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: { provider: "anthropic", modelId: "unused" },
    }),
  };
}

function backend(outputs: string[], model?: string): IWorkerBackend & { prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    type: "claude-code",
    model,
    supportsDirectExecution: true,
    isAvailable: async () => true,
    prompts,
    execute: vi.fn(async (input: WorkerTaskInput): Promise<WorkerTaskOutput> => {
      prompts.push(`${input.swarmContext}\n${input.task}`);
      const output = outputs[Math.min(call++, outputs.length - 1)];
      return { output, latencyMs: 1, tokensUsed: { input: 1, output: 1 }, filesChanged: [], backendUsed: "claude-code" };
    }),
  };
}

const APPROVE_REVIEW = '{"verdict": "approved", "reasons": [], "suggestions": []}';
const REJECT_REVIEW = '{"verdict": "rejected", "reasons": ["no test for the teen role"], "suggestions": []}';
const ARBITER_APPROVES = '{"verdict": "approved", "reasoning": "verified every criterion"}';
const ARBITER_COMPLETED_WITH_NOTES = '{"verdict": "completed_with_notes", "reasoning": "one citation was a draft link"}';
const ARBITER_REJECTS = '{"verdict": "rejected", "reasoning": "the hidden-person answer differs from the missing-person answer"}';

function oversight(arbiterPolicy?: "on_disagreement" | "always", eventBus?: ISwarmEventBus) {
  return new Oversight({
    reviewerProvider: provider(APPROVE_REVIEW),
    reviewerModel: "claude-opus-5-5",
    arbiterProvider: provider(ARBITER_APPROVES),
    arbiterModel: "claude-fable-5-1",
    arbiterPolicy,
    eventBus,
  });
}

function chain(o: Oversight, reviewer: IWorkerBackend, arbiter: IWorkerBackend, onRetry?: () => Promise<string>) {
  return o.runFullChain({
    modeContext: "",
    originalTask: "Fix the export button",
    workerOutput: WORKER_OUTPUT,
    maxRetries: onRetry ? 1 : 0,
    sessionId: "sess-worker",
    reviewerBackend: reviewer,
    arbiterBackend: arbiter,
    workingDirectory: "/tmp/wt",
    onRetry,
  });
}

describe("arbiter sign-off policy", () => {
  let reviewer: ReturnType<typeof backend>;

  beforeEach(() => {
    reviewer = backend([APPROVE_REVIEW], "claude-opus-5-5");
  });

  it("leaves an approved task alone by default", async () => {
    const arbiter = backend([ARBITER_APPROVES], "claude-fable-5-1");

    const result = await chain(oversight(), reviewer, arbiter);

    expect(result.verdict).toBe("approved");
    expect(result.arbiterInvolved).toBe(false);
    expect(arbiter.execute).not.toHaveBeenCalled();
  });

  it("has the arbiter sign off on an approved task when the policy is always", async () => {
    const arbiter = backend([ARBITER_APPROVES], "claude-fable-5-1");

    const result = await chain(oversight("always"), reviewer, arbiter);

    expect(arbiter.execute).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("approved");
    expect(result.arbiterInvolved).toBe(true);
    expect(result.humanEscalation).toBe(false);
  });

  it("asks the arbiter for a sign-off, not to settle a disagreement", async () => {
    const arbiter = backend([ARBITER_APPROVES], "claude-fable-5-1");

    await chain(oversight("always"), reviewer, arbiter);

    expect(arbiter.prompts[0]).toMatch(/sign-off/i);
    expect(arbiter.prompts[0]).toContain("## Reviewer Approval");
    expect(arbiter.prompts[0]).not.toContain("## Reviewer Rejection Reasons");
  });

  it("keeps the arbiter's own success verdict when it signs off with notes", async () => {
    const arbiter = backend([ARBITER_COMPLETED_WITH_NOTES], "claude-fable-5-1");

    const result = await chain(oversight("always"), reviewer, arbiter);

    expect(result.verdict).toBe("completed_with_notes");
    expect(result.arbiterInvolved).toBe(true);
    expect(result.humanEscalation).toBe(false);
    expect(result.rejectionReasons).toEqual([]);
  });

  it("sends the task to a person when the arbiter overturns the reviewer", async () => {
    const arbiter = backend([ARBITER_REJECTS], "claude-fable-5-1");

    const result = await chain(oversight("always"), reviewer, arbiter);

    expect(result.verdict).toBe("escalate");
    expect(result.humanEscalation).toBe(true);
    expect(result.arbiterInvolved).toBe(true);
    expect(result.rejectionReasons.join(" ")).toContain("hidden-person answer differs");
  });

  it("signs off on a task the reviewer approved after a retry", async () => {
    const retryReviewer = backend([REJECT_REVIEW, APPROVE_REVIEW], "claude-opus-5-5");
    const arbiter = backend([ARBITER_APPROVES], "claude-fable-5-1");

    const result = await chain(oversight("always"), retryReviewer, arbiter, async () => WORKER_OUTPUT);

    expect(result.retryCount).toBe(1);
    expect(arbiter.execute).toHaveBeenCalledTimes(1);
    expect(result.arbiterInvolved).toBe(true);
  });
});

describe("oversight role labels", () => {
  it("names the model each backend asks for, not just the backend type", async () => {
    const bus = recordingBus();

    await chain(
      oversight("always", bus),
      backend([APPROVE_REVIEW], "claude-opus-5-5"),
      backend([ARBITER_APPROVES], "claude-fable-5-1"),
    );

    const roles = bus.events
      .filter((e) => e.event === "agent:role")
      .map((e) => ({ role: e.payload.role, model: e.payload.model }));
    expect(roles).toEqual([
      { role: "reviewer", model: "claude-code:claude-opus-5-5" },
      { role: "arbiter", model: "claude-code:claude-fable-5-1" },
    ]);
  });
});
