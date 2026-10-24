/**
 * Plane-observation coverage for the worker role.
 *
 * Swarm.run() emits cheap, fire-and-forget plane Observations at the same
 * lifecycle points it already emits events for (intent classified, context
 * loaded, tool start/end, session end). These tests drive a real agentic loop
 * — with one turn that calls tools — so the full worker observation trace
 * fires, and assert:
 *
 *   1. observe() is invoked at least 5 times (>= 5 distinct lifecycle writes).
 *   2. Every observation is tagged role 'worker' and carries a confidence value.
 *   3. A throwing/rejecting observe() never aborts or fails the task
 *      (the fire-and-forget guarantee).
 *
 * Mirrors packages/oversight/tests/plane-observations.test.ts (reviewer/arbiter
 * roles) and the executor/tools mocking in fallback-agentic.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm } from "../src/index.js";

const SWARM_PATH = resolveSwarmPath();

// ---------------------------------------------------------------------------
// Hoisted provider/tool stubs — set per-test, read from inside the module mocks
// ---------------------------------------------------------------------------

const stubs = vi.hoisted(() => ({
  executeWithTools: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      // Presence of executeWithTools selects the agentic loop over single-shot.
      executeWithTools: (...args: unknown[]) => stubs.executeWithTools!(...args),
    }),
  };
});

vi.mock("../src/tools/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBuiltinTools: () => [],
    executeTool: vi.fn(async () => ({ content: "ok", is_error: false })),
  };
});

// ---------------------------------------------------------------------------
// Mock SubstrateClient — Router + Loader query it; observe() records plane writes
// ---------------------------------------------------------------------------

interface ObserveCall {
  kind: string;
  content: string;
  tags?: string[];
  confidence?: number;
}

function createMockSubstrateClient(observeImpl?: () => Promise<unknown>) {
  const observeCalls: ObserveCall[] = [];
  const MOCK_ROUTES = [
    {
      intent: "code-review",
      description: "Review code changes.",
      keywords: JSON.stringify(["review", "PR", "code review"]),
      contentPaths: JSON.stringify(["core/values.md", "modes/code-review.md"]),
    },
  ];
  const MOCK_CONFIGS = [
    { key: "default_max_tokens", value: "15000", category: "budget" },
    { key: "model_override:claude-sonnet-4-6", value: "14000", category: "budget" },
  ];
  const MOCK_CONTENT = [
    { path: "core/values.md", tier: "core", intent: "", content: "# Values\nBe excellent.", tokenEstimate: 6, lastReviewed: "2026-03-01", projectId: "" },
    { path: "modes/code-review.md", tier: "mode", intent: "", content: "# Code Review\nReview carefully.", tokenEstimate: 7, lastReviewed: "2026-03-01", projectId: "" },
  ];
  return {
    observeCalls,
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") return MOCK_ROUTES;
      if (typeName === "SwarmConfig") return MOCK_CONFIGS;
      if (typeName === "SwarmContent") return MOCK_CONTENT;
      return [];
    }),
    mutate: vi.fn(async () => ({ id: 1 })),
    observe: vi.fn(async (req: ObserveCall) => {
      observeCalls.push(req);
      return observeImpl ? observeImpl() : { id: observeCalls.length };
    }),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Agentic-loop turn results: one turn with two tool calls, then end_turn.
// Two tool calls => intent + context + 2*(tool:start + tool:end) + session:end
// = 7 observations, comfortably over the >= 5 floor.
// ---------------------------------------------------------------------------

function toolTurn() {
  return {
    inputTokens: 100,
    outputTokens: 50,
    stopReason: "tool_use",
    outputText: "inspecting",
    assistantMessage: { role: "assistant", content: [] },
    toolUseBlocks: [
      { id: "tu-1", name: "list_directory", input: {} },
      { id: "tu-2", name: "read_file", input: { path: "x.ts" } },
    ],
  };
}

function endTurn() {
  return {
    inputTokens: 20,
    outputTokens: 10,
    stopReason: "end_turn",
    outputText: "done reviewing",
    assistantMessage: { role: "assistant", content: [] },
    toolUseBlocks: [],
  };
}

function makeSwarm(client: ReturnType<typeof createMockSubstrateClient>) {
  return new Swarm(
    {
      swarmPath: SWARM_PATH,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test-key-not-used",
    },
    { queryClient: client as any },
  );
}

describe("worker-role plane observations (Swarm.run)", () => {
  it("emits >= 5 worker observations, each tagged 'worker' with a confidence", async () => {
    stubs.executeWithTools = vi
      .fn()
      .mockResolvedValueOnce(toolTurn())
      .mockResolvedValueOnce(endTurn());

    const substrate = createMockSubstrateClient();
    const swarm = makeSwarm(substrate);

    const result = await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    expect(result.output).toBe("done reviewing");

    // At least 5 distinct lifecycle writes.
    expect(substrate.observe.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(substrate.observeCalls.length).toBeGreaterThanOrEqual(5);

    // Every observation is tagged role 'worker' and carries a confidence value.
    for (const call of substrate.observeCalls) {
      expect(call.tags).toContain("worker");
      expect(typeof call.confidence).toBe("number");
    }

    // The full worker lifecycle is represented — the writes are distinct events,
    // not five copies of the same one. Each event is the second tag entry.
    const events = new Set(substrate.observeCalls.map((c) => c.tags?.[1]));
    expect(events).toContain("intent:classified");
    expect(events).toContain("context:loaded");
    expect(events).toContain("tool:start");
    expect(events).toContain("tool:end");
    expect(events).toContain("session:end");
  });

  it("a throwing observe() does not abort or fail the task (fire-and-forget)", async () => {
    stubs.executeWithTools = vi
      .fn()
      .mockResolvedValueOnce(toolTurn())
      .mockResolvedValueOnce(endTurn());

    // observe() rejects on every call — the run must still complete normally.
    const substrate = createMockSubstrateClient(() => Promise.reject(new Error("plane down")));
    const swarm = makeSwarm(substrate);

    const result = await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // Task output is unaffected by the failing plane writes.
    expect(result.output).toBe("done reviewing");
    expect(result.intent).toBe("code-review");
    // observe() was still attempted the expected number of times.
    expect(substrate.observe.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("a synchronously-throwing observe() is also swallowed", async () => {
    stubs.executeWithTools = vi
      .fn()
      .mockResolvedValueOnce(toolTurn())
      .mockResolvedValueOnce(endTurn());

    const substrate = createMockSubstrateClient();
    // Replace observe with a sync throw to exercise the try/catch (not just .catch).
    substrate.observe = vi.fn(() => {
      throw new Error("observe blew up synchronously");
    }) as any;
    const swarm = makeSwarm(substrate);

    const result = await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    expect(result.output).toBe("done reviewing");
    expect(substrate.observe).toHaveBeenCalled();
  });
});
