/**
 * Splitting a markdown document into sections: the unit swarm stores, loads
 * and (later) indexes instead of whole files.
 *
 * Rules (spec: docs/superpowers/specs/2026-10-01-context-sections-design.md):
 *   - Split at level-2 headings. Text before the first one is section 0.
 *   - A level-2 section over {@link SPLIT_LEVEL3_OVER} tokens is split again at
 *     its level-3 headings.
 *   - Headings inside a code fence are text, never split points.
 *   - A section under {@link MIN_SECTION_TOKENS} tokens joins the next one, or
 *     the previous one when it is last.
 *
 * Pure: no I/O, no model calls. Bodies keep their heading line and their
 * original text, so joining them back with "\n" gives the document again
 * exactly (blank lines before the first heading go into the first section),
 * and each section's line range follows from the bodies alone.
 */

import { createHash } from "node:crypto";

/** Level-2 sections longer than this are split at their level-3 headings. */
export const SPLIT_LEVEL3_OVER = 2000;
/** Sections shorter than this join a neighbour. */
export const MIN_SECTION_TOKENS = 100;
/** Longest synopsis the first-sentence fallback writes. */
export const MAX_FALLBACK_SYNOPSIS = 160;

export interface SplitSection {
  /** Heading texts from level 2 down; empty for section 0. */
  headingPath: string[];
  /** 0 for section 0, else 2 or 3. */
  level: number;
  /** Position in the document, from 0. */
  ordinal: number;
  /** The section's markdown, its heading line included. */
  body: string;
  /** Estimated tokens, as swarm estimates them elsewhere. */
  tokens: number;
  /** sha256 of `body`, hex. */
  contentHash: string;
}

/** Swarm's token estimate: four characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

interface Part {
  headingPath: string[];
  level: number;
  lines: string[];
}

/** Split `lines` at headings of `level`, skipping fenced code. Part 0 holds the lines before the first. */
function splitAt(lines: string[], level: number, parentPath: string[], leadLevel: number): Part[] {
  const parts: Part[] = [{ headingPath: parentPath, level: leadLevel, lines: [] }];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null) {
      const h = HEADING.exec(line);
      if (h && h[1].length === level) {
        parts.push({ headingPath: [...parentPath, h[2]], level, lines: [line] });
        continue;
      }
    }
    parts[parts.length - 1].lines.push(line);
  }
  return parts;
}

interface Draft {
  headingPath: string[];
  level: number;
  body: string;
}

function toDraft(part: Part): Draft {
  return { headingPath: part.headingPath, level: part.level, body: part.lines.join("\n") };
}

/** Join `b` onto `a`. The result keeps the first heading path that names something. */
function merge(a: Draft, b: Draft): Draft {
  const named = a.headingPath.length > 0 ? a : b;
  return { headingPath: named.headingPath, level: named.level, body: `${a.body}\n${b.body}` };
}

/** The document's sections, in order. */
export function splitSections(markdown: string): SplitSection[] {
  const text = markdown.replace(/\r\n?/g, "\n");
  if (text.trim() === "") return [];

  const drafts: Draft[] = [];
  // Only part 0 can be blank-only (every other part starts with its heading).
  // Its lines are carried into the next part rather than dropped, so line
  // numbers stay exact.
  let pending: string[] = [];
  for (const part of splitAt(text.split("\n"), 2, [], 0)) {
    if (part.lines.join("").trim() === "") {
      pending = [...pending, ...part.lines];
      continue;
    }
    const withLead: Part = pending.length > 0 ? { ...part, lines: [...pending, ...part.lines] } : part;
    pending = [];
    const draft = toDraft(withLead);
    if (withLead.level === 2 && estimateTokens(draft.body) > SPLIT_LEVEL3_OVER) {
      const subparts = splitAt(withLead.lines, 3, withLead.headingPath, 2);
      for (const sub of subparts) if (sub.lines.join("").trim() !== "") drafts.push(toDraft(sub));
    } else {
      drafts.push(draft);
    }
  }

  const merged: Draft[] = [];
  let carry: Draft | null = null;
  drafts.forEach((draft, i) => {
    const current = carry ? merge(carry, draft) : draft;
    carry = null;
    const last = i === drafts.length - 1;
    if (estimateTokens(current.body) < MIN_SECTION_TOKENS && !last) {
      carry = current;
      return;
    }
    if (estimateTokens(current.body) < MIN_SECTION_TOKENS && last && merged.length > 0) {
      const prev = merged[merged.length - 1];
      merged[merged.length - 1] = { ...prev, body: `${prev.body}\n${current.body}` };
      return;
    }
    merged.push(current);
  });

  return merged.map((d, ordinal) => ({
    headingPath: d.headingPath,
    level: d.level,
    ordinal,
    body: d.body,
    tokens: estimateTokens(d.body),
    contentHash: hash(d.body),
  }));
}

/**
 * Each section's 1-based, inclusive line range in the document its bodies
 * were split from: section k starts on the line after section k−1 ends.
 */
export function sectionLineRanges(bodies: readonly string[]): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let next = 1;
  for (const body of bodies) {
    const count = body.split("\n").length;
    ranges.push({ startLine: next, endLine: next + count - 1 });
    next += count;
  }
  return ranges;
}

const SYNOPSIS_COMMENT = /^<!--\s*synopsis:\s*(.*?)\s*-->$/i;

/** The lines after a leading heading line (or all lines when there is none). */
function underHeading(body: string): { heading: string | null; rest: string[] } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return { heading: null, rest: [] };
  const h = HEADING.exec(lines[first]);
  return h ? { heading: h[2], rest: lines.slice(first + 1) } : { heading: null, rest: lines.slice(first) };
}

/** A writer's own synopsis: `<!-- synopsis: … -->` on the first non-blank line under the heading. */
export function synopsisOverride(body: string): string | null {
  const { rest } = underHeading(body);
  const line = rest.find((l) => l.trim() !== "");
  if (line === undefined) return null;
  const m = SYNOPSIS_COMMENT.exec(line.trim());
  return m && m[1] !== "" ? m[1] : null;
}

/** Shorten a synopsis to {@link MAX_FALLBACK_SYNOPSIS} characters at a word boundary. */
export function capSynopsis(text: string): string {
  if (text.length <= MAX_FALLBACK_SYNOPSIS) return text;
  const cut = text.slice(0, MAX_FALLBACK_SYNOPSIS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The synopsis used when no model wrote one: the first sentence of the first
 * paragraph of prose under the heading, at most 160 characters; the heading
 * text when there is no prose.
 */
export function fallbackSynopsis(body: string): string {
  const { heading, rest } = underHeading(body);
  let fence: string | null = null;
  const paragraph: string[] = [];
  for (const raw of rest) {
    const f = FENCE.exec(raw);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (fence === f[1][0]) fence = null;
      if (paragraph.length > 0) break;
      continue;
    }
    if (fence !== null) continue;
    const line = raw.trim();
    const skip = line === "" || line.startsWith("<!--") || /^\|?\s*:?-{3,}/.test(line) || HEADING.test(line);
    if (skip) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.replace(/^(?:[-*+]|\d+[.)]|>)\s+/, "").replace(/^\||\|$/g, "").trim());
  }
  const prose = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (prose === "") return heading ? capSynopsis(heading) : "";
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(prose);
  return capSynopsis(sentence ? sentence[1] : prose);
}
