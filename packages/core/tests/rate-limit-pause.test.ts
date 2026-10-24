/**
 * Tests that Swarm.run() correctly handles RateLimitError by sleeping
 * and retrying instead of immediately falling back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm } from "../src/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { RateLimitError } from "@mnmal-ai/swarm-types";
import type { TelemetryAdapter } from "@mnmal-ai/swarm-types";
import type {
  IWorkerBackend,
  WorkerTaskInput,
  WorkerTaskOutput,
  SwarmConfig,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Swarm repo path — required for Router and Loader to function
// ---------------------------------------------------------------------------

const SWARM_PATH = resolveSwarmPath();

// ---------------------------------------------------------------------------
// Mock SubstrateClient — Router and Loader require a SwarmQueryClient
// ---------------------------------------------------------------------------

function createMockQueryClient() {
  const MOCK_ROUTES = [
    {
      intent: "code-review",
      description: "Review code changes.",
      keywords: JSON.stringify(["review", "PR", "pull request", "code review", "check this", "look at this diff"]),
      contentPaths: JSON.stringify(["core/values.md", "core/rules.md", "core/voice.md", "modes/code-review.md", "oversight/review-policy.json", "capabilities/git-workflow.md"]),
    },
  ];
  const MOCK_CONFIGS = [
    { key: "default_max_tokens", value: "15000", category: "budget" },
    { key: "model_override:claude-opus-4-6", value: "20000", category: "budget" },
    { key: "model_override:claude-sonnet-4-6", value: "14000", category: "budget" },
  ];
  const MOCK_CONTENT = [
    { path: "core/values.md", tier: "core", intent: "", content: "# Values\nBe excellent.", tokenEstimate: 6, lastReviewed: "2026-03-01", projectId: "" },
    { path: "core/rules.md", tier: "core", intent: "", content: "# Rules\nNo force push.", tokenEstimate: 6, lastReviewed: "2026-03-01", projectId: "" },
    { path: "core/voice.md", tier: "core", intent: "", content: "# Voice\nBe clear.", tokenEstimate: 5, lastReviewed: "2026-03-01", projectId: "" },
    { path: "modes/code-review.md", tier: "mode", intent: "", content: "# Code Review\nReview carefully.", tokenEstimate: 7, lastReviewed: "2026-03-01", projectId: "" },
    { path: "oversight/review-policy.json", tier: "oversight", intent: "", content: '{"always_review": true}', tokenEstimate: 7, lastReviewed: "2026-03-01", projectId: "" },
    { path: "capabilities/git-workflow.md", tier: "capabilities", intent: "", content: "# Git Workflow\nBranching tips.", tokenEstimate: 7, lastReviewed: "2026-03-01", projectId: "" },
  ];
  return {
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") return MOCK_ROUTES;
      if (typeName === "SwarmConfig") return MOCK_CONFIGS;
      if (typeName === "SwarmContent") return MOCK_CONTENT;
      return [];
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock backends
// ---------------------------------------------------------------------------

const SUCCESSFUL_OUTPUT: WorkerTaskOutput = {
  output: "Task completed successfully.",
  latencyMs: 2000,
  tokensUsed: { input: 100, output: 50 },
  filesChanged: [],
  exitCode: 0,
  backendUsed: "claude-code",
};

/** A backend that throws RateLimitError on the first call, then succeeds. */
class RateLimitThenSucceedBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;
  callCount = 0;

  async isAvailable(): Promise<boolean> { return true; }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    this.callCount++;
    if (this.callCount === 1) {
      // Simulate rate limit — 100ms wait (fast for testing)
      const resetAt = new Date(Date.now() + 100);
      throw new RateLimitError("You've hit your limit · resets soon", resetAt, 100);
    }
    return SUCCESSFUL_OUTPUT;
  }
}

/** A backend that always throws RateLimitError. */
class AlwaysRateLimitedBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;

  async isAvailable(): Promise<boolean> { return true; }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    const resetAt = new Date(Date.now() + 50);
    throw new RateLimitError("You've hit your limit · resets soon", resetAt, 50);
  }
}

