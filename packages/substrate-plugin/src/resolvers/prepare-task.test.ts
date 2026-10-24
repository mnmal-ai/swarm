import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
} from "@mnmal-ai/substrate/sdk";
import { describe, expect, it } from "vitest";
import { classifyIntent } from "./classify-intent.js";
import { loadContext } from "./load-context.js";
import { prepareTask, scoreComplexity } from "./prepare-task.js";

/**
 * Stub `Dataset` whose `read` returns the rows registered for each type in
 * one non-paged page. It ignores the `where` clause — `classifyIntent` reads all
 * SwarmRoute rows and `loadContext` re-finds the matching route defensively, so
 * an unmatched intent still yields `routeMatched: null` (the fallback path).
 */
function makeDataset(rowsByType: Record<string, Row[]>): Dataset {
  return {
    read: async (type: string, _params: ReadParams) => {
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

const routes: Row[] = [
  {
    id: "r1",
    intent: "code-review",
    description: "Review code changes.",
    keywords: '["review","PR","diff"]',
    contentPaths: '["core/values.md"]',
  },
  {
    id: "r2",
    intent: "implementation",
    description: "Build a feature or fix a bug.",
    keywords: '["build","add","implement","fix"]',
    contentPaths:
      '["core/values.md","modes/implementation.md","domains/{project}/architecture.md"]',
  },
];

const content: Row[] = [
  { id: "c1", path: "core/values.md", tier: "core", intent: "", content: "Ship it.", tokenEstimate: 100, lastReviewed: "2026-01-01", projectId: "sample-app" },
  { id: "c2", path: "modes/implementation.md", tier: "mode", intent: "", content: "Smallest change that works.", tokenEstimate: 300, lastReviewed: "2026-01-01", projectId: "sample-app" },
  { id: "c3", path: "domains/sample-app/architecture.md", tier: "domain", intent: "", content: "Lazy-loading cache.", tokenEstimate: 500, lastReviewed: "2026-01-01", projectId: "sample-app" },
];

const config: Row[] = [
  { id: "cfg1", key: "default_max_tokens", value: "15000", category: "budget" },
];

function fullDataset(): Dataset {
  return makeDataset({ SwarmRoute: routes, SwarmContent: content, SwarmConfig: config });
}

const REQ = {
  prompt: "implement a feature",
  projectId: "sample-app",
  modelId: "claude-sonnet-4-6",
};

describe("scoreComplexity", () => {
  it("scores a fallback (no route, no files, no budget) as zero", () => {
    expect(scoreComplexity("fallback", 0, 0, 0)).toBe(0);
  });

  it("scores a saturated exact match as one", () => {
    expect(scoreComplexity("exact", 8, 15000, 15000)).toBe(1);
  });

  it("stays within [0, 1] and ranks a matched task above a fallback", () => {
    const matched = scoreComplexity("keyword", 3, 900, 15000);
    expect(matched).toBeGreaterThan(scoreComplexity("fallback", 0, 0, 0));
    expect(matched).toBeGreaterThanOrEqual(0);
    expect(matched).toBeLessThanOrEqual(1);
  });
});

describe("prepareTask resolver", () => {
  it("returns intent + assembled context + complexity in one call", async () => {
    const result = await prepareTask(ctx, argsFor(fullDataset(), REQ));

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("keyword");
    expect(result.matchedKeywords).toContain("implement");
    expect(result.routeMatched).not.toBeNull();
    expect(result.content).not.toBe("");
    expect(result.filesIncluded.length).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.budgetTokens).toBe(15000);
    expect(result.complexity).toBeGreaterThan(0);
    expect(result.complexity).toBeLessThanOrEqual(1);
  });

  it("is field-for-field equal to classifyIntent + loadContext composed", async () => {
    const classification = await classifyIntent(
      ctx,
      argsFor(fullDataset(), { prompt: REQ.prompt, projectId: REQ.projectId }),
    );
    const loaded = await loadContext(
      ctx,
      argsFor(fullDataset(), {
        intent: classification.intent,
        projectId: REQ.projectId,
        modelId: REQ.modelId,
      }),
    );
    const prepared = await prepareTask(ctx, argsFor(fullDataset(), REQ));

    expect(prepared.intent).toBe(classification.intent);
    expect(prepared.confidence).toBe(classification.confidence);
    expect(prepared.matchedKeywords).toEqual(classification.matchedKeywords);
    expect(prepared.content).toBe(loaded.content);
    expect(prepared.filesIncluded).toEqual(loaded.filesIncluded);
    expect(prepared.tokensUsed).toBe(loaded.tokensUsed);
    expect(prepared.budgetTokens).toBe(loaded.budgetTokens);
    expect(prepared.routeMatched).toEqual(loaded.routeMatched);
    expect(prepared.truncated).toEqual(loaded.truncated);
    expect(prepared.omitted).toEqual(loaded.omitted);
  });

  it("falls back with no context and low complexity when nothing matches", async () => {
    const result = await prepareTask(
      ctx,
      argsFor(fullDataset(), { ...REQ, prompt: "what is the meaning of life?" }),
    );

    expect(result.intent).toBe("fallback");
    expect(result.confidence).toBe("fallback");
    expect(result.routeMatched).toBeNull();
    expect(result.content).toBe("");
    expect(result.filesIncluded).toEqual([]);
    expect(result.complexity).toBeLessThan(0.5);
  });

  it("forwards an intentOverride to classifyIntent (confidence 'exact')", async () => {
    const result = await prepareTask(
      ctx,
      argsFor(fullDataset(), { ...REQ, prompt: "anything", intentOverride: "code-review" }),
    );

    expect(result.intent).toBe("code-review");
    expect(result.confidence).toBe("exact");
    expect(result.matchedKeywords).toEqual([]);
  });
});
