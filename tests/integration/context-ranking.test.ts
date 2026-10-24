/**
 * Stage 3 of the context-sections spec end to end, over HTTP against a spawned
 * Substrate sidecar running the swarm plugin with recall wired to local Ollama
 * (`nomic-embed-text`): documents sync as sections, each Section is embedded as
 * it is written, and prepareTask and loadContext with `rank` add the
 * best-ranked sections and report what ranking did. The fields travel through
 * the real client, so a field the client doesn't ask for fails here (as
 * `documents` once did).
 *
 * The suite spawns its own sidecar so the project's sections are the only ones
 * in the store. It runs only under SWARM_SDK_E2E=1, and without Ollama it
 * skips: recall suites need Ollama.
 */

import {
  SWARM_DOCS_NAMESPACE,
  SubstrateClient,
  substrateDocsStore,
  type SynopsisWriter,
  syncDocuments,
} from "@mnmal-ai/swarm-substrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E_SKIP_REASON, probeOllama, RECALL_SKIP_REASON, startTestSubstrate, stopTestSubstrate } from "../setup/isolated-substrate.js";

const PROJECT = "acme";
const para = (topic: string, tokens = 150) => `${`${topic} `.repeat(Math.ceil((tokens * 4) / (topic.length + 1)))}`.trim();
const writer: SynopsisWriter = { write: async (req) => req.sections.map((s) => `about ${s.headingPath.join(" › ") || "the start"}`) };

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
// Probed only in an E2E run: a plain run touches nothing outside node_modules.
const HAVE_OLLAMA = RUN_E2E && process.env.SWARM_TEST_RECALL !== "none" && (await probeOllama());

let url: string;

beforeAll(async () => {
  if (!HAVE_OLLAMA) return;
  const substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "auto" });
  url = substrate.cold.url;
  const client = new SubstrateClient(url);
  await client.mutate("createSwarmConfig", { key: "default_max_tokens", value: "4000", category: "budget" }, { id: true });
  await client.mutate(
    "createSwarmRoute",
    { intent: "implementation", description: "Write code.", keywords: "[]", contentPaths: "[]", projectId: PROJECT },
    { id: true },
  );
});

afterAll(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

describe.skipIf(!HAVE_OLLAMA)(`context ranking over a real Substrate sidecar (${E2E_SKIP_REASON}; ${RECALL_SKIP_REASON})`, () => {
  it("adds the section most like the task, and reports ranking, through the client", async () => {
    const client = new SubstrateClient(url);
    const ask = { prompt: "fix the canary rollout for deploys", projectId: PROJECT, modelId: "m", intentOverride: "implementation", sections: true, index: true, rank: true };

    // Before any section (so any vector) exists, ranking says so and changes nothing.
    const before = await client.prepareTask(ask);
    expect(before.ranking).toMatchObject({ status: "no-embeddings", loaded: 0 });
    expect(before.filesIncluded.some((f) => f.tier === "ranked")).toBe(false);

    // Each Section is embedded as sync writes it.
    const guide = `# Guide\n\n## Billing\n${para("invoices refunds billing")}\n\n## Deploys\n${para("rollout canary deploys")}\n\n## Logging\n${para("logs tracing logging")}\n`;
    const report = await syncDocuments(substrateDocsStore(new SubstrateClient(url, { namespace: SWARM_DOCS_NAMESPACE })), [{ path: "docs/guide.md", source: "project", content: guide }], {
      projectId: PROJECT,
      sources: ["project"],
      writer,
    });
    expect(report.errors).toEqual([]);

    const prepared = await client.prepareTask(ask);
    const loaded = await client.loadContext({ intent: "implementation", projectId: PROJECT, modelId: "m", prompt: ask.prompt, sections: true, index: true, rank: true });
    for (const response of [prepared, loaded]) {
      // No `model`: the Substrate plugin's recall does not know which embedder
      // the sidecar runs (the previous engine's in-process deps reported it).
      expect(response.ranking).toMatchObject({ status: "ranked", candidates: 3 });
      expect(response.ranking!.loaded).toBeGreaterThanOrEqual(1);
      // The deploys section ranks first, so it is the first one added.
      expect(response.filesIncluded.find((f) => f.tier === "ranked")?.path).toBe("docs/guide.md › Deploys");
      expect(response.content).toContain("--- swarm: docs/guide.md › Deploys (ranked) ---\n## Deploys");
      const doc = response.documents!.find((d) => d.path === "docs/guide.md")!;
      const deploys = doc.sections.find((s) => s.headingPath[0] === "Deploys")!;
      expect(deploys.loaded).toBe(true);
      expect(deploys.score).toBeGreaterThan(Math.max(...doc.sections.filter((s) => s !== deploys).map((s) => s.score ?? 0)));
    }
  });
});
