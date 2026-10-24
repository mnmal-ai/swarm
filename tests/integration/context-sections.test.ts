/**
 * Stage 1 of the context-sections spec end to end, over HTTP against a spawned
 * Substrate sidecar running the swarm plugin (its own, on the memory store, so
 * its rows are the only ones; SWARM_SDK_E2E=1 only): sync stores a swarm file as
 * Document + Section rows in `swarm-docs`, and `loadContext` with `sections`
 * assembles the route's context from those rows and reports what it left out.
 * Then a changed file re-splits in place and a deleted one disappears.
 */

import {
  SWARM_DOCS_NAMESPACE,
  SubstrateClient,
  substrateDocsStore,
  type SynopsisWriter,
  syncDocuments,
} from "@mnmal-ai/swarm-substrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E_SKIP_REASON, startTestSubstrate, stopTestSubstrate } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

const PROJECT = "acme";
const para = (word: string, tokens = 150) => `${`${word} `.repeat(Math.ceil((tokens * 4) / (word.length + 1)))}`.trim();
const writer: SynopsisWriter = { write: async (req) => req.sections.map((s) => `about ${s.headingPath.join(" › ") || "the start"}`) };

let url: string;

beforeAll(async () => {
  if (!RUN_E2E) return;
  const substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "none" });
  url = substrate.cold.url;

  const client = new SubstrateClient(url);
  await client.mutate("createSwarmConfig", { key: "default_max_tokens", value: "1000", category: "budget" }, { id: true });
  await client.mutate(
    "createSwarmRoute",
    { intent: "implementation", description: "Write code.", keywords: "[]", contentPaths: JSON.stringify(["domains/acme/architecture.md"]), projectId: PROJECT },
    { id: true },
  );
  await client.mutate(
    "createSwarmContent",
    {
      path: "domains/acme/architecture.md",
      tier: "domain",
      intent: "",
      content: "WHOLE FILE",
      tokenEstimate: 900,
      lastReviewed: "2026-10-01",
      projectId: PROJECT,
    },
    { id: true },
  );
});

afterAll(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

describe.skipIf(!RUN_E2E)(`context sections over a real Substrate sidecar (${E2E_SKIP_REASON})`, () => {
  const store = () => substrateDocsStore(new SubstrateClient(url, { namespace: SWARM_DOCS_NAMESPACE }));
  const architecture = (deploy: string) => `# Architecture\n## Services\n${para("svc")}\n## Data model\n${para("data")}\n## Deploy\n${para(deploy)}`;

  it("stores a file as a Document and its Sections, with synopses", async () => {
    const report = await syncDocuments(store(), [{ path: "domains/acme/architecture.md", source: "swarm", content: architecture("deploy") }], {
      projectId: PROJECT,
      sources: ["swarm"],
      writer,
    });
    expect(report.errors).toEqual([]);
    const docs = await store().listDocuments(PROJECT);
    expect(docs).toEqual([expect.objectContaining({ path: "domains/acme/architecture.md", source: "swarm", title: "Architecture" })]);
    const sections = await store().listSections(PROJECT);
    expect(sections.map((s) => JSON.parse(s.headingPath))).toEqual([["Services"], ["Data model"], ["Deploy"]]);
    expect(sections.map((s) => s.synopsis)).toEqual(["about Services", "about Data model", "about Deploy"]);
    expect(sections.every((s) => s.document === docs[0].id)).toBe(true);
  });

  it("loads the route's file by section, and reports left-out sections by heading", async () => {
    const client = new SubstrateClient(url);
    const whole = await client.loadContext({ intent: "implementation", projectId: PROJECT, modelId: "m" });
    expect(whole.content).toContain("WHOLE FILE");

    const bySection = await client.loadContext({ intent: "implementation", projectId: PROJECT, modelId: "m", sections: true });
    expect(bySection.content).toContain("## Services");
    expect(bySection.content).toContain("## Deploy");
    expect(bySection.content).not.toContain("WHOLE FILE");

    await client.mutate("createSwarmConfig", { key: "model_override:small", value: "350", category: "budget" }, { id: true });
    const tight = await client.loadContext({ intent: "implementation", projectId: PROJECT, modelId: "small", sections: true });
    expect(tight.content).toContain("## Services");
    expect(tight.content).toContain("## Data model");
    expect(tight.content).not.toContain("## Deploy");
    expect(tight.omitted).toEqual([expect.objectContaining({ path: "domains/acme/architecture.md › Deploy", tier: "domain" })]);
  });

  it("re-splits a changed file in place and drops a deleted one", async () => {
    await syncDocuments(store(), [{ path: "domains/acme/architecture.md", source: "swarm", content: architecture("rollout") }], {
      projectId: PROJECT,
      sources: ["swarm"],
      writer,
    });
    expect(await store().listDocuments(PROJECT)).toHaveLength(1);
    expect(await store().listSections(PROJECT)).toHaveLength(3);

    await syncDocuments(store(), [], { projectId: PROJECT, sources: ["swarm"], writer });
    expect(await store().listDocuments(PROJECT)).toEqual([]);
    expect(await store().listSections(PROJECT)).toEqual([]);
  });

  // Stage 2 (context.pull): the index has to survive the client's field
  // selection, not just the resolver, or a real run never sees it.
  it("returns the document index through the client, from prepareTask and loadContext", async () => {
    const guide = `# Guide\n\n## Setup\n${para("setup")}\n\n## Usage\n${para("usage")}\n`;
    const report = await syncDocuments(store(), [{ path: "docs/guide.md", source: "project", content: guide }], {
      projectId: PROJECT,
      sources: ["project"],
      writer,
    });
    expect(report.errors).toEqual([]);

    const client = new SubstrateClient(url);
    const prepared = await client.prepareTask({
      prompt: "write code",
      projectId: PROJECT,
      modelId: "m",
      intentOverride: "implementation",
      sections: true,
      index: true,
    });
    const loaded = await client.loadContext({ intent: "implementation", projectId: PROJECT, modelId: "m", sections: true, index: true });

    const lines = guide.split("\n");
    for (const response of [prepared, loaded]) {
      const doc = response.documents?.find((d) => d.path === "docs/guide.md");
      expect(doc).toMatchObject({ source: "project", title: "Guide", tokens: expect.any(Number), contentHash: expect.any(String) });
      expect(doc?.sections.map((s) => s.headingPath)).toEqual([["Setup"], ["Usage"]]);
      expect(doc?.sections.map((s) => s.synopsis)).toEqual(["about Setup", "about Usage"]);
      expect(doc?.sections.every((s) => s.loaded === false && s.tokens > 0 && s.ordinal >= 0)).toBe(true);
      expect(doc?.sections.map((s) => lines[s.startLine - 1])).toEqual(["# Guide", "## Usage"]);
      expect(doc?.sections.at(-1)?.endLine).toBe(lines.length);
    }
  });
});
