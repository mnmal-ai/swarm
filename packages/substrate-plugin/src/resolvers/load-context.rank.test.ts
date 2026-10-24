/**
 * Stage 3 of "Swarm context: sections, index and pull": when a caller asks to
 * rank, the loader ranks the project's sections against the prompt and adds
 * the best-ranked ones the route didn't load, in rank order while they fit,
 * leaving a quarter of the budget for the index. Without an embedder, or with
 * nothing embedded, the context is what it would be without ranking, and the
 * response says why. Without the request, nothing changes.
 */
import type { Dataset, ReadParams, RequestContext, ResolverArgs, Row } from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DocsReader, makeLoadContext } from "./load-context.js";
import { makePrepareTask } from "./prepare-task.js";
import type { SwarmRecallDeps, SemanticHit, SemanticSearchArgs } from "./recall.js";

function dataset(rowsByType: Record<string, Row[]>): Dataset {
  return {
    read: async (type: string, _params: ReadParams) => ({ rows: rowsByType[type] ?? [], hasMore: false }),
  } as unknown as Dataset;
}

/** A docs-namespace reader returning the rows registered for each type; it ignores the where-clause. */
function docsReader(rowsByType: Record<string, Row[]>): DocsReader {
  return { namespace: "swarm-docs", read: async (type) => rowsByType[type] ?? [] };
}

const ctx = {} as unknown as RequestContext;
const args = (ds: Dataset, params: Record<string, unknown>): ResolverArgs => ({ params, dataset: ds });

const route: Row = {
  id: "r1",
  intent: "implementation",
  description: "Write code.",
  keywords: "[]",
  contentPaths: '["core/rules.md","domain/acme/architecture.md","domain/acme/glossary.md"]',
};

const content: Row[] = [
  { id: "c1", path: "core/rules.md", tier: "core", intent: "", content: "RULES WHOLE", tokenEstimate: 40, projectId: "acme" },
  { id: "c2", path: "domain/acme/architecture.md", tier: "domain", intent: "", content: "ARCH WHOLE", tokenEstimate: 300, projectId: "acme" },
  { id: "c3", path: "domain/acme/glossary.md", tier: "domain", intent: "", content: "GLOSSARY WHOLE", tokenEstimate: 50, projectId: "acme" },
];

const swarm = (budget: number) =>
  dataset({
    SwarmConfig: [{ id: "b", key: "default_max_tokens", value: String(budget), category: "budget" }],
    SwarmRoute: [route],
    SwarmContent: content,
  });

const section = (path: string, ordinal: number, heading: string[], body: string, tokens: number, source = "swarm", projectId = "acme"): Row => ({
  id: `${path}#${ordinal}`,
  document: `doc:${path}`,
  documentHash: `hash:${path}`,
  projectId,
  path,
  source,
  headingPath: JSON.stringify(heading),
  ordinal,
  level: heading.length === 0 ? 0 : 1 + heading.length,
  synopsis: `about ${heading.join(" › ") || "the start"}`,
  body,
  tokens,
  contentHash: `h-${path}-${ordinal}`,
});

const doc = (path: string, source: string, projectId = "acme"): Row => ({
  id: `doc:${path}`,
  projectId,
  path,
  source,
  title: `Title of ${path}`,
  contentHash: `hash:${path}`,
});

const docs = docsReader({
  Document: [
    doc("core/rules.md", "swarm"),
    doc("domain/acme/architecture.md", "swarm"),
    doc("docs/api.md", "project"),
    doc("docs/half-synced.md", "project"),
    doc("docs/other-x.md", "project", "other"),
  ],
  Section: [
    section("core/rules.md", 0, [], "RULES A", 20),
    section("core/rules.md", 1, ["More"], "RULES B", 20),
    section("domain/acme/architecture.md", 0, [], "ARCH A", 100),
    section("domain/acme/architecture.md", 1, ["Data model"], "ARCH B", 100),
    section("domain/acme/architecture.md", 2, ["Deploy"], "ARCH C", 100),
    // 3 lines, then 6 lines: L1–3 and L4–9.
    section("docs/api.md", 1, ["Errors"], `## Errors\n${"e\n".repeat(4)}end`, 4, "project"),
    section("docs/api.md", 0, [], "# API\nintro line\nmore", 6, "project"),
    // A sync that stopped part way: ordinal 1 is missing.
    section("docs/half-synced.md", 0, [], "# Half", 2, "project"),
    section("docs/half-synced.md", 2, ["Late"], "## Late\ntext", 3, "project"),
    section("docs/other-x.md", 0, [], "# Other project", 4, "project", "other"),
  ],
});


