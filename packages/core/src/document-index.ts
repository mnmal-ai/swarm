/**
 * The index of stored documents a session starts with (stage 2 of
 * docs/superpowers/specs/2026-10-01-context-sections-design.md).
 *
 * One line per section the session can read by line range, under its
 * document, in a quarter of the context budget. Documents the task names
 * expand first, in the order it names them; then, with ranking on, documents
 * by their best-ranked section (stage 3); then swarm files (the route chose
 * them); every other document folds to one line. When even the folded lines
 * don't fit, the last line counts the documents left off.
 *
 * Each line is an entry rendered by `@mnmal-ai/context-render`, the renderer
 * synoptic shares (stage 4), so the two cannot drift. Swarm keeps the blocks
 * around them: a heading per expanded document, its section lines, then the
 * folded lines. Pure: no I/O.
 */

import { basename, join } from "node:path";
import { renderIndexLine } from "@mnmal-ai/context-render";
import type { IndexedDocument, IndexedSection } from "@mnmal-ai/swarm-substrate";

export interface DocumentIndexInput {
  documents: IndexedDocument[];
  /** The context budget; the index gets a quarter of it. */
  budgetTokens: number;
  /** The task as the session sees it: documents it names are expanded first. */
  taskText: string;
  /** Absolute folder each source's paths are relative to. */
  roots: { swarm: string; project: string };
  maxReadTokens: number;
}

export interface DocumentIndex {
  /** The block appended to the swarm context; "" when there are no documents. */
  text: string;
  tokens: number;
  documents: number;
  expanded: number;
  folded: number;
  /** Documents left off entirely because even folded lines didn't fit. */
  dropped: number;
}

/** How a document's path is shown and read: absolute for swarm files, relative to the checkout for project files. */
export function displayPath(doc: Pick<IndexedDocument, "path" | "source">, roots: DocumentIndexInput["roots"]): string {
  return doc.source === "swarm" ? join(roots.swarm, doc.path) : doc.path;
}

/** Swarm's token estimate: four characters a token, rounded up. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const fmt = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * One index line: an entry whose synopsis is the line's text, with swarm's token count carried along.
 * `renderIndexLine` prints the synopsis; the label is set to the same text so the entry stays
 * complete. The golden test (tests/document-index-golden.test.ts) fails if the package changes that.
 */
const indexLine = (id: string, text: string, tokens: number): string => renderIndexLine({ id, label: text, synopsis: text, tokens });
const titled = (text: string, title: string): string => (title !== "" ? `${text} — ${title}` : text);

function sectionLine(shown: string, s: IndexedSection): string {
  const heading = s.headingPath.length > 0 ? s.headingPath.join(" › ") : "(start)";
  return indexLine(`${shown}#${s.ordinal}`, titled(`L${s.startLine}–${s.endLine} ${heading} (${fmt(s.tokens)} tok)`, s.synopsis), s.tokens);
}

interface Entry {
  doc: IndexedDocument;
  shown: string;
}

function expandedBlock({ doc, shown }: Entry): string {
  const head = titled(`### ${shown} (${fmt(doc.tokens)} tok)`, doc.title);
  return [head, ...doc.sections.filter((s) => !s.loaded).map((s) => sectionLine(shown, s))].join("\n");
}

function foldedLine({ doc, shown }: Entry): string {
  return indexLine(shown, titled(`${shown} (${fmt(doc.tokens)} tok, ${plural(doc.sections.length, "section", "sections")})`, doc.title), doc.tokens);
}

function dropLine(entries: Entry[]): string {
  const tokens = entries.reduce((n, e) => n + e.doc.tokens, 0);
  return indexLine("…", `… ${plural(entries.length, "more document", "more documents")} (${fmt(tokens)} tok)`, tokens);
}

