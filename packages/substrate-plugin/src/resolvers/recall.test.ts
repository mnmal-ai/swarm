import type { Row } from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SwarmRecallDeps,
  recallSwarmContent,
  type SemanticHit,
  type SemanticRecall,
  type SemanticSearchArgs,
} from "./recall.js";

/**
 * Recall stub: records each search and returns canned hits. `embedderFails`
 * throws before the search is recorded (the embed step never reached the
 * store, as with Ollama down); `storeFails` throws after (embedded, then the
 * store failed).
 */
function fakeRecall(
  hits: SemanticHit[],
  captured: SemanticSearchArgs[],
  opts: { embedderFails?: boolean; storeFails?: boolean } = {},
): SemanticRecall {
  return {
    search: async (args: SemanticSearchArgs) => {
      if (opts.embedderFails) throw new Error("ollama: connection refused");
      captured.push(args);
      if (opts.storeFails) throw new Error("pg: relation does not exist");
      return hits;
    },
  };
}

function hit(row: Record<string, unknown>, score: number): SemanticHit {
  const id = String(row.path);
  return { id, row: { id, ...row } as Row, score };
}

afterEach(() => vi.restoreAllMocks());

describe("recallSwarmContent", () => {
  it("returns [] without touching the store when recall deps are absent", async () => {
    const captured: SemanticSearchArgs[] = [];
    const out = await recallSwarmContent(undefined, "anything");
    expect(out).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("returns [] for an empty/whitespace query", async () => {
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = fakeRecall([], captured);
    expect(await recallSwarmContent(recall, "   ")).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("searches SwarmContent for the query", async () => {
    const captured: SemanticSearchArgs[] = [];
    const hits = [
      hit({ path: "domain/a.md", intent: "implementation" }, 0.9),
      hit({ path: "domain/b.md", intent: "code-review" }, 0.7),
    ];
    const recall: SwarmRecallDeps = fakeRecall(hits, captured);

    const out = await recallSwarmContent(recall, "add a feature");

    expect(out.map((h) => h.row.path)).toEqual(["domain/a.md", "domain/b.md"]);
    expect(out.map((h) => h.score)).toEqual([0.9, 0.7]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      namespace: "swarm",
      type: "SwarmContent",
      query: "add a feature",
      k: 8,
    });
  });

  it("honours an explicit k and a custom namespace", async () => {
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = {
      ...fakeRecall([], captured),
      namespace: "swarm_test",
      topK: 3,
    };
    await recallSwarmContent(recall, "q");
    expect(captured[0]).toMatchObject({ namespace: "swarm_test", k: 3 });
    await recallSwarmContent(recall, "q", 1);
    expect(captured[1]).toMatchObject({ k: 1 });
  });

  it("forwards similarityThreshold to the search when set", async () => {
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = {
      ...fakeRecall([], captured),
      similarityThreshold: 0.42,
    };
    await recallSwarmContent(recall, "q");
    expect(captured[0].threshold).toBe(0.42);
  });

  it("forwards threshold undefined when similarityThreshold is unset (default 0 cutoff)", async () => {
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = fakeRecall([], captured);
    await recallSwarmContent(recall, "q");
    expect(captured[0].threshold).toBeUndefined();
  });

  it("degrades to [] and warns when the embedder is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = fakeRecall([], captured, { embedderFails: true });

    const out = await recallSwarmContent(recall, "add a feature");

    expect(out).toEqual([]);
    expect(captured).toEqual([]); // never reached the store
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/falling back to keyword\/path only/);
  });

  it("degrades to [] and warns when the search throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: SemanticSearchArgs[] = [];
    const recall: SwarmRecallDeps = fakeRecall([], captured, { storeFails: true });

    expect(await recallSwarmContent(recall, "add a feature")).toEqual([]);
    expect(captured).toHaveLength(1); // embedded, then store failed
    expect(warn).toHaveBeenCalledOnce();
  });
});
