/**
 * The engine-backed reads, against a recording engine stub: the frame each
 * one sends, and that a refused frame throws instead of reading as empty.
 * `test/prepare-task.e2e.test.ts` runs the same code against a real engine.
 */
import type { EngineHandle, EngineInput, PackEnvelope } from "@mnmal-ai/substrate/sdk";
import { describe, expect, it } from "vitest";
import { makeEngineDocsReader, makeEngineRecall, RECALL_HIT_KEY } from "./engine-recall.js";

function engineAnswering(answers: Array<Partial<PackEnvelope>>, frames: EngineInput[]): EngineHandle {
  return {
    query: async (input: EngineInput) => {
      frames.push(input);
      return { schemaVersion: "x", shapes: {}, data: {}, ...answers.shift() } as PackEnvelope;
    },
  } as unknown as EngineHandle;
}

describe("makeEngineRecall", () => {
  it("sends a dense, read-only recall/Hit frame and maps the hits", async () => {
    const frames: EngineInput[] = [];
    const engine = engineAnswering([{ data: { [RECALL_HIT_KEY]: [{ id: "r1", score: 0.8, row: { id: "r1", intent: "x" } }] } }], frames);
    const hits = await makeEngineRecall(() => engine).search({
      namespace: "swarm",
      type: "SwarmContent",
      query: "add a feature",
      k: 8,
      rowFields: { intent: true },
      ctx: { identity: null },
    });
    expect(hits).toEqual([{ id: "r1", score: 0.8, row: { id: "r1", intent: "x" } }]);
    expect(frames[0]).toEqual({
      frame: {
        [RECALL_HIT_KEY]: {
          params: { to: "add a feature", namespace: "swarm", type: "SwarmContent", k: 8, boost: false, lexical: false },
          fields: { id: true, score: true, row: { intent: true } },
        },
      },
      ctx: { identity: null },
    });
  });

  it("throws the envelope's error rather than answering no hits", async () => {
    const engine = engineAnswering([{ errors: [{ code: "embedder_unavailable", message: "no embedder" }] }], []);
    await expect(
      makeEngineRecall(() => engine).search({ namespace: "swarm", type: "SwarmContent", query: "q", k: 1, rowFields: true }),
    ).rejects.toThrow(/recall\/Hit failed: embedder_unavailable: no embedder/);
  });

  it("throws before the engine has started", async () => {
    await expect(
      makeEngineRecall(() => undefined).search({ namespace: "swarm", type: "SwarmContent", query: "q", k: 1, rowFields: true }),
    ).rejects.toThrow(/engine has not started/);
  });
});

describe("makeEngineDocsReader", () => {
  it("follows the cursor and asks for every declared field", async () => {
    const frames: EngineInput[] = [];
    const key = "swarm-docs/Section";
    const engine = engineAnswering(
      [
        { data: { [key]: [{ id: "s1" }] }, _pagination: { [key]: { hasMore: true, nextCursor: "c2" } } },
        { data: { [key]: [{ id: "s2" }] }, _pagination: { [key]: { hasMore: false } } },
      ],
      frames,
    );
    const reader = makeEngineDocsReader(() => engine, "swarm-docs", { Document: ["path"], Section: ["path", "body"] });
    const rows = await reader.read("Section", { where: { projectId: { eq: "acme" } }, limit: 1 });
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(frames.map((f) => f.frame[key])).toEqual([
      { params: { limit: 1, where: { projectId: { eq: "acme" } } }, fields: { id: true, path: true, body: true } },
      { params: { limit: 1, where: { projectId: { eq: "acme" } }, cursor: "c2" }, fields: { id: true, path: true, body: true } },
    ]);
  });

  it("throws a refused read", async () => {
    const engine = engineAnswering([{ errors: [{ code: "unknown_namespace", message: "no swarm-docs" }] }], []);
    const reader = makeEngineDocsReader(() => engine, "swarm-docs", { Document: [], Section: [] });
    await expect(reader.read("Document", {})).rejects.toThrow(/swarm-docs\/Document failed: unknown_namespace/);
  });
});
