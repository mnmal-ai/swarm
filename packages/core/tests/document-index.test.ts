/**
 * The document index (stage 2 of the context-sections spec): one line per
 * section a session can read by line range, in a quarter of the context
 * budget. Documents the task names expand first, then swarm files; the rest
 * fold to one line each, and what doesn't fit even folded is counted.
 */
import { describe, expect, it } from "vitest";
import type { IndexedDocument } from "@mnmal-ai/swarm-substrate";
import { displayPath, renderDocumentIndex } from "../src/document-index.js";

const roots = { swarm: "/home/dev/.swarm", project: "/work/acme" };

const doc = (
  path: string,
  title: string,
  tokens: number,
  sections: Array<[string[], number, string, boolean?]>,
  source: "swarm" | "project" = "project",
): IndexedDocument => {
  let line = 1;
  return {
    path,
    source,
    title,
    tokens,
    contentHash: `hash:${path}`,
    sections: sections.map(([headingPath, sectionTokens, synopsis, loaded], ordinal) => {
      const startLine = line;
      line += 10;
      return { ordinal, headingPath, synopsis, tokens: sectionTokens, startLine, endLine: line - 1, loaded: loaded ?? false };
    }),
  };
};

const api: IndexedDocument = {
  path: "docs/api.md",
  source: "project",
  title: "API reference",
  tokens: 12400,
  contentHash: "hash:docs/api.md",
  sections: [
    { ordinal: 0, headingPath: [], synopsis: "What the API is for.", tokens: 300, startLine: 1, endLine: 40, loaded: false },
    { ordinal: 1, headingPath: ["Errors", "Retries"], synopsis: "How clients retry.", tokens: 900, startLine: 41, endLine: 120, loaded: false },
  ],
};
const guide = doc(
  "docs/guide.md",
  "Contributor guide",
  31200,
  Array.from({ length: 42 }, (_, i) => [[`Part ${i + 1}`], 740, `What part ${i + 1} covers.`] as [string[], number, string]),
);
const old = doc("docs/old.md", "Old notes", 2100, [
  [[], 700, "Notes."],
  [["A"], 700, "More notes."],
  [["B"], 700, "Last notes."],
]);
const arch = doc(
  "domain/acme/architecture.md",
  "Architecture",
  300,
  [
    [[], 100, "The system's parts.", true],
    [["Data model"], 100, "Tables and keys.", false],
    [["Deploy"], 100, "How it ships.", true],
  ],
  "swarm",
);

const render = (documents: IndexedDocument[], taskText: string, budgetTokens = 100_000, maxReadTokens = 4000) =>
  renderDocumentIndex({ documents, budgetTokens, taskText, roots, maxReadTokens });

