/**
 * The swarm query resolvers end to end: registered on the `swarm` namespace,
 * reached over `POST /substrate/v1/query`, reading rows the autoCRUD mutations
 * wrote, and (for the semantic leg) recalling through the engine's
 * `recall/Hit` frame against vectors the recall plugin's `embed.source` hook
 * stored with the FakeEmbedder.
 */
import { RECALL_CONFIG_CATEGORY, RECALL_SIMILARITY_THRESHOLD_KEY } from "@mnmal-ai/swarm-substrate-shared";
import { describe, expect, it } from "vitest";
import { bootTestServer, type TestServer } from "./harness.js";

interface Envelope {
  data: Record<string, unknown>;
  errors?: Array<{ code?: string; message?: string }>;
}

interface SeedRows {
  routes?: Array<Record<string, unknown>>;
  content?: Array<Record<string, unknown>>;
  config?: Array<Record<string, unknown>>;
}

/** POST one mutate frame and fail loudly on any error. */
async function mutate(s: TestServer, key: string, params: Record<string, unknown>): Promise<{ id: string }> {
  const res = (
    await s.inject({ method: "POST", url: "/substrate/v1/mutate", body: { [key]: { params, fields: { id: true } } } })
  ).json() as Envelope;
  expect(res.errors ?? []).toEqual([]);
  return res.data[key] as { id: string };
}

/**
 * Write rows through the autoCRUD mutations, so validation and the recall
 * plugin's `embed.source` hook run as they do in production. Fields the brief
 * rows leave out but the types require get neutral values.
 */
async function seed(s: TestServer, rows: SeedRows): Promise<void> {
  for (const route of rows.routes ?? []) {
    await mutate(s, "swarm/createSwarmRoute", { description: "", keywords: "[]", contentPaths: "[]", ...route });
  }
  for (const content of rows.content ?? []) {
    await mutate(s, "swarm/createSwarmContent", { tier: "core", intent: "", lastReviewed: "2026-10-23", projectId: "p1", ...content });
  }
  for (const config of rows.config ?? []) {
    await mutate(s, "swarm/createSwarmConfig", config);
  }
}

async function query(s: TestServer, key: string, params: Record<string, unknown>, fields: Record<string, unknown>): Promise<Envelope> {
  return (await s.inject({ method: "POST", url: "/substrate/v1/query", body: { [key]: { params, fields } } })).json() as Envelope;
}

