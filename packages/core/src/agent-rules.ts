/**
 * Agent rules delivered like the document index
 * (docs/superpowers/specs/2026-10-03-agent-rules-design.md).
 *
 * A rule is a section under a heading (levels 2 to 4) of a rule file. An HTML
 * comment on the line after the heading sets its severity:
 * `<!-- rule: must -->`, `<!-- rule: should -->` or `<!-- rule: should, pinned -->`.
 * A subsection takes its parent's marker; `<!-- rules: should -->` before the
 * first heading sets the file's default; with neither, a rule is `must`, so an
 * unmarked file is delivered exactly as before.
 *
 * While every rule fits `maxTokens`, nothing changes. Over it, a session gets
 * `must` and pinned rules in full, the most relevant `should` rules in full
 * while they fit, and every other rule as one index line read with `Read` and
 * its line range. Each index line is an entry rendered by `@mnmal-ai/context-render`,
 * as the document index's lines are. Pure: no I/O.
 */

import { fallbackSynopsis } from "@mnmal-ai/swarm-substrate";
import { renderIndexLine } from "@mnmal-ai/context-render";

export type RuleSeverity = "must" | "should";

/** A rule file's text, and where a session can read it by line range (null when only a stored copy was available). */
export interface RuleFile {
  /** Relative to the swarm folder, e.g. `core/rules.md`. */
  path: string;
  content: string;
  absolutePath: string | null;
}

export interface RuleSection {
  path: string;
  absolutePath: string | null;
  /** Heading texts from level 2 down; empty for the text before the first heading. */
  headingPath: string[];
  /** Each heading's level, alongside `headingPath`. */
  headingLevels: number[];
  /** 0 for the text before the first heading, else 2 to 4. */
  level: number;
  /** The section's markdown, heading line included, as in the file. */
  body: string;
  /** 1-based, inclusive line range in the file. */
  startLine: number;
  endLine: number;
  tokens: number;
  severity: RuleSeverity;
  pinned: boolean;
  synopsis: string;
  /** No rule text: only a heading, markers or the file's title. */
  empty: boolean;
  /** An unrecognised marker value, which counts as `must`. */
  markerError?: string;
}

/** Scores sections for a task, one number per section, higher is more relevant. Stage 3 can supply embeddings here. */
export type RuleRanker = (task: string, sections: ReadonlyArray<Pick<RuleSection, "headingPath" | "body">>) => number[];

export interface RulePlan {
  /** Whether the rules exceed the budget; when false, delivery is unchanged and the plan is not rendered. */
  overBudget: boolean;
  /** In file order. */
  full: RuleSection[];
  /** In file order. */
  indexed: RuleSection[];
  /** Tokens of every rule section, all delivered in full. */
  tokensIfFull: number;
}