const sectionRows = await docs.read("Section", {});
const byId = (id: string) => sectionRows.find((r) => r.id === id)!;

/** Recall under the `bge-m3:1024` model; `fail` throws before the search is recorded (the embedder is down). */
function recallWith(ranked: Array<[string, number]>, captured: SemanticSearchArgs[] = [], opts: { fail?: boolean } = {}): SwarmRecallDeps {
  return {
    model: "bge-m3:1024",
    search: async (input: SemanticSearchArgs): Promise<SemanticHit[]> => {
      if (opts.fail) throw new Error("ollama: connection refused");
      captured.push(input);
      if (input.type !== "Section") return [{ id: String(content[1].id), row: content[1] as Row, score: 0.99 }];
      return ranked.map(([id, score]) => ({ id, row: byId(id), score }));
    },
  };
}

const run = (recall: SwarmRecallDeps | undefined, params: Record<string, unknown>, budget = 15000) =>
  makeLoadContext(recall, async () => docs)(ctx, args(swarm(budget), { intent: "implementation", projectId: "acme", modelId: "m", prompt: "how are errors returned", ...params }));

afterEach(() => vi.restoreAllMocks());

describe("loadContext with ranking", () => {
  it("changes nothing unless asked to rank", async () => {
    const recall = recallWith([["docs/api.md#1", 0.9]]);
    const plain = await run(undefined, { sections: true, index: true });
    const unasked = await run(recall, { sections: true, index: true });
    expect(unasked.content).not.toContain("(ranked)");
    expect("ranking" in unasked).toBe(false);
    expect("ranking" in plain).toBe(false);
  });

  it("adds the best-ranked sections the route didn't load, as blocks named by document and heading", async () => {
    const res = await run(recallWith([["docs/api.md#1", 0.9], ["docs/api.md#0", 0.7]]), { sections: true, index: true, rank: true });
    expect(res.content).toContain("--- swarm: docs/api.md › Errors (ranked) ---\n## Errors");
    expect(res.content).toContain("--- swarm: docs/api.md › (start) (ranked) ---\n# API");
    expect(res.content.indexOf("› Errors (ranked)")).toBeLessThan(res.content.indexOf("› (start) (ranked)"));
    expect(res.filesIncluded.slice(-2)).toEqual([
      { path: "docs/api.md › Errors", tier: "ranked", tokens: 4 },
      { path: "docs/api.md › (start)", tier: "ranked", tokens: 6 },
    ]);
    expect(res.ranking).toEqual({ status: "ranked", candidates: 2, loaded: 2, tokens: 10, model: "bge-m3:1024" });
  });

  it("adds at most rankLimit sections; the rest stay index lines, in rank order", async () => {
    const res = await run(recallWith([["docs/api.md#1", 0.9], ["docs/api.md#0", 0.7]]), { sections: true, index: true, rank: true, rankLimit: 1 });
    expect(res.ranking).toMatchObject({ candidates: 2, loaded: 1, tokens: 4 });
    expect(res.content).toContain("docs/api.md › Errors (ranked)");
    expect(res.content).not.toContain("docs/api.md › (start) (ranked)");
    const api = res.documents!.find((d) => d.path === "docs/api.md")!;
    expect(api.sections.map((s) => [s.loaded, s.score])).toEqual([
      [false, 0.7],
      [true, 0.9],
    ]);
  });

  it("marks ranked sections loaded in the index and carries every ranked section's score", async () => {
    const res = await run(recallWith([["docs/api.md#1", 0.9]]), { sections: true, index: true, rank: true });
    const api = res.documents!.find((d) => d.path === "docs/api.md")!;
    expect(api.sections.map((s) => [s.ordinal, s.loaded, s.score])).toEqual([
      [0, false, undefined],
      [1, true, 0.9],
    ]);
  });

  it("never re-adds what the route loaded, nor sections from incomplete sets or other projects", async () => {
    const res = await run(
      recallWith([["core/rules.md#0", 0.99], ["docs/half-synced.md#0", 0.98], ["docs/other-x.md#0", 0.97], ["docs/api.md#1", 0.5]]),
      { sections: true, index: true, rank: true },
    );
    expect(res.ranking).toMatchObject({ status: "ranked", candidates: 1, loaded: 1 });
    expect(res.content).not.toContain("half-synced.md › ");
    expect(res.content).not.toContain("other-x.md › ");
    expect(res.content.match(/RULES A/g)).toHaveLength(1);
  });

  it("stops at the first ranked section that doesn't fit, leaving a quarter of the budget for the index", async () => {
    // The route loads 390 tokens: rules 40, architecture 3 × 100, glossary 50.
    // Budget 526: the index keeps 131, leaving 5 for ranked bodies.
    const ranked: Array<[string, number]> = [["docs/api.md#0", 0.9], ["docs/api.md#1", 0.8]];
    const tight = await run(recallWith(ranked), { sections: true, index: true, rank: true }, 526);
    expect(tight.tokensUsed).toBe(390);
    // The 6-token section doesn't fit, and the 4-token one is not pulled over it.
    expect(tight.ranking).toMatchObject({ status: "ranked", candidates: 2, loaded: 0, tokens: 0 });
    // Budget 527 leaves 6: the first fits, then nothing is left.
    const roomier = await run(recallWith(ranked), { sections: true, index: true, rank: true }, 527);
    expect(roomier.ranking).toMatchObject({ candidates: 2, loaded: 1, tokens: 6 });
    expect(roomier.tokensUsed).toBe(396);
  });

  it("with no index asked for, ranked bodies may use the whole remaining budget", async () => {
    const res = await run(recallWith([["docs/api.md#0", 0.9], ["docs/api.md#1", 0.8]]), { sections: true, rank: true }, 400);
    expect(res.ranking).toMatchObject({ loaded: 2, tokens: 10 });
    expect(res.tokensUsed).toBe(400);
  });

  it("keeps the context and says unavailable when the embedder is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plain = await run(undefined, { sections: true, index: true });
    const down = await run(recallWith([], [], { fail: true }), { sections: true, index: true, rank: true });
    expect(down.content).toBe(plain.content);
    expect(down.ranking).toMatchObject({ status: "unavailable", candidates: 0, loaded: 0, tokens: 0 });
  });

  it("says unavailable when the sidecar has no embedder at all", async () => {
    const res = await run(undefined, { sections: true, index: true, rank: true });
    expect(res.ranking).toEqual({ status: "unavailable", candidates: 0, loaded: 0, tokens: 0 });
  });

  it("says no-embeddings when nothing in the project has a vector yet", async () => {
    const res = await run(recallWith([]), { sections: true, index: true, rank: true });
    expect(res.ranking).toEqual({ status: "no-embeddings", candidates: 0, loaded: 0, tokens: 0, model: "bge-m3:1024" });
  });

  it("replaces whole-file recall: with ranking on, swarm files are not appended whole", async () => {
    const captured: SemanticSearchArgs[] = [];
    await run(recallWith([["docs/api.md#1", 0.9]], captured), { sections: true, index: true, rank: true });
    expect(captured.map((c) => c.type)).toEqual(["Section"]);
  });

  it("is forwarded by prepareTask", async () => {
    const prepare = makePrepareTask(recallWith([["docs/api.md#1", 0.9]]), async () => docs);
    const res = await prepare(ctx, args(swarm(15000), { prompt: "how are errors returned", intentOverride: "implementation", projectId: "acme", modelId: "m", sections: true, index: true, rank: true }));
    expect(res.ranking).toMatchObject({ status: "ranked", loaded: 1 });
  });
});