describe("swarm query resolvers over the engine", () => {
  it("prepareTask classifies by keyword and loads routed content within budget", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      await seed(s, {
        routes: [{ intent: "testing", keywords: '["vitest","test"]', contentPaths: '["docs/testing.md"]' }],
        content: [{ path: "docs/testing.md", tier: "core", intent: "testing", content: "# Testing\nRun vitest.", tokenEstimate: 8, projectId: "p1" }],
        config: [{ key: "default_max_tokens", value: "4000", category: "budget" }],
      });

      const res = await query(
        s,
        "swarm/prepareTask",
        { prompt: "add a vitest test", projectId: "p1", modelId: "test-model" },
        { intent: true, confidence: true, filesIncluded: true, tokensUsed: true, budgetTokens: true },
      );
      expect(res.errors ?? []).toEqual([]);
      const row = res.data["swarm/prepareTask"] as {
        intent: string;
        confidence: string;
        filesIncluded: Array<{ path: string }>;
        tokensUsed: number;
        budgetTokens: number;
      };
      expect(row.intent).toBe("testing");
      expect(row.confidence).toBe("keyword");
      expect(row.filesIncluded.map((f) => f.path)).toEqual(["docs/testing.md"]);
      expect(row.budgetTokens).toBe(4000);
      expect(row.tokensUsed).toBeLessThanOrEqual(row.budgetTokens);
    } finally {
      await s.stop();
    }
  });

  it("classifyIntent falls back to recall through the engine, without bumping salience", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const text = "ship the new onboarding flow";
      await seed(s, {
        routes: [{ intent: "implementation", keywords: '["build"]', contentPaths: '["domain/flow.md"]' }],
        content: [{ path: "domain/flow.md", tier: "domain", intent: "implementation", content: text, tokenEstimate: 5 }],
      });

      const res = await query(
        s,
        "swarm/classifyIntent",
        { prompt: text, projectId: "p1" },
        { intent: true, confidence: true, matchedKeywords: true },
      );
      expect(res.errors ?? []).toEqual([]);
      expect(res.data["swarm/classifyIntent"]).toEqual({ intent: "implementation", confidence: "semantic", matchedKeywords: [] });

      // The resolver's recall ran with boost: false, so the hit's salience is untouched.
      const hits = await query(
        s,
        "recall/Hit",
        { to: text, namespace: "swarm", type: "SwarmContent", k: 1, boost: false },
        { id: true, salience: true },
      );
      expect(hits.errors ?? []).toEqual([]);
      expect(hits.data["recall/Hit"]).toEqual([{ id: expect.any(String), salience: 0 }]);
    } finally {
      await s.stop();
    }
  });

  it("prepareTask reads sections from swarm-docs and ranks them through the engine", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      await seed(s, {
        routes: [{ intent: "testing", keywords: '["vitest"]', contentPaths: '["docs/testing.md"]' }],
        content: [{ path: "docs/testing.md", tier: "core", intent: "testing", content: "WHOLE FILE", tokenEstimate: 8 }],
      });
      const section = async (path: string, source: "swarm" | "project", synopsis: string, body: string) => {
        const doc = await mutate(s, "swarm-docs/createDocument", { projectId: "p1", path, source, title: path, contentHash: `h:${path}` });
        await mutate(s, "swarm-docs/createSection", {
          document: doc.id,
          projectId: "p1",
          path,
          source,
          headingPath: "[]",
          ordinal: 0,
          level: 0,
          synopsis,
          body,
          tokens: 6,
          contentHash: `s:${path}`,
          documentHash: `h:${path}`,
        });
      };
      await section("docs/testing.md", "swarm", "Testing", "SECTION BODY");
      await section("docs/api.md", "project", "API errors", "errors are returned as JSON");

      // The prompt is the project section's embed text, so recall ranks it first.
      const res = await query(
        s,
        "swarm/prepareTask",
        {
          prompt: "API errors\nerrors are returned as JSON",
          intentOverride: "testing",
          projectId: "p1",
          modelId: "test-model",
          sections: true,
          index: true,
          rank: true,
        },
        { confidence: true, content: true, ranking: true, documents: true },
      );
      expect(res.errors ?? []).toEqual([]);
      const row = res.data["swarm/prepareTask"] as {
        confidence: string;
        content: string;
        ranking: { status: string; loaded: number };
        documents: Array<{ path: string; source: string }>;
      };
      expect(row.confidence).toBe("exact");
      expect(row.content).toContain("--- swarm: docs/testing.md (core) ---\nSECTION BODY");
      expect(row.content).not.toContain("WHOLE FILE");
      expect(row.content).toContain("--- swarm: docs/api.md › (start) (ranked) ---\nerrors are returned as JSON");
      expect(row.ranking).toMatchObject({ status: "ranked", loaded: 1 });
      expect(row.documents.map((d) => [d.path, d.source])).toEqual([["docs/api.md", "project"]]);
    } finally {
      await s.stop();
    }
  });

  it("reads the recall similarity threshold from SwarmConfig at call time", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const prompt = "ship the new onboarding flow";
      await seed(s, {
        routes: [{ intent: "implementation", keywords: '["build"]', contentPaths: "[]" }],
        content: [{ path: "domain/flow.md", tier: "domain", intent: "implementation", content: "new onboarding flow", tokenEstimate: 5 }],
      });
      // The cosine the FakeEmbedder gives this pair (about 0.68), as recall reports it.
      const probe = await query(s, "recall/Hit", { to: prompt, namespace: "swarm", type: "SwarmContent", k: 1, boost: false }, { score: true });
      const [{ score }] = probe.data["recall/Hit"] as Array<{ score: number }>;
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);

      const classify = async () =>
        (await query(s, "swarm/classifyIntent", { prompt, projectId: "p1" }, { confidence: true })).data["swarm/classifyIntent"];
      expect(await classify()).toEqual({ confidence: "semantic" });

      const threshold = await mutate(s, "swarm/createSwarmConfig", {
        key: RECALL_SIMILARITY_THRESHOLD_KEY,
        value: String(Math.min(1, score + 0.001)),
        category: RECALL_CONFIG_CATEGORY,
      });
      expect(await classify()).toEqual({ confidence: "fallback" });

      await mutate(s, "swarm/updateSwarmConfig", { id: threshold.id, value: String(Math.max(0, score - 0.001)) });
      expect(await classify()).toEqual({ confidence: "semantic" });
    } finally {
      await s.stop();
    }
  });
});