/** Swarm's token estimate: four characters a token, rounded up. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const fmt = (n: number): string => n.toLocaleString("en-US");

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE_MARKER = /^<!--\s*rule:\s*(.*?)\s*-->$/i;
const FILE_DEFAULT = /^<!--\s*rules:\s*(.*?)\s*-->$/i;
const MARKER_LINE = /^<!--.*-->$/;

interface Marker {
  severity: RuleSeverity;
  pinned: boolean;
  error?: string;
}

function parseMarker(value: string): Marker {
  const words = value.toLowerCase().split(/[\s,]+/).filter((w) => w !== "");
  const pinned = words.includes("pinned");
  const levels = words.filter((w) => w !== "pinned");
  if (levels.length === 1 && (levels[0] === "must" || levels[0] === "should")) return { severity: levels[0], pinned };
  if (levels.length === 0 && pinned) return { severity: "should", pinned };
  return { severity: "must", pinned: false, error: value };
}

/** Split a rule file into sections at every heading from level 2 to 4, outside code fences. */
export function parseRuleFile(file: RuleFile): RuleSection[] {
  const lines = file.content.replace(/\r\n?/g, "\n").split("\n");
  interface Part {
    headingPath: string[];
    headingLevels: number[];
    level: number;
    start: number; // 0-based index of the first line
    lines: string[];
  }
  const parts: Part[] = [{ headingPath: [], headingLevels: [], level: 0, start: 0, lines: [] }];
  const stack: Array<{ level: number; text: string }> = [];
  // An open code fence: its character and length. Only a bare fence of the
  // same character and at least that length closes it (CommonMark).
  let fence: { ch: string; len: number } | null = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
    } else if (fence === null) {
      const h = HEADING.exec(line);
      if (h && h[1].length >= 2 && h[1].length <= 4) {
        const level = h[1].length;
        while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, text: h[2] });
        parts.push({ headingPath: stack.map((s) => s.text), headingLevels: stack.map((s) => s.level), level, start: i, lines: [line] });
        return;
      }
    }
    parts[parts.length - 1].lines.push(line);
  });

  // The file's default, from a `rules:` comment before the first heading.
  let fileDefault: Marker = { severity: "must", pinned: false };
  for (const line of parts[0].lines) {
    const m = FILE_DEFAULT.exec(line.trim());
    if (m) fileDefault = parseMarker(m[1]);
  }

  const sections: RuleSection[] = [];
  const markerAt = new Map<string, Marker>(); // by heading path, for inheritance
  for (const part of parts) {
    if (part.level === 0 && part.lines.length === 0) continue;
    const firstAfter = part.level === 0 ? undefined : part.lines.slice(1).find((l) => l.trim() !== "");
    const own = firstAfter !== undefined ? RULE_MARKER.exec(firstAfter.trim()) : null;
    let marker: Marker;
    if (own) marker = parseMarker(own[1]);
    else {
      const parentKey = part.headingPath.slice(0, -1).join("\u0000");
      marker = (part.headingPath.length > 1 && markerAt.get(parentKey)) || fileDefault;
    }
    markerAt.set(part.headingPath.join("\u0000"), marker);

    const body = part.lines.join("\n");
    const ruleText = part.lines.filter((l, idx) => {
      const t = l.trim();
      if (t === "" || MARKER_LINE.test(t)) return false;
      if (idx === 0 && part.level > 0) return false; // the heading line
      if (part.level === 0 && /^#\s/.test(t)) return false; // the file's title
      return true;
    });
    sections.push({
      path: file.path,
      absolutePath: file.absolutePath,
      headingPath: part.headingPath,
      headingLevels: part.headingLevels,
      level: part.level,
      body,
      startLine: part.start + 1,
      endLine: part.start + part.lines.length,
      tokens: estimateTokens(body),
      severity: marker.severity,
      pinned: marker.pinned,
      synopsis: fallbackSynopsis(body),
      empty: ruleText.length === 0,
      ...(marker.error !== undefined ? { markerError: marker.error } : {}),
    });
  }
  // A trailing newline leaves an empty last line in the last section; its range ends at the file's last line.
  return sections;
}

