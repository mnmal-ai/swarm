/**
 * The per-session context record: for each session that loads swarm context,
 * what loaded (path, tier, tokens), what the budget left out (path, tier,
 * tokens) and the budget. Swarm.run puts it on the `context:loaded` event and
 * on the worker's telemetry event, which the telemetry adapter persists with
 * the session's SessionEvent row.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm, Loader } from "../src/index.js";
import type { TelemetryAdapter } from "@mnmal-ai/swarm-types";

const SWARM_PATH = resolveSwarmPath();

vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      executeWithTools: () =>
        Promise.resolve({
          inputTokens: 20,
          outputTokens: 10,
          stopReason: "end_turn",
          outputText: "done",
          assistantMessage: { role: "assistant", content: [] },
          toolUseBlocks: [],
        }),
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

const PREPARED = {
  intent: "code-review",
  confidence: "exact" as const,
  matchedKeywords: ["review"],
  content:
    "--- swarm: core/values.md (core) ---\n# Values\n\n" +
    "--- swarm: modes/code-review.md (mode) ---\n# Code Review",
  filesIncluded: [
    { path: "core/values.md", tier: "core", tokens: 6 },
    { path: "modes/code-review.md", tier: "mode", tokens: 7 },
  ],
  tokensUsed: 13,
  budgetTokens: 20,
  routeMatched: { intent: "code-review", description: "Review code changes." },
  truncated: ["capabilities/git.md", "https://example.com/skill.md"],
  omitted: [{ path: "capabilities/git.md", tier: "capabilities", tokens: 900 }],
  complexity: 0.5,
};

function prepareClient(prepared: Record<string, unknown>) {
  return {
    prepareTask: vi.fn(async () => prepared),
    query: vi.fn(async () => []),
    mutate: vi.fn(async () => ({ id: 1 })),
    observe: vi.fn(async () => ({ id: 1 })),
    isHealthy: vi.fn(async () => true),
  };
}

function makeTelemetry(): TelemetryAdapter {
  return {
    name: "fake",
    kind: "telemetry",
    healthCheck: async () => ({ healthy: true }),
    flush: async () => {},
    emit: vi.fn(async () => {}),
    emitOversightEvent: vi.fn(async () => {}),
    buildEvent: vi.fn((p) => ({ id: "evt", session_id: p.sessionId, role: p.role })),
  } as unknown as TelemetryAdapter;
}

function makeSwarm(client: unknown, events: Array<{ name: string; payload: Record<string, unknown> }>, telemetry: TelemetryAdapter) {
  const eventBus = { emit: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }) };
  return new Swarm(
    { swarmPath: SWARM_PATH, provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "test-key-not-used" },
    // biome-ignore lint/suspicious/noExplicitAny: test doubles
    { queryClient: client as any, eventBus: eventBus as any, telemetry },
  );
}

describe("the per-session context record", () => {
  it("puts what the budget left out, with tier and tokens, on the context:loaded event", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    await makeSwarm(prepareClient(PREPARED), events, makeTelemetry()).run("review this", {
      input: "x",
      intentOverride: "code-review",
    });

    const loaded = events.find((e) => e.name === "context:loaded");
    expect(loaded?.payload).toMatchObject({
      totalTokens: 13,
      budgetMax: 20,
      truncated: ["capabilities/git.md", "https://example.com/skill.md"],
      omitted: [{ path: "capabilities/git.md", tier: "capabilities", estimatedTokens: 900 }],
    });
  });

  it("hands the worker's telemetry event the budget, what loaded and what was left out", async () => {
    const telemetry = makeTelemetry();
    await makeSwarm(prepareClient(PREPARED), [], telemetry).run("review this", {
      input: "x",
      intentOverride: "code-review",
    });

    expect(telemetry.buildEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        contextTokensUsed: 13,
        context: {
          budgetTokens: 20,
          loaded: [
            { path: "core/values.md", tier: "core", tokens: 6 },
            { path: "modes/code-review.md", tier: "mode", tokens: 7 },
          ],
          omitted: [{ path: "capabilities/git.md", tier: "capabilities", tokens: 900 }],
        },
      }),
    );
  });

  it("records nothing left out when an older sidecar returns no omitted list", async () => {
    const { omitted: _omitted, ...older } = PREPARED;
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const telemetry = makeTelemetry();
    await makeSwarm(prepareClient(older), events, telemetry).run("review this", {
      input: "x",
      intentOverride: "code-review",
    });

    expect(events.find((e) => e.name === "context:loaded")?.payload.omitted).toEqual([]);
    expect(telemetry.buildEvent).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ omitted: [] }) }),
    );
  });
});

describe("Loader.load: what the budget left out", () => {
  it("lists each optional file the budget dropped with its tier and tokens", async () => {
    const content = [
      { path: "core/values.md", tier: "core", intent: "", content: "# Values", tokenEstimate: 6, lastReviewed: "", projectId: "" },
      { path: "capabilities/git.md", tier: "capabilities", intent: "", content: "git", tokenEstimate: 900, lastReviewed: "", projectId: "" },
      { path: "capabilities/ci.md", tier: "capabilities", intent: "", content: "ci", tokenEstimate: 4, lastReviewed: "", projectId: "" },
    ];
    const client = { query: vi.fn(async (type: string) => (type === "SwarmContent" ? content : [])) };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const loader = new Loader(client as any);
    const route = {
      intent: "implementation",
      description: "",
      keywords: [],
      load: { core: ["core/values.md"], capabilities: ["capabilities/git.md", "capabilities/ci.md"] },
    };
    const priority = [
      { tier: "core", required: true, description: "" },
      { tier: "capabilities", required: false, description: "" },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: minimal route/priority shapes
    const result = await loader.load(route as any, 20, priority as any);

    expect(result.files.map((f) => f.path)).toEqual(["core/values.md", "capabilities/ci.md"]);
    expect(result.truncated).toEqual(["capabilities/git.md"]);
    expect(result.omitted).toEqual([{ path: "capabilities/git.md", tier: "capabilities", estimatedTokens: 900 }]);
  });
});
