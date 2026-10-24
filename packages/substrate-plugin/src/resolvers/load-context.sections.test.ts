/**
 * Stage 1 of "Swarm context: sections, index and pull": when a caller asks for
 * sections and the plugin reads the `swarm-docs` namespace, the loader fills the
 * budget section by section instead of file by file. Required tiers still load
 * whole; an optional file can load in part; whatever is left out is reported
 * section by section. Files with no stored sections load whole, as before.
 */
import type { Dataset, ReadParams, RequestContext, ResolverArgs, Row } from "@mnmal-ai/substrate/sdk";
import { describe, expect, it } from "vitest";
import { enforceBudgetBySection, type SectionUnit } from "./assemble.js";
import { type DocsReader, loadContext, makeLoadContext } from "./load-context.js";
import { makePrepareTask } from "./prepare-task.js";

function dataset(rowsByType: Record<string, Row[]>, reads: Array<{ type: string; params: ReadParams }> = []): Dataset {
  return {
    read: async (type: string, params: ReadParams) => {
      reads.push({ type, params });
      return { rows: rowsByType[type] ?? [], hasMore: false };
    },
  } as unknown as Dataset;
}

/** A docs-namespace reader returning the rows registered for each type; it ignores the where-clause. */
function docsReader(rowsByType: Record<string, Row[]>, reads: Array<{ type: string; params: unknown }> = []): DocsReader {
  return {
    namespace: "swarm-docs",
    read: async (type, params) => {
      reads.push({ type, params });
      return rowsByType[type] ?? [];
    },
  };
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

const section = (path: string, ordinal: number, heading: string[], body: string, tokens: number, projectId = "acme", source = "swarm"): Row => ({
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

// core/rules.md has sections (required: all load); architecture.md has three
// sections of 100 tokens; glossary.md has none stored, so it loads whole.
const sections: Row[] = [
  section("core/rules.md", 0, [], "RULES A", 20),
  section("core/rules.md", 1, ["More"], "RULES B", 20),
  section("domain/acme/architecture.md", 2, ["Deploy"], "ARCH C", 100),
  section("domain/acme/architecture.md", 0, [], "ARCH A", 100),
  section("domain/acme/architecture.md", 1, ["Data model"], "ARCH B", 100),
  section("domain/other/architecture.md", 0, [], "OTHER PROJECT", 1, "other"),
];

/** The Document rows for the sectioned swarm files, at the hash their sections were written for. */
const documents: Row[] = ["core/rules.md", "domain/acme/architecture.md"].map((path) => ({
  id: `doc:${path}`,
  projectId: "acme",
  path,
  source: "swarm",
  title: path,
  contentHash: `hash:${path}`,
}));

const swarmRows = (budget: number) => ({
  SwarmConfig: [{ id: "b", key: "default_max_tokens", value: String(budget), category: "budget" }],
  SwarmRoute: [route],
  SwarmContent: content,
});

describe("enforceBudgetBySection", () => {
  const units = (path: string, list: Array<[string[], string, number]>): SectionUnit[] =>
    list.map(([headingPath, body, tokens], ordinal) => ({ path, ordinal, headingPath, body, tokens, synopsis: "", contentHash: "" }));

  it("loads required files whole, then fills optional files section by section in order", () => {
    const entities = [
      { path: "core/a.md", tier: "core", intent: "", content: "A", tokenEstimate: 30, lastReviewed: "", projectId: "p" },
      { path: "domain/b.md", tier: "domain", intent: "", content: "B", tokenEstimate: 300, lastReviewed: "", projectId: "p" },
    ];
    const byPath = new Map([
      ["core/a.md", units("core/a.md", [[[], "A0", 20], [["X"], "A1", 20]])],
      ["domain/b.md", units("domain/b.md", [[[], "B0", 100], [["Y"], "B1", 100], [["Z"], "B2", 100]])],
    ]);
    const result = enforceBudgetBySection(entities, 200, [{ tier: "core", required: true }, { tier: "domain", required: false }], byPath);
    expect(result.files.map((f) => [f.path, f.content, f.estimatedTokens])).toEqual([
      ["core/a.md", "A0\nA1", 40],
      ["domain/b.md", "B0", 100],
    ]);
    expect(result.totalTokens).toBe(140);
    expect(result.truncated).toEqual([]);
    expect(result.omitted).toEqual([
      { path: "domain/b.md › Y", tier: "domain", estimatedTokens: 100 },
      { path: "domain/b.md › Z", tier: "domain", estimatedTokens: 100 },
    ]);
  });

  it("names section 0 '(start)', and reports a file none of whose sections fit as truncated", () => {
    const entities = [{ path: "domain/b.md", tier: "domain", intent: "", content: "B", tokenEstimate: 300, lastReviewed: "", projectId: "p" }];
    const byPath = new Map([["domain/b.md", units("domain/b.md", [[[], "B0", 100], [["Y"], "B1", 100]])]]);
    const result = enforceBudgetBySection(entities, 50, [{ tier: "domain", required: false }], byPath);
    expect(result.files).toEqual([]);
    expect(result.truncated).toEqual(["domain/b.md"]);
    expect(result.omitted.map((o) => o.path)).toEqual(["domain/b.md › (start)", "domain/b.md › Y"]);
  });

  it("keeps filling past a section that doesn't fit, so a later small one still loads", () => {
    const entities = [{ path: "domain/b.md", tier: "domain", intent: "", content: "B", tokenEstimate: 300, lastReviewed: "", projectId: "p" }];
    const byPath = new Map([["domain/b.md", units("domain/b.md", [[[], "B0", 150], [["Y"], "B1", 30]])]]);
    const result = enforceBudgetBySection(entities, 100, [{ tier: "domain", required: false }], byPath);
    expect(result.files.map((f) => f.content)).toEqual(["B1"]);
    expect(result.omitted.map((o) => o.path)).toEqual(["domain/b.md › (start)"]);
  });
});

describe("loadContext with sections", () => {
  it("leaves loading unchanged when the caller doesn't ask for sections", async () => {
    const docs = docsReader({ Document: documents, Section: sections });
    const load = makeLoadContext(undefined, async () => docs);
    const result = await load(ctx, args(dataset(swarmRows(1000)), { intent: "implementation", projectId: "acme", modelId: "m" }));
    expect(result.content).toContain("ARCH WHOLE");
    expect(result.content).not.toContain("ARCH A");
  });

  it("assembles from sections when asked, reading only this project's sections, in ordinal order", async () => {
    const reads: Array<{ type: string; params: unknown }> = [];
    const docs = docsReader({ Document: documents, Section: sections }, reads);
    const load = makeLoadContext(undefined, async () => docs);
    const result = await load(ctx, args(dataset(swarmRows(1000)), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }));
    expect(result.content).toBe(
      [
        "--- swarm: core/rules.md (core) ---\nRULES A\nRULES B",
        "--- swarm: domain/acme/architecture.md (domain) ---\nARCH A\nARCH B\nARCH C",
        "--- swarm: domain/acme/glossary.md (domain) ---\nGLOSSARY WHOLE",
      ].join("\n\n"),
    );
    expect(result.tokensUsed).toBe(40 + 300 + 50);
    expect(reads).toEqual([
      { type: "Document", params: expect.objectContaining({ where: { projectId: { eq: "acme" }, source: { eq: "swarm" } } }) },
      { type: "Section", params: expect.objectContaining({ where: { projectId: { eq: "acme" }, source: { eq: "swarm" } } }) },
    ]);
  });

  it("loads part of an optional file and reports the rest section by section", async () => {
    const load = makeLoadContext(undefined, async () => docsReader({ Document: documents, Section: sections }));
    const result = await load(ctx, args(dataset(swarmRows(250)), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }));
    expect(result.content).toContain("ARCH A\nARCH B");
    expect(result.content).not.toContain("ARCH C");
    expect(result.filesIncluded).toContainEqual({ path: "domain/acme/architecture.md", tier: "domain", tokens: 200 });
    expect(result.omitted).toEqual([
      { path: "domain/acme/architecture.md › Deploy", tier: "domain", tokens: 100 },
      { path: "domain/acme/glossary.md", tier: "domain", tokens: 50 },
    ]);
    expect(result.truncated).toEqual(["domain/acme/glossary.md"]);
  });

  it("loads a file whole when its sections aren't a complete set for its current version", async () => {
    const run = async (secs: Row[], docs: Row[] = documents) => {
      const load = makeLoadContext(undefined, async () => docsReader({ Document: docs, Section: secs }));
      return (await load(ctx, args(dataset(swarmRows(1000)), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }))).content;
    };
    // A sync that moved on: the Document has a newer hash than the sections.
    expect(await run(sections, documents.map((d) => ({ ...d, contentHash: `${d.contentHash}-v2` })))).toContain("ARCH WHOLE");
    // A gap in the ordinals: a write that stopped part way.
    expect(await run(sections.filter((r) => r.id !== "domain/acme/architecture.md#1"))).toContain("ARCH WHOLE");
    // A pending Document (empty hash) never matches.
    expect(await run(sections, documents.map((d) => ({ ...d, contentHash: "" })))).toContain("ARCH WHOLE");
    // Sections with no Document, and no recorded hash, never load.
    expect(await run(sections.map(({ documentHash: _h, ...r }) => r as Row), [])).toContain("ARCH WHOLE");
  });

  it("uses only swarm files' sections, never a project document's at the same path", async () => {
    const shadow = section("domain/acme/glossary.md", 0, [], "PROJECT DOC TEXT", 10, "acme", "project");
    const load = makeLoadContext(undefined, async () =>
      docsReader({ Document: [...documents, { id: "doc:domain/acme/glossary.md", projectId: "acme", path: "domain/acme/glossary.md", source: "project", title: "g", contentHash: "hash:domain/acme/glossary.md" }], Section: [...sections, shadow] }),
    );
    const result = await load(ctx, args(dataset(swarmRows(1000)), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }));
    expect(result.content).toContain("GLOSSARY WHOLE");
    expect(result.content).not.toContain("PROJECT DOC TEXT");
  });

  it("falls back to whole files when the plugin has no swarm-docs reader", async () => {
    const result = await loadContext(ctx, args(dataset(swarmRows(1000)), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }));
    expect(result.content).toContain("ARCH WHOLE");
  });

  it("is forwarded by prepareTask", async () => {
    const prepare = makePrepareTask(undefined, async () => docsReader({ Document: documents, Section: sections }));
    const result = await prepare(
      ctx,
      args(dataset({ ...swarmRows(1000) }), { prompt: "do it", projectId: "acme", modelId: "m", intentOverride: "implementation", sections: true }),
    );
    expect(result.content).toContain("ARCH A");
  });
});
