/**
 * Tests for SDK-05: Retry primary backend before falling back.
 *
 * When the primary backend (e.g., Claude Agent SDK) times out or fails,
 * the system should retry the primary ONCE before falling back to the
 * fallback backend. This prevents unnecessary fallbacks from transient errors.
 *
 * Test scenarios:
 * 1. Primary timeout -> retry -> retry succeeds -> no fallback used
 * 2. Primary timeout -> retry -> retry fails -> fallback used
 * 3. Fallback produces empty output -> error logged
 * 4. Event/log emitted on fallback with correct reason
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Swarm } from "@mnmal-ai/swarm-core";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { createMockSubstrateClient, resolveSwarmPath } from "./helpers.js";
import type {
  IWorkerBackend,
  WorkerTaskInput,
  WorkerTaskOutput,
  SwarmConfig,
  BackendFallbackEvent,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Swarm content path (SWARM_PATH, else the repo fixture) — still needed for
// SkillFetcher and swarmCommitSha
// ---------------------------------------------------------------------------

const SWARM_PATH = resolveSwarmPath();

// ---------------------------------------------------------------------------
// Mock backends
// ---------------------------------------------------------------------------

/** A mock backend where execute() behavior can be controlled per-call. */
class ControllableBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;
  private callCount = 0;
  private behaviors: Array<"succeed" | "fail"> = [];
  private failMessage: string;

  constructor(behaviors: Array<"succeed" | "fail">, failMessage = "Claude Agent SDK query timed out after 600 seconds.") {
    this.behaviors = behaviors;
    this.failMessage = failMessage;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    const behavior = this.behaviors[this.callCount] ?? "fail";
    this.callCount++;

    if (behavior === "fail") {
      throw new Error(this.failMessage);
    }

    return {
      output: `Success on attempt ${this.callCount}`,
      latencyMs: 3000,
      tokensUsed: { input: 1000, output: 500 },
      filesChanged: [],
      exitCode: 0,
      backendUsed: "claude-code",
    };
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/** A fallback backend that supports direct execution and returns configurable output. */
class MockFallbackBackend implements IWorkerBackend {
  readonly type = "api" as const;
  readonly supportsDirectExecution = true;
  private output: string;
  private tokens: { input: number; output: number };
  executed = false;

  constructor(output = "Fallback result", tokens = { input: 200, output: 100 }) {
    this.output = output;
    this.tokens = tokens;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    this.executed = true;
    return {
      output: this.output,
      latencyMs: 1000,
      tokensUsed: this.tokens,
      filesChanged: [],
      exitCode: 0,
      backendUsed: "api",
    };
  }
}

// ---------------------------------------------------------------------------
// Mock the executor module so we don't make real API calls
// ---------------------------------------------------------------------------

// Mock the executor module in @mnmal-ai/swarm-core so Swarm.run() doesn't make real API calls.
// Swarm imports createProvider from ./executor/index.js within core.
vi.mock("../../core/src/executor/index.js", () => ({
  AnthropicProvider: vi.fn(),
  OpenAIProvider: vi.fn(),
  createProvider: () => ({
    name: "anthropic",
    execute: async () => ({
      output: "Mock agentic loop result",
      tokens: { input: 100, output: 50 },
      latencyMs: 100,
      model: { provider: "anthropic", modelId: "mock-model" },
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SDK-05: retry primary backend before falling back", () => {
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

  it("retries primary on timeout and succeeds on retry — no fallback used", async () => {
    // First call fails, second call (retry) succeeds
    const primaryBackend = new ControllableBackend(["fail", "succeed"]);
    const fallbackBackend = new MockFallbackBackend();

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // Inject our mock fallback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = fallbackBackend;

    const fallbackEvents: BackendFallbackEvent[] = [];
    eventBus.on("backend:fallback", (e) => fallbackEvents.push(e));

    const result = await swarm.run("Review this code for issues", {
      input: "function foo() { return 1; }",
      intentOverride: "code-review",
    });

    // Primary was called twice (initial + retry), retry succeeded
    expect(primaryBackend.getCallCount()).toBe(2);
    // Fallback was NOT used
    expect(fallbackBackend.executed).toBe(false);
    // No fallback event emitted
    expect(fallbackEvents.length).toBe(0);
    // Result is from the primary backend's successful retry
    expect(result.output).toBe("Success on attempt 2");
    expect(result.fallbackUsed).toBe(false);
  });

  it("retries primary on timeout, retry also fails, then uses fallback", async () => {
    // Both calls fail — should fall through to fallback
    const primaryBackend = new ControllableBackend(["fail", "fail"]);
    const fallbackBackend = new MockFallbackBackend("Fallback output after retry");

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = fallbackBackend;

    const fallbackEvents: BackendFallbackEvent[] = [];
    eventBus.on("backend:fallback", (e) => fallbackEvents.push(e));

    const result = await swarm.run("Review this code for issues", {
      input: "function foo() { return 1; }",
      intentOverride: "code-review",
    });

    // Primary was called twice (initial + retry)
    expect(primaryBackend.getCallCount()).toBe(2);
    // Fallback WAS used
    expect(fallbackBackend.executed).toBe(true);
    // A fallback event was emitted
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0].from).toBe("claude-code");
    expect(fallbackEvents[0].to).toBe("api");
    expect(fallbackEvents[0].reason).toContain("primary:");
    expect(fallbackEvents[0].reason).toContain("retry:");
    // Result is from fallback
    expect(result.output).toBe("Fallback output after retry");
    expect(result.fallbackUsed).toBe(true);
  });

  it("logs error when fallback produces empty output", async () => {
    // Both primary attempts fail, fallback produces empty output
    const primaryBackend = new ControllableBackend(["fail", "fail"]);
    const emptyFallback = new MockFallbackBackend("", { input: 0, output: 0 });

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = emptyFallback;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await swarm.run("Review this code for issues", {
      input: "function foo() { return 1; }",
      intentOverride: "code-review",
    });

    // Fallback was used but produced empty output
    expect(emptyFallback.executed).toBe(true);
    expect(result.output).toBe("");

    // console.error was called with the empty-output warning
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty/zero-token output"),
    );

    errorSpy.mockRestore();
  });

  it("emits backend:fallback event with reason including 'primary failed after retry'", async () => {
    const timeoutMessage = "Request timed out after 600 seconds.";
    const primaryBackend = new ControllableBackend(["fail", "fail"], timeoutMessage);
    const fallbackBackend = new MockFallbackBackend();

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = fallbackBackend;

    const fallbackEvents: BackendFallbackEvent[] = [];
    eventBus.on("backend:fallback", (e) => fallbackEvents.push(e));

    await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    expect(fallbackEvents.length).toBe(1);
    const event = fallbackEvents[0];
    expect(event.from).toBe("claude-code");
    expect(event.to).toBe("api");
    // Reason should include both primary and retry errors
    expect(event.reason).toContain("primary:");
    expect(event.reason).toContain("retry:");
    expect(event.reason).toContain("timed out");
    expect(typeof event.timestamp).toBe("number");
  });

  it("throws when primary fails after retry and no fallback is configured", async () => {
    const primaryBackend = new ControllableBackend(["fail", "fail"]);

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
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

    // Primary was called twice (initial + retry)
    expect(primaryBackend.getCallCount()).toBe(2);
  });

  // TODO: This test requires mocking the executor inside @mnmal-ai/swarm-core, but vitest
  // module mocks don't intercept cross-workspace internal imports. The equivalent test
  // passes in packages/core/tests/fallback-agentic.test.ts where the mock path is local.
  it.skip("falls through to agentic loop when primary retry fails and fallback is non-direct", async () => {
    const primaryBackend = new ControllableBackend(["fail", "fail"]);

    // Non-direct fallback — should trigger agentic loop fallthrough
    const nonDirectFallback: IWorkerBackend = {
      type: "api",
      supportsDirectExecution: false,
      isAvailable: async () => true,
      execute: async () => { throw new Error("Should not be called"); },
    };

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = nonDirectFallback;

    const fallbackEvents: BackendFallbackEvent[] = [];
    eventBus.on("backend:fallback", (e) => fallbackEvents.push(e));

    const result = await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // Primary retried
    expect(primaryBackend.getCallCount()).toBe(2);
    // Fell through to agentic loop (mock provider)
    expect(result.output).toBe("Mock agentic loop result");
    // Fallback event emitted with agentic loop reason
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0].reason).toContain("agentic loop");
    expect(fallbackEvents[0].reason).toContain("primary:");
    expect(fallbackEvents[0].reason).toContain("retry:");
  });

  it("logs error when fallback output has zero tokens but non-empty text", async () => {
    const primaryBackend = new ControllableBackend(["fail", "fail"]);
    // Non-empty text but zero tokens
    const weirdFallback = new MockFallbackBackend("Some output", { input: 0, output: 0 });

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = weirdFallback;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // Zero-token output should trigger the error log
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty/zero-token output"),
    );

    errorSpy.mockRestore();
  });

  it("logs error when fallback has output tokens=0 but input tokens>0", async () => {
    const primaryBackend = new ControllableBackend(["fail", "fail"]);
    // Provider accounted input tokens but returned zero output tokens
    const zeroOutputFallback = new MockFallbackBackend("Some output", { input: 500, output: 0 });

    const swarm = new Swarm(
      makeSwarmConfig({
        workerBackend: primaryBackend,
        backendConfig: { type: "claude-code", fallback: "api" },
      }),
      { queryClient: createMockSubstrateClient() as any },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).fallbackBackend = zeroOutputFallback;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await swarm.run("Review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // output=0 should trigger the error even when input>0
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty/zero-token output"),
    );

    errorSpy.mockRestore();
  });
});
