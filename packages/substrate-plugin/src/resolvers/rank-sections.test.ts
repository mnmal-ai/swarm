/**
 * Ranking a project's sections by similarity to the task (stage 3 of the
 * context-sections spec): one semantic search over Section vectors, filtered
 * to the project. It degrades, never throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rankSections,
  SECTION_RANK_K,
  SECTION_SEARCH_K,
  type SemanticHit,
  type SemanticRecall,
  type SemanticSearchArgs,
} from "./recall.js";

/**
 * Recall stub under the `bge-m3:1024` model. `embedderFails` throws before the
 * search is recorded; `storeFails` after.
 */
function recallStub(
  hits: SemanticHit[],
  captured: SemanticSearchArgs[],
  opts: { embedderFails?: boolean; storeFails?: boolean } = {},
): SemanticRecall {
  return {
    model: "bge-m3:1024",
    search: async (args: SemanticSearchArgs) => {
      if (opts.embedderFails) throw new Error("ollama: connection refused");
      captured.push(args);
      if (opts.storeFails) throw new Error("pg: relation does not exist");
      return hits;
    },
  };
}

const section = (projectId: string, path: string, ordinal: number, score: number): SemanticHit => {
  const id = `${projectId}:${path}#${ordinal}`;
  return { id, row: { id, projectId, path, ordinal }, score };
};

afterEach(() => vi.restoreAllMocks());

describe("rankSections", () => {
  it("is unavailable without recall, and touches nothing", async () => {
    const out = await rankSections(undefined, { namespace: "swarm-docs", projectId: "acme", query: "fix the retry" });
    expect(out).toEqual({ status: "unavailable", hits: [] });
  });

  it("searches Section vectors for the project in the docs namespace", async () => {
    const captured: SemanticSearchArgs[] = [];
    const recall = recallStub([section("acme", "docs/a.md", 1, 0.9)], captured);
    const out = await rankSections(recall, { namespace: "swarm-docs", projectId: "acme", query: "fix the retry" });
    expect(captured).toHaveLength(1);
    // The model is chosen inside Substrate's recall; the search scopes to the project instead.
    expect(captured[0]).toMatchObject({ namespace: "swarm-docs", type: "Section", where: { projectId: { eq: "acme" } }, k: SECTION_SEARCH_K });
    expect(out.status).toBe("ranked");
    expect(out.model).toBe("bge-m3:1024");
    expect(out.hits.map((h) => h.row.path)).toEqual(["docs/a.md"]);
  });

  it("keeps only this project's sections, best first, at most SECTION_RANK_K", async () => {
    const hits = [
      section("other", "docs/x.md", 0, 0.99),
      ...Array.from({ length: SECTION_RANK_K + 5 }, (_, i) => section("acme", `docs/${i}.md`, 0, 0.9 - i / 1000)),
    ];
    const recall = recallStub(hits, []);
    const out = await rankSections(recall, { namespace: "swarm-docs", projectId: "acme", query: "q" });
    expect(out.hits).toHaveLength(SECTION_RANK_K);
    expect(out.hits.every((h) => h.row.projectId === "acme")).toBe(true);
    expect(out.hits[0].score).toBeGreaterThan(out.hits[1].score);
  });

  it("says no-embeddings when this project has no vectors for the model", async () => {
    const recall = recallStub([section("other", "docs/x.md", 0, 0.5)], []);
    const out = await rankSections(recall, { namespace: "swarm-docs", projectId: "acme", query: "q" });
    expect(out).toEqual({ status: "no-embeddings", hits: [], model: "bge-m3:1024" });
  });

  it("is unavailable, not thrown, when the embedder or the search fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = recallStub([], [], { embedderFails: true });
    expect((await rankSections(down, { namespace: "swarm-docs", projectId: "acme", query: "q" })).status).toBe("unavailable");
    const broken = recallStub([], [], { storeFails: true });
    expect((await rankSections(broken, { namespace: "swarm-docs", projectId: "acme", query: "q" })).status).toBe("unavailable");
  });
});
