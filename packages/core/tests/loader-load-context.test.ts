import { describe, it, expect, vi } from "vitest";
import { Loader } from "../src/loader/index.js";
import type { Route, LoadingPriorityEntry } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Server-side loadContext path: Loader.load() prefers client.loadContext when
// the transport exposes it and a modelId is supplied, falling back to the
// per-tier SwarmContent query path otherwise.
// ---------------------------------------------------------------------------

const PRIORITY: LoadingPriorityEntry[] = [
  { tier: "core", required: true },
  { tier: "mode", required: false },
];

function makeRoute(intent = "implementation"): Route {
  return {
    intent,
    description: `Test route for ${intent}`,
    load: { all: ["core/rules.md", "modes/implementation.md"] },
    keywords: [intent],
  };
}

// Two files whose first block carries an internal blank line, so the splitter
// is exercised against `\n\n` appearing *inside* content (not just between
// blocks). This is exactly how assembleContext() would serialize them.
const FILES = [
  {
    path: "core/rules.md",
    tier: "core",
    content: "# Rules\n\nNever commit secrets.",
    tokens: 7,
  },
  {
    path: "modes/implementation.md",
    tier: "mode",
    content: "# Implementation\nMake the smallest change.",
    tokens: 9,
  },
];

const SERVER_BLOB = FILES.map(
  (f) => `--- swarm: ${f.path} (${f.tier}) ---\n${f.content}`,
).join("\n\n");

function makeLoadContextResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: SERVER_BLOB,
    filesIncluded: FILES.map((f) => ({
      path: f.path,
      tier: f.tier,
      tokens: f.tokens,
    })),
    tokensUsed: 16,
    budgetTokens: 15000,
    routeMatched: { intent: "implementation", description: "Test route" },
    ...overrides,
  };
}

/**
 * Mock transport exposing both `query` and `loadContext`. `query` throws by
 * default so any accidental fall-through to the per-tier path is loud.
 */
function makeServerClient(response: unknown) {
  return {
    query: vi.fn(async () => {
      throw new Error("query should not be called on the server-side path");
    }),
    loadContext: vi.fn(async () => response),
  };
}

describe("Loader.load — server-side loadContext path", () => {
  it("prefers loadContext when exposed and a modelId is supplied", async () => {
    const client = makeServerClient(makeLoadContextResponse());
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, "proj", "claude-opus-4-8");

    expect(client.loadContext).toHaveBeenCalledTimes(1);
    expect(client.loadContext).toHaveBeenCalledWith({
      intent: "implementation",
      projectId: "proj",
      modelId: "claude-opus-4-8",
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("reconstructs per-file content byte-equally from the server blob", async () => {
    const client = makeServerClient(makeLoadContextResponse());
    const loader = new Loader(client as any);

    const result = await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(result.files).toEqual([
      {
        path: "core/rules.md",
        tier: "core",
        content: "# Rules\n\nNever commit secrets.",
        estimatedTokens: 7,
      },
      {
        path: "modes/implementation.md",
        tier: "mode",
        content: "# Implementation\nMake the smallest change.",
        estimatedTokens: 9,
      },
    ]);
    // assembleContext over the reconstructed files reproduces the server blob.
    expect(loader.assembleContext(result.files)).toBe(SERVER_BLOB);
  });

  it("maps budget/token fields and reports nothing truncated", async () => {
    const client = makeServerClient(makeLoadContextResponse());
    const loader = new Loader(client as any);

    const result = await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(result.totalTokens).toBe(16);
    expect(result.budgetMax).toBe(15000);
    expect(result.budgetUsedPercent).toBeCloseTo((16 / 15000) * 100);
    expect(result.truncated).toEqual([]);
  });

  it("passes an empty projectId through when none is supplied", async () => {
    const client = makeServerClient(makeLoadContextResponse());
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, undefined, "m");

    expect(client.loadContext).toHaveBeenCalledWith({
      intent: "implementation",
      projectId: "",
      modelId: "m",
    });
  });

  it("handles a route that matched but included no files (empty blob)", async () => {
    const client = makeServerClient(
      makeLoadContextResponse({
        content: "",
        filesIncluded: [],
        tokensUsed: 0,
      }),
    );
    const loader = new Loader(client as any);

    const result = await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(result.files).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("Loader.load — fallback to the per-tier path", () => {
  it("falls back to query when no modelId is supplied (even if loadContext exists)", async () => {
    const client = {
      query: vi.fn(async () => []),
      loadContext: vi.fn(async () => makeLoadContextResponse()),
    };
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, "proj");

    expect(client.loadContext).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to query when the transport does not expose loadContext", async () => {
    const client = { query: vi.fn(async () => []) };
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to query when the server matched no route", async () => {
    const client = {
      query: vi.fn(async () => []),
      loadContext: vi.fn(async () =>
        makeLoadContextResponse({
          content: "",
          filesIncluded: [],
          tokensUsed: 0,
          routeMatched: null,
        }),
      ),
    };
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(client.loadContext).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("falls back when the blob cannot be reconstructed from the manifest", async () => {
    // filesIncluded references a delimiter the blob does not contain → split
    // fails → loadViaServer returns null → per-tier path runs.
    const client = {
      query: vi.fn(async () => []),
      loadContext: vi.fn(async () =>
        makeLoadContextResponse({
          content: "--- swarm: core/rules.md (core) ---\n# Rules",
          filesIncluded: [
            { path: "core/rules.md", tier: "core", tokens: 5 },
            { path: "missing/file.md", tier: "domain", tokens: 5 },
          ],
        }),
      ),
    };
    const loader = new Loader(client as any);

    await loader.load(makeRoute(), 15000, PRIORITY, "proj", "m");

    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