function header(maxReadTokens: number): string {
  return [
    "## Documents",
    "",
    "These documents are stored by section. Read only the sections you need: `L41–120` means Read with offset 41 and limit 80. " +
      `A read that spans several sections and more than ${fmt(maxReadTokens)} tokens is refused, with the document's sections and their line ranges.`,
  ].join("\n");
}

/** A document's best section score, when ranking scored any of its sections. */
function bestScore(doc: IndexedDocument): number | undefined {
  let best: number | undefined;
  for (const s of doc.sections) if (typeof s.score === "number" && (best === undefined || s.score > best)) best = s.score;
  return best;
}

/** Where the task text first names a document, by its path or its file name, or -1. */
function firstMention(taskText: string, path: string): number {
  let first = -1;
  for (const needle of new Set([path, basename(path)])) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not part of a longer name: "api.md" is not named by "openapi.md".
    const m = new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`).exec(taskText);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  return first;
}

/** The index block for `documents`, within a quarter of the budget. */
export function renderDocumentIndex(input: DocumentIndexInput): DocumentIndex {
  const { documents, budgetTokens, taskText, roots, maxReadTokens } = input;
  if (documents.length === 0) return { text: "", tokens: 0, documents: 0, expanded: 0, folded: 0, dropped: 0 };

  const budget = Math.floor(budgetTokens / 4);
  const head = header(maxReadTokens);
  const entries: Entry[] = documents.map((doc) => ({ doc, shown: displayPath(doc, roots) }));
  const inPathOrder = [...entries].sort((a, b) => a.shown.localeCompare(b.shown));

  const render = (expanded: Entry[], folded: string[]): string =>
    [head, ...expanded.map(expandedBlock), ...(folded.length > 0 ? [folded.join("\n")] : [])].join("\n\n");
  const foldedExcept = (expanded: Entry[]): Entry[] => inPathOrder.filter((e) => !expanded.includes(e));

  // Expansion order: what the task names, as it names it; then, when ranking
  // scored sections (context.ranking), documents by their best-ranked section,
  // so the lowest-ranked fold first; then swarm files.
  const named = entries
    .map((e, i) => ({ e, i, at: firstMention(taskText, e.doc.path) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.e);
  const ranked = entries
    .map((e) => ({ e, best: bestScore(e.doc) }))
    .filter((x): x is { e: Entry; best: number } => x.best !== undefined && !named.includes(x.e))
    .sort((a, b) => b.best - a.best || a.e.shown.localeCompare(b.e.shown))
    .map((x) => x.e);
  const candidates = [...named, ...ranked, ...entries.filter((e) => e.doc.source === "swarm" && !named.includes(e) && !ranked.includes(e))];

  // A document expands only while the whole index, every other document
  // folded, still fits; otherwise it stays folded.
  const expanded: Entry[] = [];
  for (const candidate of candidates) {
    const trial = [...expanded, candidate];
    if (estimateTokens(render(trial, foldedExcept(trial).map(foldedLine))) <= budget) expanded.push(candidate);
  }

  const rest = foldedExcept(expanded);
  const whole = render(expanded, rest.map(foldedLine));
  if (estimateTokens(whole) <= budget) {
    return { text: whole, tokens: estimateTokens(whole), documents: documents.length, expanded: expanded.length, folded: rest.length, dropped: 0 };
  }

  // Even folded, not everything fits: keep folded lines in path order while
  // they fit alongside the count of those left off.
  const kept: string[] = [];
  for (const [i, entry] of rest.entries()) {
    const trial = render(expanded, [...kept, foldedLine(entry), ...(i + 1 < rest.length ? [dropLine(rest.slice(i + 1))] : [])]);
    if (estimateTokens(trial) > budget) break;
    kept.push(foldedLine(entry));
  }
  const dropped = rest.slice(kept.length);
  const text = render(expanded, [...kept, dropLine(dropped)]);
  return { text, tokens: estimateTokens(text), documents: documents.length, expanded: expanded.length, folded: kept.length, dropped: dropped.length };
}
