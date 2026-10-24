import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
} from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadContext } from "./load-context.js";

/**
 * Build a stub `Dataset` whose `read` returns the rows registered for each
 * type. It ignores the where-clause (the resolver re-finds defensively) and
 * always returns a single non-paged page. `readCalls` records every read so we
 * can assert the resolver's only I/O is dataset reads.
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

/** A representative content set: two required core files, two skill files (one
 *  scoped to a different intent), and one unrelated domain file. */
function sampleContentRows(): Row[] {
  return [
    { id: "c1", path: "core/rules.md", tier: "core", intent: "", content: "RULES", tokenEstimate: 50 },
    { id: "c2", path: "core/values.md", tier: "core", intent: "", content: "VALUES", tokenEstimate: 50 },
    { id: "c3", path: "skills/vetted/build.md", tier: "skills_vetted", intent: "implementation", content: "BUILD", tokenEstimate: 50 },
    { id: "c4", path: "skills/vetted/review.md", tier: "skills_vetted", intent: "code-review", content: "REVIEW", tokenEstimate: 50 },
    { id: "c5", path: "domain/sample-app/overview.md", tier: "domain", intent: "", content: "OVERVIEW", tokenEstimate: 50 },
  ];
}

const implementationRoute: Row = {
  id: "r1",
  intent: "implementation",
  description: "Write code to satisfy the request.",
  keywords: '["build","add","implement"]',
  // Exact paths + a single-segment glob — exercises JSON parsing AND glob match.
  contentPaths: '["core/rules.md","core/values.md","skills/vetted/*.md"]',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadContext resolver", () => {
  it("parses contentPaths, includes every matched file, and stays within budget", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmConfig: [
          { id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" },
        ],
        SwarmRoute: [implementationRoute],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "sample-app", modelId: "claude-opus-4-8" }),
    );

    const includedPaths = result.filesIncluded.map((f) => f.path).sort();
    // The glob `skills/vetted/*.md` matched both skill files; intent filtering
    // dropped review.md (code-review). domain/overview.md never matched the route.
    expect(includedPaths).toEqual([
      "core/rules.md",
      "core/values.md",
      "skills/vetted/build.md",
    ]);

    // tokensUsed is the sum of the three 50-token files and is within budget.
    expect(result.tokensUsed).toBe(150);
    expect(result.budgetTokens).toBe(1000);
    expect(result.tokensUsed).toBeLessThanOrEqual(result.budgetTokens);

    // Assembled blob uses the load-bearing delimiter contract.
    expect(result.content).toContain("--- swarm: core/rules.md (core) ---");
    expect(result.content).toContain("--- swarm: skills/vetted/build.md (skills_vetted) ---");
    expect(result.content).not.toContain("review.md");

    expect(result.routeMatched).toEqual({
      intent: "implementation",
      description: "Write code to satisfy the request.",
    });
  });

  it("makes no LLM or network call — its only I/O is dataset reads", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access is forbidden in loadContext"));

    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" }],
        SwarmRoute: [implementationRoute],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "sample-app", modelId: "m" }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    // Every piece of data came from dataset.read, and only the three expected types.
    expect(readCalls.length).toBeGreaterThan(0);
    expect(new Set(readCalls.map((c) => c.type))).toEqual(
      new Set(["SwarmConfig", "SwarmRoute", "SwarmContent"]),
    );
  });

  it("honours a model-specific budget override", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmConfig: [
          { id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" },
          { id: "cfg2", key: "model_override:tiny-model", value: "500", category: "budget" },
        ],
        SwarmRoute: [implementationRoute],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "", modelId: "tiny-model" }),
    );
    expect(result.budgetTokens).toBe(500);
  });

  it("returns an empty context with null routeMatched when no route matches", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" }],
        SwarmRoute: [implementationRoute],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "no-such-intent", projectId: "", modelId: "m" }),
    );
    expect(result.routeMatched).toBeNull();
    expect(result.filesIncluded).toEqual([]);
    expect(result.content).toBe("");
    expect(result.tokensUsed).toBe(0);
    expect(result.budgetTokens).toBe(1000);
  });

  it("throws (does not truncate) when required content alone exceeds the budget", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "10", category: "budget" }],
        SwarmRoute: [
          {
            id: "r1",
            intent: "implementation",
            description: "d",
            keywords: "[]",
            // Only required (core) files — they always load, so this can only
            // trip invariant 1 (budget), never invariant 2 (dropped files).
            contentPaths: '["core/rules.md","core/values.md"]',
          },
        ],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    await expect(
      loadContext(ctx, argsFor(dataset, { intent: "implementation", projectId: "", modelId: "m" })),
    ).rejects.toThrow(/exceeds budget/);
  });

  it("surfaces budget-dropped optional files in `truncated` (does not throw)", async () => {
    // Mirrors the legacy `Loader.load` shape: optional-tier files that exceed
    // the budget land in `truncated`, the call resolves, and the caller forwards
    // the list to its `context:loaded` event. Swarm.run on the prepareTask path
    // depends on this — the prior throw-on-drop behaviour aborted the entire
    // run whenever an optional skill pushed past the model's budget, even
    // though the file-only fallback path degraded gracefully in the same
    // configuration (a review flagged the inconsistency as critical). The
    // throw stays in place for the NON-budget drop case (covered by a
    // separate test below).
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const dataset = makeDataset(
      {
        // Budget fits the required core file (50) but not the optional skill (another 50).
        SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "60", category: "budget" }],
        SwarmRoute: [
          {
            id: "r1",
            intent: "implementation",
            description: "d",
            keywords: "[]",
            contentPaths: '["core/rules.md","skills/vetted/build.md"]',
          },
        ],
        SwarmContent: sampleContentRows(),
      },
      readCalls,
    );

    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "", modelId: "m" }),
    );

    expect(result.filesIncluded.map((f) => f.path)).toEqual(["core/rules.md"]);
    expect(result.truncated).toEqual(["skills/vetted/build.md"]);
    expect(result.tokensUsed).toBe(50);
    expect(result.budgetTokens).toBe(60);
  });

  it("reports what the budget left out, with each file's tier and tokens", async () => {
    const dataset = makeDataset({
      SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "60", category: "budget" }],
      SwarmRoute: [
        {
          id: "r1",
          intent: "implementation",
          description: "d",
          keywords: "[]",
          contentPaths: '["core/rules.md","skills/vetted/build.md","https://example.com/skill.md"]',
        },
      ],
      SwarmContent: sampleContentRows(),
    }, []);

    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "", modelId: "m" }),
    );

    // Only budget drops: an unseeded remote URL is in `truncated`, but it has
    // no content to count, so it isn't "left out for budget".
    expect(result.omitted).toEqual([{ path: "skills/vetted/build.md", tier: "skills_vetted", tokens: 50 }]);
    expect(result.truncated).toEqual(["skills/vetted/build.md", "https://example.com/skill.md"]);
  });

  it("reports nothing left out when no route matches", async () => {
    const dataset = makeDataset({ SwarmConfig: [], SwarmRoute: [], SwarmContent: sampleContentRows() }, []);
    const result = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "", modelId: "m" }),
    );
    expect(result.omitted).toEqual([]);
  });

  it("throws when the engine does not inject a dataset handle", async () => {
    await expect(
      loadContext(ctx, { params: { intent: "implementation", modelId: "m" } } as ResolverArgs),
    ).rejects.toThrow(/dataset is required/);
  });

  // Several projects can share one store. The running project reads
  // its own rows, falls back to legacy rows (content under `global`, routes
  // with no projectId), and never reads another project's.
  it("selects the running project's route and content, falling back to legacy rows", async () => {
    const readCalls: Array<{ type: string; params: ReadParams }> = [];
    const route = (id: string, description: string, projectId?: string): Row => ({
      id,
      intent: "implementation",
      description,
      keywords: "[]",
      contentPaths: '["core/rules.md","core/values.md"]',
      ...(projectId ? { projectId } : {}),
    });
    const row = (id: string, path: string, content: string, projectId: string): Row => ({
      id, path, tier: "core", intent: "", content, tokenEstimate: 10, projectId,
    });
    const dataset = makeDataset(
      {
        SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" }],
        SwarmRoute: [
          route("r-legacy", "legacy"),
          route("r-b", "project b", "project-b"),
          route("r-a", "project a", "project-a"),
        ],
        SwarmContent: [
          row("c1", "core/values.md", "LEGACY VALUES", "global"),
          row("c2", "core/values.md", "B VALUES", "project-b"),
          row("c3", "core/values.md", "A VALUES", "project-a"),
          row("c4", "core/rules.md", "LEGACY RULES", "global"),
          row("c5", "core/rules.md", "B RULES", "project-b"),
        ],
      },
      readCalls,
    );

    const a = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "project-a", modelId: "m" }),
    );
    expect(a.routeMatched?.description).toBe("project a");
    // Own values.md wins over legacy; rules.md has no project-a row, so legacy.
    expect(a.content).toContain("A VALUES");
    expect(a.content).toContain("LEGACY RULES");
    expect(a.content).not.toContain("B ");
    expect(a.content).not.toContain("LEGACY VALUES");

    // A project that has synced nothing yet still reads the legacy rows.
    const c = await loadContext(
      ctx,
      argsFor(dataset, { intent: "implementation", projectId: "project-c", modelId: "m" }),
    );
    expect(c.routeMatched?.description).toBe("legacy");
    expect(c.content).toContain("LEGACY VALUES");
    expect(c.content).toContain("LEGACY RULES");
  });
});
