/**
 * Swarm.run() preamble routing: the single-round-trip `prepareTask` path.
 *
 * When the injected queryClient exposes the server-side `prepareTask` resolver
 * (Substrate-backed transports), Swarm.run must collapse classify + load + assemble
 * into ONE call to it — NOT the per-step Router.classify + Loader.load path.
 * These tests assert:
 *
 *   1. prepareTask is called exactly once, with {prompt, projectId, modelId,
 *      intentOverride}, and the per-step `query` path is never touched.
 *   2. The intent:classified + context:loaded events and the assembled context
 *      fed to the model are derived from the prepareTask response.
 *   3. A client WITHOUT prepareTask (file-only mode) still falls back to the
 *      per-step Router/Loader path (query IS called).
 *
 * Reuses the executor/tools mocking pattern from plane-observations.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSwarmPath } from "./content-path.js";
import { Swarm } from "../src/index.js";

const SWARM_PATH = resolveSwarmPath();

// Capture the systemContext passed to the agentic loop so we can assert it
// equals the prepareTask-assembled blob.
const stubs = vi.hoisted(() => ({
  capturedContext: undefined as string | undefined,
}));

vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      executeWithTools: (context: string) => {
        stubs.capturedContext = context;
        return Promise.resolve({
          inputTokens: 20,
          outputTokens: 10,
          stopReason: "end_turn",
          outputText: "done reviewing",
          assistantMessage: { role: "assistant", content: [] },
          toolUseBlocks: [],
        });
      },
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
    "--- swarm: core/values.md (core) ---\n# Values\nBe excellent.\n\n" +
    "--- swarm: modes/code-review.md (mode) ---\n# Code Review\nReview carefully.",
  filesIncluded: [
    { path: "core/values.md", tier: "core", tokens: 6 },
    { path: "modes/code-review.md", tier: "mode", tokens: 7 },
  ],
  tokensUsed: 13,
  budgetTokens: 14000,
  routeMatched: { intent: "code-review", description: "Review code changes." },
  truncated: [],
  complexity: 0.55,
};

function createPrepareCapableClient() {
  return {
    prepareTask: vi.fn(async () => PREPARED),
    query: vi.fn(async () => []),
    mutate: vi.fn(async () => ({ id: 1 })),
    observe: vi.fn(async () => ({ id: 1 })),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// File-only client: only `query` — no prepareTask/loadContext/classifyIntent.
function createQueryOnlyClient() {
  const MOCK_ROUTES = [
    {
      intent: "code-review",
      description: "Review code changes.",
      keywords: JSON.stringify(["review", "code review"]),
      contentPaths: JSON.stringify(["core/values.md"]),
    },
  ];
  const MOCK_CONFIGS = [
    { key: "default_max_tokens", value: "15000", category: "budget" },
  ];
  const MOCK_CONTENT = [
    { path: "core/values.md", tier: "core", intent: "", content: "# Values", tokenEstimate: 6, lastReviewed: "2026-03-01", projectId: "" },
  ];
  return {
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") return MOCK_ROUTES;
      if (typeName === "SwarmConfig") return MOCK_CONFIGS;
      if (typeName === "SwarmContent") return MOCK_CONTENT;
      return [];
    }),
    mutate: vi.fn(async () => ({ id: 1 })),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

interface RecordedEvent {
  name: string;
  payload: Record<string, unknown>;
}

function makeSwarm(client: unknown, events: RecordedEvent[]) {
  const eventBus = {
    emit: (name: string, payload: Record<string, unknown>) => {
      events.push({ name, payload });
    },
  };
  return new Swarm(
    {
      swarmPath: SWARM_PATH,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test-key-not-used",
    },
    // biome-ignore lint/suspicious/noExplicitAny: test doubles
    { queryClient: client as any, eventBus: eventBus as any },
  );
}

describe("Swarm.run preamble — prepareTask single round trip", () => {
  it("calls prepareTask once and skips the per-step query path", async () => {
    stubs.capturedContext = undefined;
    const client = createPrepareCapableClient();
    const events: RecordedEvent[] = [];
    const swarm = makeSwarm(client, events);

    const result = await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
      project: "sample-app",
    });

    // One prepareTask call, carrying the canonical request shape.
    expect(client.prepareTask).toHaveBeenCalledTimes(1);
    expect(client.prepareTask).toHaveBeenCalledWith({
      prompt: "review this code",
      projectId: "sample-app",
      modelId: "claude-sonnet-4-6",
      intentOverride: "code-review",
    });
    // The per-step Router/Loader path (SwarmRoute/SwarmContent queries) is bypassed.
    expect(client.query).not.toHaveBeenCalled();

    // Result reflects the prepareTask response.
    expect(result.intent).toBe("code-review");
    expect(result.filesLoaded).toEqual([
      "core/values.md",
      "modes/code-review.md",
    ]);
    expect(result.tokensUsed.context).toBe(13);
    expect(result.output).toBe("done reviewing");
  });

  it("derives the events and assembled context from the prepareTask response", async () => {
    stubs.capturedContext = undefined;
    const client = createPrepareCapableClient();
    const events: RecordedEvent[] = [];
    const swarm = makeSwarm(client, events);

    await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    const intentEvt = events.find((e) => e.name === "intent:classified");
    expect(intentEvt?.payload).toMatchObject({
      intent: "code-review",
      confidence: "exact",
      matchedKeywords: ["review"],
      routeDescription: "Review code changes.",
    });

    const ctxEvt = events.find((e) => e.name === "context:loaded");
    expect(ctxEvt?.payload).toMatchObject({
      files: [
        { path: "core/values.md", tier: "core", estimatedTokens: 6 },
        { path: "modes/code-review.md", tier: "mode", estimatedTokens: 7 },
      ],
      totalTokens: 13,
      budgetMax: 14000,
      truncated: [],
    });

    // The model is fed exactly the resolver-assembled blob (no additionalContext here).
    expect(stubs.capturedContext).toBe(PREPARED.content);
  });

  it("falls back to the per-step query path when prepareTask is absent", async () => {
    stubs.capturedContext = undefined;
    const client = createQueryOnlyClient();
    const events: RecordedEvent[] = [];
    const swarm = makeSwarm(client, events);

    const result = await swarm.run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
    });

    // No prepareTask on this client → Router/Loader query the swarm content.
    expect(client.query).toHaveBeenCalled();
    expect(result.intent).toBe("code-review");
    // Assembled from the queried SwarmContent, not a prepareTask blob.
    expect(stubs.capturedContext).toContain("# Values");
  });
});

describe("Swarm.run preamble — context sections", () => {
  function makeSectionsSwarm(client: unknown, syncSections: (cwd: string) => Promise<void>, enabled: boolean) {
    return new Swarm(
      {
        swarmPath: SWARM_PATH,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "test-key-not-used",
        contextSections: enabled,
      },
      { queryClient: client as any, syncSections },
    );
  }

  it("syncs sections from the task's directory first, then asks prepareTask for sections", async () => {
    const order: string[] = [];
    const client = createPrepareCapableClient();
    client.prepareTask.mockImplementation(async () => {
      order.push("prepareTask");
      return PREPARED;
    });
    const sync = vi.fn(async (cwd: string) => {
      order.push(`sync ${cwd}`);
    });
    await makeSectionsSwarm(client, sync, true).run("review this code", {
      input: "const x = 1;",
      intentOverride: "code-review",
      workingDirectory: "/work/task-1",
    });
    expect(order).toEqual(["sync /work/task-1", "prepareTask"]);
    expect(client.prepareTask).toHaveBeenCalledWith(expect.objectContaining({ sections: true }));
  });

  it("neither syncs nor asks for sections when sections are off", async () => {
    const client = createPrepareCapableClient();
    const sync = vi.fn(async () => {});
    await makeSectionsSwarm(client, sync, false).run("review this code", { input: "x", intentOverride: "code-review" });
    expect(sync).not.toHaveBeenCalled();
    expect(client.prepareTask).toHaveBeenCalledWith(expect.not.objectContaining({ sections: true }));
  });

  it("still runs the task when the sync throws", async () => {
    const client = createPrepareCapableClient();
    const result = await makeSectionsSwarm(client, async () => {
      throw new Error("store down");
    }, true).run("review this code", { input: "x", intentOverride: "code-review" });
    expect(result.intent).toBe("code-review");
  });
});
