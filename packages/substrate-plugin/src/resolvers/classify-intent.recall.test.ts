import type {
  Dataset,
  ReadParams,
  RequestContext,
  ResolverArgs,
  Row,
} from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClassifyIntent } from "./classify-intent.js";
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

const routes: Row[] = [
  {
    id: "r1",
    intent: "code-review",
    description: "Review code changes.",
    keywords: '["review","PR"]',
    contentPaths: '["core/rules.md"]',
  },
  {
    id: "r2",
    intent: "implementation",
    description: "Build a feature or fix a bug.",
    keywords: '["build","implement"]',
    contentPaths: '["core/rules.md"]',
  },
];

/** Recall stub. `knnCalls` counts searches that reached the store so we can
 *  assert the embedding leg is skipped whenever keyword scoring already
 *  matched; `embedderFails` throws before the store is reached. */
function makeRecall(
  hits: SemanticHit[],
  knnCalls: { n: number },
  opts: { embedderFails?: boolean } = {},
): SwarmRecallDeps {
  return {
    search: async () => {
      if (opts.embedderFails) throw new Error("ollama down");
      knnCalls.n += 1;
      return hits;
    },
  };
}

const hit = (intent: string, score: number): SemanticHit => ({
  id: `c/${intent}.md`,
  row: { id: `c/${intent}.md`, path: `c/${intent}.md`, intent },
  score,
});

afterEach(() => vi.restoreAllMocks());

describe("classifyIntent with recall", () => {
  it("keeps the keyword path primary and does NOT consult recall when a keyword matches", async () => {
    const knnCalls = { n: 0 };
    const recall = makeRecall([hit("code-review", 0.99)], knnCalls);
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "build this thing", // matches implementation's "build"
        projectId: "",
      }),
    );

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("keyword");
    expect(knnCalls.n).toBe(0); // embedding leg never ran — keyword won
  });

  it("recovers an intent via semantic recall when no keyword matches", async () => {
    const knnCalls = { n: 0 };
    // Top hits point at implementation; one stray code-review hit with lower score.
    const recall = makeRecall(
      [hit("implementation", 0.91), hit("implementation", 0.6), hit("code-review", 0.5)],
      knnCalls,
    );
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "ship the new onboarding flow", // no keyword hits
        projectId: "",
      }),
    );

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("semantic");
    expect(result.matchedKeywords).toEqual([]);
    expect(knnCalls.n).toBe(1);
  });

  it("falls back when semantic hits name no known route", async () => {
    const knnCalls = { n: 0 };
    const recall = makeRecall([hit("nonexistent-intent", 0.95)], knnCalls);
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "ship the new onboarding flow",
        projectId: "",
      }),
    );

    expect(result.intent).toBe("fallback");
    expect(result.confidence).toBe("fallback");
  });

  it("degrades to fallback (keyword baseline) when the embedder is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const knnCalls = { n: 0 };
    const recall = makeRecall([], knnCalls, { embedderFails: true });
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "ship the new onboarding flow",
        projectId: "",
      }),
    );

    expect(result.intent).toBe("fallback");
    expect(result.confidence).toBe("fallback");
  });

  it("still honours an exact intentOverride without consulting recall", async () => {
    const knnCalls = { n: 0 };
    const recall = makeRecall([hit("implementation", 0.99)], knnCalls);
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "anything",
        projectId: "",
        intentOverride: "code-review",
      }),
    );

    expect(result.intent).toBe("code-review");
    expect(result.confidence).toBe("exact");
    expect(knnCalls.n).toBe(0);
  });

  // The embeddings store spans every project on a shared store; a
  // hit from another project's content must not vote.
  it("ignores semantic hits from another project's content", async () => {
    const knnCalls = { n: 0 };
    const scoped = (intent: string, score: number, projectId: string): SemanticHit => ({
      id: `c/${intent}.md`,
      row: { id: `c/${intent}.md`, path: `c/${intent}.md`, intent, projectId },
      score,
    });
    const recall = makeRecall(
      [scoped("code-review", 0.95, "project-b"), scoped("implementation", 0.4, "project-a")],
      knnCalls,
    );
    const classify = makeClassifyIntent(recall);

    const result = await classify(
      ctx,
      argsFor(makeDataset({ SwarmRoute: routes }), {
        prompt: "tidy up the module",
        projectId: "project-a",
      }),
    );

    expect(result.intent).toBe("implementation");
    expect(result.confidence).toBe("semantic");
  });
});
