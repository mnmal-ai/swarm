/**
 * An expired login fails every session, the primary's and any fallback's:
 * Swarm.run() hands it straight back — no retry, and never a switch to the
 * fallback backend (which may be the API, billed to a key).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm } from "../src/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { LoginExpiredError, RateLimitError } from "@mnmal-ai/swarm-types";
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
// Backends
// ---------------------------------------------------------------------------

/** A backend whose sessions throw what `fail` returns, call by call. */
class FailingBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;
  callCount = 0;
  constructor(private readonly fail: (call: number) => Error) {}
  async isAvailable(): Promise<boolean> { return true; }
  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    this.callCount++;
    throw this.fail(this.callCount);
  }
}

/** A fallback that would succeed, and records whether it was asked. */
class Fallback implements IWorkerBackend {
  readonly type = "api" as const;
  readonly supportsDirectExecution = true;
  called = false;
  async isAvailable(): Promise<boolean> { return true; }
  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    this.called = true;
    return { output: "done", latencyMs: 1, tokensUsed: { input: 1, output: 1 }, filesChanged: [], exitCode: 0, backendUsed: "api" };
  }
}

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

const RUN = ["Review this code: console.log('hello')", { input: "console.log('hello')", intentOverride: "code-review" }] as const;

describe("Swarm.run() and an expired login", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws LoginExpiredError at once: no retry, no fallback", async () => {
    const backend = new FailingBackend(() => new LoginExpiredError("OAuth session expired and could not be refreshed"));
    const fallback = new Fallback();
    const { swarm } = makeSwarm(backend, fallback);

    await expect(swarm.run(...RUN)).rejects.toThrow(LoginExpiredError);
    expect(backend.callCount).toBe(1);
    expect(fallback.called).toBe(false);
  });

  it("treats an untyped login failure the same way", async () => {
    const backend = new FailingBackend(() => new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired"));
    const fallback = new Fallback();
    const { swarm } = makeSwarm(backend, fallback);

    await expect(swarm.run(...RUN)).rejects.toThrow(/Failed to authenticate/);
    expect(backend.callCount).toBe(1);
    expect(fallback.called).toBe(false);
  });

  it("does not fall back when the login expires on the retry", async () => {
    const backend = new FailingBackend((call) => call === 1 ? new Error("socket hang up") : new LoginExpiredError("Please run /login"));
    const fallback = new Fallback();
    const { swarm } = makeSwarm(backend, fallback);

    await expect(swarm.run(...RUN)).rejects.toThrow(LoginExpiredError);
    expect(backend.callCount).toBe(2);
    expect(fallback.called).toBe(false);
  });

  it("does not fall back when the login expires after a rate-limit pause", async () => {
    const backend = new FailingBackend((call) =>
      call === 1 ? new RateLimitError("You've hit your limit · resets soon", new Date(Date.now() + 50), 50) : new LoginExpiredError("Please run /login"));
    const fallback = new Fallback();
    const { swarm } = makeSwarm(backend, fallback);

    await expect(swarm.run(...RUN)).rejects.toThrow(LoginExpiredError);
    expect(fallback.called).toBe(false);
  });

  it("still falls back for other failures", async () => {
    const backend = new FailingBackend(() => new Error("socket hang up"));
    const fallback = new Fallback();
    const { swarm } = makeSwarm(backend, fallback);

    const result = await swarm.run(...RUN);
    expect(fallback.called).toBe(true);
    expect(result.fallbackUsed).toBe(true);
  });
});