const expandedPaths = (text: string) => [...text.matchAll(/^### (\S+)/gm)].map((m) => m[1]);

describe("renderDocumentIndex", () => {
  it("lays out the header, an expanded document and folded ones exactly", () => {
    const index = render([api, guide, old], "Fix the retry bug described in docs/api.md");
    expect(index.text).toBe(
      [
        "## Documents",
        "",
        "These documents are stored by section. Read only the sections you need: `L41–120` means Read with offset 41 and limit 80. A read that spans several sections and more than 4,000 tokens is refused, with the document's sections and their line ranges.",
        "",
        "### docs/api.md (12,400 tok) — API reference",
        "- L1–40 (start) (300 tok) — What the API is for.",
        "- L41–120 Errors › Retries (900 tok) — How clients retry.",
        "",
        "- docs/guide.md (31,200 tok, 42 sections) — Contributor guide",
        "- docs/old.md (2,100 tok, 3 sections) — Old notes",
      ].join("\n"),
    );
    expect(index).toMatchObject({ documents: 3, expanded: 1, folded: 2, dropped: 0 });
    expect(index.tokens).toBe(Math.ceil(index.text.length / 4));
  });

  it("names the read limit it was given", () => {
    expect(render([api], "", 100_000, 12000).text).toContain("more than 12,000 tokens is refused");
  });

  it("lists only the sections that aren't already loaded", () => {
    const index = render([arch], "");
    expect(index.text).toContain("### /home/dev/.swarm/domain/acme/architecture.md (300 tok) — Architecture\n- L11–20 Data model (100 tok) — Tables and keys.");
    expect(index.text).not.toContain("The system's parts.");
    expect(index.text).not.toContain("How it ships.");
  });

  it("expands the documents the task names first, in the order the task names them", () => {
    const index = render([api, guide, old], "Read guide.md, then update docs/api.md to match.");
    expect(expandedPaths(index.text)).toEqual(["docs/guide.md", "docs/api.md"]);
    expect(index.text).toContain("\n\n- docs/old.md (2,100 tok, 3 sections) — Old notes");
  });

  it("doesn't take a file name inside a longer one as naming the document", () => {
    const index = render([api], "Update docs/openapi.md");
    expect(index.expanded).toBe(0);
  });

  it("expands swarm documents after the named ones, and nothing else", () => {
    const index = render([arch, api, guide, old], "Fix docs/api.md");
    expect(expandedPaths(index.text)).toEqual(["docs/api.md", "/home/dev/.swarm/domain/acme/architecture.md"]);
    expect(index).toMatchObject({ expanded: 2, folded: 2 });
  });

  it("folds a document whose block would overflow the index budget, and still expands one that fits", () => {
    // A quarter of 1,200 is 300 tokens: room for api.md's block, not guide.md's.
    const index = render([api, guide, old], "Compare guide.md with docs/api.md", 1200);
    expect(expandedPaths(index.text)).toEqual(["docs/api.md"]);
    expect(index.text).toContain("- docs/guide.md (31,200 tok, 42 sections) — Contributor guide");
    expect(index).toMatchObject({ expanded: 1, folded: 2, dropped: 0 });
    expect(index.tokens).toBeLessThanOrEqual(300);
  });

  it("ends with a count of the documents that didn't fit even folded", () => {
    const many = Array.from({ length: 60 }, (_, i) => doc(`docs/notes-${String(i).padStart(2, "0")}.md`, `Notes ${i}`, 1000 + i, [[[], 1000 + i, "x"]]));
    const index = render(many, "", 800);
    expect(index.tokens).toBeLessThanOrEqual(200);
    expect(index.folded).toBeGreaterThan(0);
    expect(index.folded + index.dropped).toBe(60);
    const droppedTokens = many.slice(index.folded).reduce((n, d) => n + d.tokens, 0);
    expect(index.text.endsWith(`\n- … ${index.dropped} more documents (${droppedTokens.toLocaleString("en-US")} tok)`)).toBe(true);
    // Folded lines are kept in path order.
    expect(index.text).toContain("- docs/notes-00.md (1,000 tok, 1 section) — Notes 0");
  });

  it("renders nothing for no documents", () => {
    expect(render([], "anything")).toEqual({ text: "", tokens: 0, documents: 0, expanded: 0, folded: 0, dropped: 0 });
  });
});

describe("displayPath", () => {
  it("shows swarm files under the swarm folder, and project documents relative to the checkout", () => {
    expect(displayPath({ path: "domain/acme/architecture.md", source: "swarm" }, roots)).toBe("/home/dev/.swarm/domain/acme/architecture.md");
    expect(displayPath({ path: "docs/api.md", source: "project" }, roots)).toBe("docs/api.md");
  });
});

describe("renderDocumentIndex with ranked sections (context.ranking)", () => {
  const scored = (d: IndexedDocument, scores: Record<number, number>): IndexedDocument => ({
    ...d,
    sections: d.sections.map((s) => (scores[s.ordinal] === undefined ? s : { ...s, score: scores[s.ordinal] })),
  });

  it("expands documents by their best-ranked section after the named ones, then swarm files", () => {
    const index = render([arch, scored(api, { 1: 0.62 }), guide, scored(old, { 2: 0.81 })], "Tidy up the notes");
    expect(expandedPaths(index.text)).toEqual(["docs/old.md", "docs/api.md", "/home/dev/.swarm/domain/acme/architecture.md"]);
    expect(index.text).toContain("- docs/guide.md (31,200 tok, 42 sections) — Contributor guide");
  });

  it("still puts a document the task names first", () => {
    const index = render([scored(api, { 1: 0.62 }), scored(old, { 2: 0.81 })], "Fix docs/api.md");
    expect(expandedPaths(index.text)).toEqual(["docs/api.md", "docs/old.md"]);
  });

  it("folds the lowest-ranked first when the quarter runs out", () => {
    // A quarter of 500 is 125 tokens: room for one expanded block, not two.
    const index = render([scored(api, { 1: 0.3 }), scored(old, { 0: 0.9 })], "Anything", 500);
    expect(expandedPaths(index.text)).toEqual(["docs/old.md"]);
    expect(index.text).toContain("- docs/api.md (12,400 tok, 2 sections) — API reference");
    // The other way round, the other document expands: rank decides, not path order.
    const swapped = render([scored(api, { 1: 0.9 }), scored(old, { 0: 0.3 })], "Anything", 500);
    expect(expandedPaths(swapped.text)).toEqual(["docs/api.md"]);
  });
});
