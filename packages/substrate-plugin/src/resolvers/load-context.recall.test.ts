import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
} from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadContext, makeLoadContext } from "./load-context.js";
import type { SwarmRecallDeps, SemanticHit } from "./recall.js";

function makeDataset(rowsByType: Record<string, Row[]>): Dataset {
  return {
    read: async (type: string, _params: ReadParams) => ({
      rows: rowsByType[type] ?? [],
      hasMore: false,
    }),
  } as unknown as Dataset;
}

const ctx = {} as unknown as RequestContext;
const argsFor = (dataset: Dataset, params: Record<string, unknown>): ResolverArgs => ({
  params,
  dataset,
});

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
  contentPaths: '["core/rules.md","core/values.md","skills/vetted/*.md"]',
};

/** A SwarmContent row as it comes back from a recall hit (the fields the loader reads). */
const semanticHit = (
  row: Record<string, unknown>,
  score: number,
): SemanticHit => ({ id: String(row.path), row: { id: String(row.path), ...row }, score });

function makeRecall(
  hits: SemanticHit[],
  opts: { embedderFails?: boolean } = {},
): SwarmRecallDeps {
  return {
    search: async () => {
      if (opts.embedderFails) throw new Error("ollama down");
      return hits;
    },
  };
}

function datasetWith(budget: string): Dataset {
  return makeDataset({
    SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: budget, category: "budget" }],
    SwarmRoute: [implementationRoute],
    SwarmContent: sampleContentRows(),
  });
}

const baseParams = {
  intent: "implementation",
  projectId: "sample-app",
  modelId: "m",
};

afterEach(() => vi.restoreAllMocks());