const STOP_WORDS = new Set(
  "the and for are but not you all any can had her was one our out has have from this that with they will would there their what when which while into than then them these those your about after before over under only also must should never always each every other some such more most very just".split(
    " ",
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/** The default ranker: each distinct task word scores 2 in a section's heading path and 1 in its body. */
export const lexicalRuleRanker: RuleRanker = (task, sections) => {
  const taskWords = words(task);
  return sections.map((s) => {
    const heading = words(s.headingPath.join(" "));
    const body = words(s.body);
    let score = 0;
    for (const w of taskWords) {
      if (heading.has(w)) score += 2;
      else if (body.has(w)) score += 1;
    }
    return score;
  });
};

export interface PlanRulesOptions {
  /** The task as the session sees it. */
  task: string;
  maxTokens: number;
  /** How many `should` rules may be delivered in full for relevance. */
  relevant: number;
  ranker?: RuleRanker;
}

/** Which rules go in full and which as index lines. */
export function planRules(sections: readonly RuleSection[], opts: PlanRulesOptions): RulePlan {
  const rules = sections.filter((s) => !s.empty);
  const tokensIfFull = rules.reduce((n, s) => n + s.tokens, 0);
  if (tokensIfFull <= opts.maxTokens) return { overBudget: false, full: [...rules], indexed: [], tokensIfFull };

  // Always in full: must, pinned, and anything there is no line range to read.
  const always = new Set(rules.filter((s) => s.severity === "must" || s.pinned || s.absolutePath === null));
  let used = [...always].reduce((n, s) => n + s.tokens, 0);
  const candidates = rules.filter((s) => !always.has(s));
  const scores = (opts.ranker ?? lexicalRuleRanker)(opts.task, candidates);
  const ranked = candidates
    .map((s, i) => ({ s, i, score: scores[i] ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = new Set<RuleSection>();
  for (const { s } of ranked) {
    if (chosen.size >= opts.relevant) break;
    if (used + s.tokens > opts.maxTokens) continue;
    chosen.add(s);
    used += s.tokens;
  }
  const full = rules.filter((s) => always.has(s) || chosen.has(s));
  const indexed = rules.filter((s) => !always.has(s) && !chosen.has(s));
  return { overBudget: true, full, indexed, tokensIfFull };
}

/** One rule's index line: an entry whose synopsis is the line's text (renderIndexLine prints the synopsis), carrying the rule's tokens. */
function indexLine(s: RuleSection): string {
  const heading = s.headingPath.length > 0 ? s.headingPath.join(" › ") : "(start)";
  const head = `L${s.startLine}–${s.endLine} ${heading} (${fmt(s.tokens)} tok)`;
  const text = s.synopsis !== "" ? `${head} — ${s.synopsis}` : head;
  return renderIndexLine({ id: `${s.path}:L${s.startLine}`, label: text, synopsis: text, tokens: s.tokens });
}

/** A section's text as the model sees it: markers out, trailing blank lines trimmed. */
function shown(body: string): string {
  return body
    .split("\n")
    .filter((l) => !MARKER_LINE.test(l.trim()) || !/^<!--\s*rules?:/i.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * The rules block that replaces the rule files in a session's context: per
 * file, its full sections in file order (with the headings of their parents),
 * then its other rules as index lines. Empty when the plan isn't over budget.
 */
export function renderRulesBlock(plan: RulePlan, files: readonly RuleFile[]): string {
  if (!plan.overBudget) return "";
  const out: string[] = [
    "## Project Rules",
    "",
    "Every rule below binds. Those in full apply as written. Each rule listed by line range applies too: before work it bears on, read it with Read and that range (`L41–58` is offset 41, limit 18).",
  ];
  for (const file of files) {
    const full = plan.full.filter((s) => s.path === file.path);
    const indexed = plan.indexed.filter((s) => s.path === file.path);
    if (full.length === 0 && indexed.length === 0) continue;
    out.push("", `### ${file.absolutePath ?? file.path}`);
    const emitted = new Set<string>();
    const blocks: string[] = [];
    for (const s of full) {
      // The headings of parents not delivered themselves, so a subsection keeps its place.
      for (let depth = 1; depth < s.headingPath.length; depth++) {
        const key = s.headingPath.slice(0, depth).join("\u0000");
        if (emitted.has(key)) continue;
        emitted.add(key);
        blocks.push(`${"#".repeat(s.headingLevels[depth - 1] ?? 2)} ${s.headingPath[depth - 1]}`);
      }
      emitted.add(s.headingPath.join("\u0000"));
      const text = shown(s.body);
      if (text !== "") blocks.push(text);
    }
    if (blocks.length > 0) out.push("", blocks.join("\n\n"));
    if (indexed.length > 0) out.push("", "Read when relevant:", ...indexed.map(indexLine));
  }
  return out.join("\n");
}

/**
 * An assembled swarm context without the files at `drop`. The context is
 * `--- swarm: <path> (<tier>) ---\n<content>` blocks joined by "\n\n", in the
 * order of `files` (the loader's manifest). Null when the context doesn't split
 * by its manifest, so the caller leaves it as it is.
 */
export function dropContextFiles(
  content: string,
  files: ReadonlyArray<{ path: string; tier: string }>,
  drop: readonly string[],
): string | null {
  if (files.length === 0) return content === "" ? "" : null;
  const delimiters = files.map((f) => `--- swarm: ${f.path} (${f.tier}) ---\n`);
  const blocks: string[] = [];
  let cursor = 0;
  for (let i = 0; i < files.length; i++) {
    const start = content.indexOf(delimiters[i], cursor);
    if (start !== cursor) return null;
    let end = content.length;
    if (i + 1 < files.length) {
      end = content.indexOf(`\n\n${delimiters[i + 1]}`, start + delimiters[i].length);
      if (end === -1) return null;
    }
    blocks.push(content.slice(start, end));
    cursor = i + 1 < files.length ? end + 2 : end;
  }
  if (cursor !== content.length) return null;
  const dropped = new Set(drop);
  return blocks.filter((_, i) => !dropped.has(files[i].path)).join("\n\n");
}

/** What a session's record says about its rules. */
export interface RulesRecord {
  sections: number;
  full: number;
  indexed: number;
  /** Estimated tokens of the rules block. */
  tokens: number;
  /** Estimated tokens of every rule delivered in full. */
  tokensIfFull: number;
}

export function rulesRecord(plan: RulePlan, block: string): RulesRecord {
  return {
    sections: plan.full.length + plan.indexed.length,
    full: plan.full.length,
    indexed: plan.indexed.length,
    tokens: estimateTokens(block),
    tokensIfFull: plan.tokensIfFull,
  };
}
