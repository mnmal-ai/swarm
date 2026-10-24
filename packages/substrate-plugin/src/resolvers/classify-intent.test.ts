import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
} from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyIntent } from "./classify-intent.js";

/**
 * Build a stub `Dataset` whose `read` returns the rows registered for each
 * type in a single non-paged page. `readCalls` records every read so we can
 * assert the resolver's only I/O is dataset reads.
 */
function makeDataset(
  rowsByType: Record<string, Row[]>,
  readCalls: Array<{ type: string; params: ReadParams }>,
): Dataset {
  return {
    read: async (type: string, params: ReadParams) => {
      readCalls.push({ type, params });
      return { rows: rowsByType[type] ?? [], hasMore: false };
    },
  } as unknown as Dataset;
}

const ctx = {} as unknown as RequestContext;

function argsFor(
  dataset: Dataset,
  params: Record<string, unknown>,
): ResolverArgs {
  return { params, dataset };
}

/**
 * Representative routes mirroring the real swarm.json shape (keywords stored as
 * a JSON string, as stored). `code-review` is intentionally listed before
 * `implementation` to exercise first-route precedence on ties.
 */
const codeReviewRoute: Row = {
  id: "r1",
  intent: "code-review",
  description: "Review code changes.",
  keywords: '["review","PR","diff"]',
  contentPaths: '["core/rules.md"]',
};

const implementationRoute: Row = {
  id: "r2",
  intent: "implementation",
  description: "Build a feature or fix a bug.",
  keywords: '["build","add","implement","fix"]',
  contentPaths: '["core/rules.md"]',
};

function sampleRoutes(): Row[] {
  return [codeReviewRoute, implementationRoute];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyIntent resolver", () => {
  it("returns confidence 'exact' with no keywords when an intentOverride names a route", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    const result = await classifyIntent(
      ctx,
      argsFor(dataset, {
        prompt: "what is the meaning of life?",
        projectId: "sample-app",
        intentOverride: "code-review",
      }),
    );

    expect(result.intent).toBe("code-review");
    expect(result.confidence).toBe("exact");
    expect(result.matchedKeywords).toEqual([]);
  });

  it("ignores an intentOverride that does not name a real route and scores by keyword", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    const result = await classifyIntent(
      ctx,
      argsFor(dataset, {
        prompt: "build a new login feature",
        projectId: "",
        intentOverride: "no-such-intent",
      }),
    );

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("keyword");
  });

  it("classifies by keyword and populates matchedKeywords with the keywords that matched", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    const result = await classifyIntent(
      ctx,
      argsFor(dataset, {
        prompt: "please build and add and implement this",
        projectId: "",
      }),
    );

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("keyword");
    // Three of implementation's four keywords appear; "fix" does not.
    expect(result.matchedKeywords).toEqual(["build", "add", "implement"]);
  });

  it("matches keywords case-insensitively", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    const result = await classifyIntent(
      ctx,
      argsFor(dataset, { prompt: "REVIEW this PR", projectId: "" }),
    );

    expect(result.intent).toBe("code-review");
    expect(result.confidence).toBe("keyword");
    expect(result.matchedKeywords).toEqual(["review", "PR"]);
  });

  it("breaks ties in favour of the first route in dataset order (strictly-greater precedence)", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    // Prompt contains exactly one keyword from each route ("review" and "fix"),
    // so both score 1. The legacy loop's `>` comparison keeps the first match,
    // which is code-review (listed first).
    const result = await classifyIntent(
      ctx,
      argsFor(dataset, { prompt: "review and fix", projectId: "" }),
    );

    expect(result.intent).toBe("code-review");
    expect(result.confidence).toBe("keyword");
    expect(result.matchedKeywords).toEqual(["review"]);
  });

  it("returns the fallback intent with empty matchedKeywords when no keyword matches", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    const result = await classifyIntent(
      ctx,
      argsFor(dataset, {
        prompt: "what is the meaning of life?",
        projectId: "",
      }),
    );

    expect(result.intent).toBe("fallback");
    expect(result.confidence).toBe("fallback");
    expect(result.matchedKeywords).toEqual([]);
  });

  it("makes no LLM or network call — its only I/O is reading SwarmRoute", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("network access is forbidden in classifyIntent"),
      );

    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    await classifyIntent(
      ctx,
      argsFor(dataset, { prompt: "build a feature", projectId: "" }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readCalls.length).toBeGreaterThan(0);
    expect(new Set(readCalls.map((c) => c.type))).toEqual(new Set(["SwarmRoute"]));
  });

  it("throws when the engine does not inject a dataset handle", async () => {
    await expect(
      classifyIntent(ctx, { params: { prompt: "build" } } as ResolverArgs),
    ).rejects.toThrow(/dataset is required/);
  });

  it("throws when no prompt is supplied", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset({ SwarmRoute: sampleRoutes() }, readCalls);

    await expect(
      classifyIntent(ctx, argsFor(dataset, { projectId: "" })),
    ).rejects.toThrow(/'prompt' param is required/);
  });

  // Several projects can share one store. A project scores only its
  // own routes once it has synced any, and the legacy (unscoped) routes until
  // then — never another project's.
  it("scores the running project's routes, falling back to legacy routes", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmRoute: [
          { ...implementationRoute, id: "r-legacy", keywords: '["legacy"]' },
          { ...implementationRoute, id: "r-a", keywords: '["build"]', projectId: "project-a" },
          { ...codeReviewRoute, id: "r-b", keywords: '["ship"]', projectId: "project-b" },
        ],
      },
      readCalls,
    );
    const classify = (projectId: string, prompt: string) =>
      classifyIntent(ctx, argsFor(dataset, { prompt, projectId }));

    expect((await classify("project-a", "build it")).intent).toBe("implementation");
    expect((await classify("project-a", "legacy words")).intent).toBe("fallback");
    expect((await classify("project-a", "ship it")).intent).toBe("fallback");
    expect((await classify("project-b", "ship it")).intent).toBe("code-review");
    expect((await classify("project-c", "legacy words")).intent).toBe("implementation");
    expect((await classify("project-c", "ship it")).intent).toBe("fallback");
  });
});
