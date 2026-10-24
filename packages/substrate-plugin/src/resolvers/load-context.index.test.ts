/**
 * Stage 2 of "Swarm context: sections, index and pull": when a caller asks for
 * an index as well as sections, the loader also returns the documents a
 * session can read by line range. Every complete project document is listed
 * with all its sections unloaded; a swarm file is listed only when the budget
 * cut some of its sections, with the ones that loaded marked. Without the
 * request, the response is as it was.
 */
import type { Dataset, ReadParams, RequestContext, ResolverArgs, Row } from "@mnmal-ai/substrate/sdk";
import { describe, expect, it } from "vitest";
import { type DocsReader, makeLoadContext } from "./load-context.js";
import { makePrepareTask } from "./prepare-task.js";

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

const load = (params: Record<string, unknown>, budget = 15000) =>
  makeLoadContext(undefined, async () => docs)(ctx, args(swarm(budget), { intent: "implementation", projectId: "acme", modelId: "m", ...params }));

describe("loadContext with an index", () => {
  it("returns no documents unless asked for an index", async () => {
    const res = await makeLoadContext(undefined, async () => docs)(ctx, args(swarm(15000), { intent: "implementation", projectId: "acme", modelId: "m", sections: true }));
    expect(res.documents).toBeUndefined();
    expect("documents" in res).toBe(false);
  });

  it("returns no documents for an index without sections", async () => {
    const res = await load({ index: true });
    expect("documents" in res).toBe(false);
  });

  it("lists every complete project document, with exact line ranges, all not loaded", async () => {
    const res = await load({ sections: true, index: true });
    const api = res.documents!.find((d) => d.path === "docs/api.md")!;
    expect(api.source).toBe("project");
    expect(api.title).toBe("Title of docs/api.md");
    expect(api.tokens).toBe(10);
    expect(api.sections.map((s) => [s.startLine, s.endLine])).toEqual([
      [1, 3],
      [4, 9],
    ]);
    expect(api.sections.map((s) => s.headingPath)).toEqual([[], ["Errors"]]);
    expect(api.sections.map((s) => s.synopsis)).toEqual(["about the start", "about Errors"]);
    expect(api.sections.every((s) => !s.loaded)).toBe(true);
    expect(api.contentHash).toBe("hash:docs/api.md");
  });

  it("leaves out a project document whose sections are stale or incomplete", async () => {
    const res = await load({ sections: true, index: true });
    expect(res.documents!.map((d) => d.path)).not.toContain("docs/half-synced.md");
  });

  it("lists a swarm file the budget cut, marking which sections loaded", async () => {
    const res = await load({ sections: true, index: true }, /* budget */ 250);
    const arch = res.documents!.find((d) => d.path === "domain/acme/architecture.md")!;
    expect(arch.source).toBe("swarm");
    expect(arch.sections.map((s) => s.loaded)).toEqual([true, true, false]);
    // Swarm files first, then project documents, each by path.
    expect(res.documents!.map((d) => d.path)).toEqual(["domain/acme/architecture.md", "docs/api.md"]);
  });

  it("doesn't list swarm files that loaded whole", async () => {
    const res = await load({ sections: true, index: true });
    expect(res.documents!.map((d) => d.source)).toEqual(["project"]);
  });

  it("never lists another project's documents", async () => {
    const res = await load({ sections: true, index: true });
    expect(res.documents!.every((d) => !d.path.startsWith("docs/other-"))).toBe(true);
  });

  it("leaves the pushed context as it is without an index", async () => {
    const withIndex = await load({ sections: true, index: true }, 250);
    const without = await load({ sections: true }, 250);
    const { documents: _documents, ...rest } = withIndex;
    expect(rest).toEqual(without);
  });

  it("passes index through prepareTask", async () => {
    const res = await makePrepareTask(undefined, async () => docs)(
      ctx,
      args(swarm(15000), { prompt: "write code", projectId: "acme", modelId: "m", intentOverride: "implementation", sections: true, index: true }),
    );
    expect(res.documents?.length).toBeGreaterThan(0);
  });

  it("returns no documents from prepareTask unless asked", async () => {
    const res = await makePrepareTask(undefined, async () => docs)(
      ctx,
      args(swarm(15000), { prompt: "write code", projectId: "acme", modelId: "m", intentOverride: "implementation", sections: true }),
    );
    expect("documents" in res).toBe(false);
  });
});