describe("loadContext with recall (within-route semantic UNION)", () => {
  it("appends a semantically-matched file the route paths did not select", async () => {
    // overview.md is NOT in the route's contentPaths; semantic recall surfaces it.
    // review.md (code-review) is in the hits too but must be intent-filtered out.
    const recall = makeRecall([
      semanticHit(
        { path: "domain/sample-app/overview.md", tier: "domain", intent: "", content: "OVERVIEW", tokenEstimate: 50 },
        0.9,
      ),
      semanticHit(
        { path: "skills/vetted/review.md", tier: "skills_vetted", intent: "code-review", content: "REVIEW", tokenEstimate: 50 },
        0.8,
      ),
    ]);
    const load = makeLoadContext(recall);

    const result = await load(
      ctx,
      argsFor(datasetWith("1000"), { ...baseParams, prompt: "where do playgrounds live" }),
    );

    const paths = result.filesIncluded.map((f) => f.path).sort();
    expect(paths).toEqual([
      "core/rules.md",
      "core/values.md",
      "domain/sample-app/overview.md", // <- added by recall
      "skills/vetted/build.md",
    ]);
    expect(paths).not.toContain("skills/vetted/review.md"); // intent-filtered
    expect(result.tokensUsed).toBe(200); // 150 path + 50 semantic
    expect(result.content).toContain("--- swarm: domain/sample-app/overview.md (domain) ---");
  });

  it("dedupes semantic hits already selected by the path leg", async () => {
    const recall = makeRecall([
      semanticHit(
        { path: "core/rules.md", tier: "core", intent: "", content: "RULES", tokenEstimate: 50 },
        0.95,
      ),
    ]);
    const load = makeLoadContext(recall);

    const result = await load(
      ctx,
      argsFor(datasetWith("1000"), { ...baseParams, prompt: "rules please" }),
    );

    const paths = result.filesIncluded.map((f) => f.path);
    expect(paths.filter((p) => p === "core/rules.md")).toHaveLength(1);
    expect(result.tokensUsed).toBe(150); // unchanged — nothing new added
  });

  it("never exceeds budget: a semantic file that does not fit is skipped", async () => {
    // Budget 150 = exactly the path-selected set; no room for the 50-token semantic file.
    const recall = makeRecall([
      semanticHit(
        { path: "domain/sample-app/overview.md", tier: "domain", intent: "", content: "OVERVIEW", tokenEstimate: 50 },
        0.9,
      ),
    ]);
    const load = makeLoadContext(recall);

    const result = await load(
      ctx,
      argsFor(datasetWith("150"), { ...baseParams, prompt: "overview" }),
    );

    expect(result.tokensUsed).toBe(150);
    expect(result.filesIncluded.map((f) => f.path)).not.toContain(
      "domain/sample-app/overview.md",
    );
    expect(result.tokensUsed).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("is byte-identical to the path baseline when no prompt is supplied", async () => {
    const recall = makeRecall([
      semanticHit(
        { path: "domain/sample-app/overview.md", tier: "domain", intent: "", content: "OVERVIEW", tokenEstimate: 50 },
        0.9,
      ),
    ]);
    const withRecallNoPrompt = await makeLoadContext(recall)(
      ctx,
      argsFor(datasetWith("1000"), baseParams),
    );
    const baseline = await loadContext(ctx, argsFor(datasetWith("1000"), baseParams));

    expect(withRecallNoPrompt).toEqual(baseline);
  });

  it("ignores the prompt entirely when recall is unwired (file-only baseline)", async () => {
    const baseLoader = makeLoadContext(); // no recall
    const withPrompt = await baseLoader(
      ctx,
      argsFor(datasetWith("1000"), { ...baseParams, prompt: "overview" }),
    );
    const baseline = await loadContext(ctx, argsFor(datasetWith("1000"), baseParams));

    expect(withPrompt).toEqual(baseline);
  });

  it("degrades to the path baseline (and warns) when the embedder is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recall = makeRecall([], { embedderFails: true });
    const load = makeLoadContext(recall);

    const result = await load(
      ctx,
      argsFor(datasetWith("1000"), { ...baseParams, prompt: "overview" }),
    );

    expect(result.tokensUsed).toBe(150);
    expect(result.filesIncluded.map((f) => f.path)).not.toContain(
      "domain/sample-app/overview.md",
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  // The embeddings store spans every project on a shared store, so
  // a semantic hit can be another project's row, or a legacy row the running
  // project has its own copy of. Neither may reach the context.
  it("drops semantic hits the running project cannot see", async () => {
    const recall = makeRecall([
      semanticHit(
        { path: "notes/other.md", tier: "domain", intent: "", content: "OTHER PROJECT", tokenEstimate: 10, projectId: "project-b" },
        0.95,
      ),
      semanticHit(
        { path: "notes/shared.md", tier: "domain", intent: "", content: "LEGACY SHARED", tokenEstimate: 10, projectId: "global" },
        0.9,
      ),
      semanticHit(
        { path: "notes/mine.md", tier: "domain", intent: "", content: "MINE", tokenEstimate: 10, projectId: "project-a" },
        0.85,
      ),
      semanticHit(
        { path: "notes/legacy-only.md", tier: "domain", intent: "", content: "LEGACY ONLY", tokenEstimate: 10, projectId: "global" },
        0.8,
      ),
    ]);
    const dataset = makeDataset({
      SwarmConfig: [{ id: "cfg1", key: "default_max_tokens", value: "1000", category: "budget" }],
      SwarmRoute: [implementationRoute],
      SwarmContent: [
        ...sampleContentRows(),
        { id: "s1", path: "notes/shared.md", tier: "domain", intent: "", content: "LEGACY SHARED", tokenEstimate: 10, projectId: "global" },
        { id: "s2", path: "notes/shared.md", tier: "domain", intent: "", content: "MY SHARED", tokenEstimate: 10, projectId: "project-a" },
      ],
    });

    const result = await makeLoadContext(recall)(
      ctx,
      argsFor(dataset, { ...baseParams, projectId: "project-a", prompt: "notes" }),
    );

    expect(result.content).toContain("MINE");
    expect(result.content).toContain("LEGACY ONLY");
    expect(result.content).not.toContain("OTHER PROJECT");
    expect(result.content).not.toContain("LEGACY SHARED");
  });
});