/** A successful fallback backend. */
class SuccessfulFallback implements IWorkerBackend {
  readonly type = "api" as const;
  readonly supportsDirectExecution = true;
  called = false;

  async isAvailable(): Promise<boolean> { return true; }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    this.called = true;
    return { ...SUCCESSFUL_OUTPUT, backendUsed: "api" };
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSwarm(
  backend: IWorkerBackend,
  fallback?: IWorkerBackend,
): { swarm: Swarm; eventBus: SwarmEventBus } {
  const eventBus = new SwarmEventBus();

  const config: SwarmConfig = {
    swarmPath: SWARM_PATH,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    apiKey: "test-key-not-used",
    eventBus,
    workerBackend: backend,
    backendConfig: { type: "claude-code", fallback: fallback ? "api" : undefined },
  };

  return { swarm: new Swarm(config, { queryClient: createMockQueryClient() as any, fallbackBackend: fallback }), eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Swarm.run() rate limit handling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses and retries after RateLimitError on first attempt", async () => {
    const backend = new RateLimitThenSucceedBackend();
    const { swarm } = makeSwarm(backend);

    const result = await swarm.run("Review this code: console.log('hello')", {
      input: "console.log('hello')",
      intentOverride: "code-review",
    });

    // Backend was called twice: first threw RateLimitError, second succeeded
    expect(backend.callCount).toBe(2);
    expect(result.output).toBe("Task completed successfully.");
  });

  it("emits backend:rate-limited and backend:rate-limit-cleared events", async () => {
    const backend = new RateLimitThenSucceedBackend();
    const { swarm, eventBus } = makeSwarm(backend);

    const rateLimitedEvents: unknown[] = [];
    const rateLimitClearedEvents: unknown[] = [];
    eventBus.on("backend:rate-limited", (e) => rateLimitedEvents.push(e));
    eventBus.on("backend:rate-limit-cleared", (e) => rateLimitClearedEvents.push(e));

    await swarm.run("Review this code: console.log('hello')", {
      input: "console.log('hello')",
      intentOverride: "code-review",
    });

    expect(rateLimitedEvents).toHaveLength(1);
    expect(rateLimitClearedEvents).toHaveLength(1);
    expect((rateLimitedEvents[0] as Record<string, unknown>).backend).toBe("claude-code");
    expect((rateLimitClearedEvents[0] as Record<string, unknown>).backend).toBe("claude-code");
  });

  it("falls back when rate limit persists after pause", async () => {
    const backend = new AlwaysRateLimitedBackend();
    const fallback = new SuccessfulFallback();
    const { swarm } = makeSwarm(backend, fallback);

    const result = await swarm.run("Review this code: console.log('hello')", {
      input: "console.log('hello')",
      intentOverride: "code-review",
    });

    // Should have fallen through to fallback after pause failed
    expect(fallback.called).toBe(true);
    expect(result.fallbackUsed).toBe(true);
  });

  it("throws when rate limit wait exceeds 2-hour cap", async () => {
    const threeHoursMs = 3 * 60 * 60 * 1000;

    class LongWaitRateLimitBackend implements IWorkerBackend {
      readonly type = "claude-code" as const;
      readonly supportsDirectExecution = true;
      async isAvailable(): Promise<boolean> { return true; }
      async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
        const resetAt = new Date(Date.now() + threeHoursMs);
        throw new RateLimitError("You've hit your limit", resetAt, threeHoursMs);
      }
    }

    const { swarm } = makeSwarm(new LongWaitRateLimitBackend());

    await expect(
      swarm.run("Review this code: console.log('hello')", {
        input: "console.log('hello')",
        intentOverride: "code-review",
      }),
    ).rejects.toThrow("exceeds 2-hour cap");
  });

  it("instanceof RateLimitError works across package boundaries", () => {
    const resetAt = new Date(Date.now() + 3600_000);
    const err = new RateLimitError("test", resetAt, 3600_000);

    expect(err instanceof RateLimitError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("RateLimitError");
    expect(err.waitMs).toBe(3600_000);
  });

  it("distinguishes RateLimitError from regular errors", () => {
    const regularError = new Error("timed out");
    expect(regularError instanceof RateLimitError).toBe(false);
  });
});
