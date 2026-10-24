/**
 * Tests that Swarm.run() correctly handles fallback when the primary backend
 * throws and the fallback has supportsDirectExecution=false.
 *
 * Previously, Swarm.run() would call fallbackBackend.execute() unconditionally,
 * which crashed when the fallback was an ApiWorkerBackend (supportsDirectExecution=false).
 * The fix: check supportsDirectExecution before calling execute() and fall through
 * to the internal agentic loop when the fallback doesn't support direct execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm } from "../src/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { TelemetryAdapter } from "@mnmal-ai/swarm-types";
import type {
  IWorkerBackend,
  WorkerTaskInput,
  WorkerTaskOutput,
  SwarmConfig,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Swarm repo path — still needed for SkillFetcher and swarmCommitSha
// ---------------------------------------------------------------------------

const SWARM_PATH = resolveSwarmPath();

// ---------------------------------------------------------------------------
// Mock SubstrateClient — Router and Loader now require a SubstrateClient, not a path
// ---------------------------------------------------------------------------

function createMockSubstrateClient() {
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
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Mock backends
// ---------------------------------------------------------------------------

/** A mock backend that supports direct execution but always throws. */
class FailingBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    throw new Error("Claude Agent SDK query timed out after 600 seconds.");
  }
}

/** A mock backend that does NOT support direct execution (like ApiWorkerBackend). */
class NonDirectBackend implements IWorkerBackend {
  readonly type = "api" as const;
  readonly supportsDirectExecution = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    throw new Error(
      "ApiWorkerBackend.execute() should not be called directly.",
    );
  }
}

// ---------------------------------------------------------------------------
// Mock the executor module so we don't make real API calls
// ---------------------------------------------------------------------------

vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      // Provide a simple execute() (no executeWithTools) so Swarm.run()
      // takes the single-shot path instead of the agentic loop.
      execute: async () => ({
        output: "Mock agentic loop result",
        tokens: { input: 100, output: 50 },
        latencyMs: 100,
        model: { provider: "anthropic", modelId: "mock-model" },
      }),
    }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Swarm.run() fallback to agentic loop", () => {
  let eventBus: SwarmEventBus;

  beforeEach(() => {
    eventBus = new SwarmEventBus();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  function makeSwarmConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
    return {
      swarmPath: SWARM_PATH,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test-key-not-used",
      eventBus,
      ...overrides,
    };
  }

  it("does not call execute() on fallback when supportsDirectExecution is false", async () => {
    const failingBackend = new FailingBackend();
    const nonDirectFallback = new NonDirectBackend();
    const executeSpy = vi.spyOn(nonDirectFallback, "execute");

    // Construct Swarm with fallback injected via deps
    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: failingBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any, fallbackBackend: nonDirectFallback },
    );

    const result = await swarm.run("Review this code for issues", {
      input: "function foo() { return 1; }",
      intentOverride: "code-review",
    });

    // The key assertion: NonDirectBackend.execute() was NOT called
    expect(executeSpy).not.toHaveBeenCalled();

    // Swarm fell through to the agentic loop and got a result from the mock provider
    expect(result.output).toBe("Mock agentic loop result");
  });

  it("emits backend:fallback event with agentic loop reason", async () => {
    const failingBackend = new FailingBackend();
    const nonDirectFallback = new NonDirectBackend();

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: failingBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any, fallbackBackend: nonDirectFallback },
    );

    const fallbackEvents: Array<Record<string, unknown>> = [];
    eventBus.on("backend:fallback", (e) => {
      fallbackEvents.push(e as unknown as Record<string, unknown>);
    });

    await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // Should have emitted a backend:fallback event
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0].from).toBe("claude-code");
    expect(fallbackEvents[0].to).toBe("api");
    expect(String(fallbackEvents[0].reason)).toContain("agentic loop");
  });

  it("falls through to agentic loop when isAvailable returns false and fallback is non-direct", async () => {
    // This tests the unavailability path (as opposed to the execute-throws path above)
    const unavailableBackend = new FailingBackend();
    vi.spyOn(unavailableBackend, "isAvailable").mockResolvedValue(false);
    const nonDirectFallback = new NonDirectBackend();
    const executeSpy = vi.spyOn(nonDirectFallback, "execute");

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: unavailableBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any, fallbackBackend: nonDirectFallback },
    );

    const result = await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.output).toBe("Mock agentic loop result");
  });

  it("still throws when there is no fallback backend at all", async () => {
    const failingBackend = new FailingBackend();

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: failingBackend,
        // No fallback configured
        backendConfig: { type: "claude-code" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    await expect(
      swarm.run("Review this code", {
        input: "const x = 1;",
        intentOverride: "code-review",
      }),
    ).rejects.toThrow("timed out after 600 seconds");
  });
});
