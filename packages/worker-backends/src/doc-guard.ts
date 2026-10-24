/**
 * Keep a claude-code session reading indexed documents by section (stage 2 of
 * docs/superpowers/specs/2026-10-01-context-sections-design.md).
 *
 * The session's index lists each stored document's sections with their line
 * ranges. This guard is a PreToolUse hook on Read and Bash that, for each call
 * reading one of those documents:
 *
 * 1. Works out which lines it reads: `Read` from its offset and limit (a
 *    missing offset is 1, a missing limit 2000, as the tool reads); a Bash
 *    `cat`, `less`, `more`, `head`, `tail` or `sed -n 'A,Bp'` from its
 *    arguments, with `cd` followed. A command with `$(`, a backtick, a
 *    heredoc or a redirect is left alone, and so is a piped part, whose
 *    output is filtered.
 * 2. Refuses the call when those lines span more than one section and come
 *    to more than `maxReadTokens`, giving the document's outline (sections and
 *    line ranges) as the reason. One section is always allowed, however big,
 *    so a table that can't be split can still be read.
 * 3. Otherwise lets it run, and counts it (DocumentReadCounter).
 *
 * Sections come from the file as it is now: the stored ones while its hash
 * matches the one they were stored for, else its `##` and `###` headings, so
 * a document the agent has edited still gets correct ranges. Paths are
 * matched as resolved against the session's cwd and through symlinks, since
 * a session's cwd comes back as the real path (macOS `/tmp` is
 * `/private/tmp`) while the guard may hold the linked one.
 *
 * It fails open: a path it can't match or read, a file that isn't markdown,
 * or any error lets the call run uncounted. Command text and file contents
 * are never logged. Hook shapes are the Agent SDK's, as in fnl-hook.ts.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DocumentGuard, DocumentReads } from "@mnmal-ai/swarm-types";

type GuardedDocument = DocumentGuard["documents"][number];
type OutlineSection = GuardedDocument["sections"][number];
type ReadRange = DocumentReads["ranges"][number];

export type GuardDecision = { refuse: false } | { refuse: true; reason: string };

/** How many read ranges a session keeps for its reviewer. */
const MAX_RANGES = 50;
/** The lines `Read` reads when given no limit. */
const READ_DEFAULT_LIMIT = 2000;
/** Indexed documents are markdown; anything else is left alone. */
const MARKDOWN = /\.md$/i;

/** Counts one session's reads of its indexed documents into its DocumentReads. */
export class DocumentReadCounter {
  private reads: DocumentReads = { bounded: 0, refused: 0, whole: 0, ranges: [] };

  add(kind: "bounded" | "refused" | "whole", range?: ReadRange): void {
    this.reads[kind]++;
    if (range && this.reads.ranges.length < MAX_RANGES) this.reads.ranges.push({ ...range });
  }

  snapshot(): DocumentReads {
    return { ...this.reads, ranges: this.reads.ranges.map((r) => ({ ...r })) };
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const estimateTokens = (lines: string[]): number => Math.ceil(lines.join("\n").length / 4);
const fmt = (n: number): string => n.toLocaleString("en-US");
const toLines = (content: string): string[] => content.replace(/\r\n?/g, "\n").split("\n");

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{2,3})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** Sections from the `##`/`###` headings outside code fences; text before the first is a section. */
function headingSections(lines: string[]): OutlineSection[] {
  const starts: Array<{ line: number; headingPath: string[] }> = [];
  let fence: string | null = null;
  let parent: string | null = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (fence === f[1][0]) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = HEADING.exec(line);
    if (!h) return;
    if (h[1].length === 2) parent = h[2];
    starts.push({ line: i + 1, headingPath: h[1].length === 2 || parent === null ? [h[2]] : [parent, h[2]] });
  });
  if (starts.length === 0 || starts[0].line > 1) starts.unshift({ line: 1, headingPath: [] });
  return starts.map((start, k) => {
    const endLine = k + 1 < starts.length ? starts[k + 1].line - 1 : lines.length;
    return { startLine: start.line, endLine, headingPath: start.headingPath, synopsis: "", tokens: estimateTokens(lines.slice(start.line - 1, endLine)) };
  });
}

/** The document's sections as its content is now: stored while the hash matches, else from its headings. */
function currentSections(content: string, doc: GuardedDocument): OutlineSection[] {
  return sha256(content) === doc.contentHash ? doc.sections : headingSections(toLines(content));
}

function outlineLine(s: OutlineSection): string {
  const heading = s.headingPath.length > 0 ? s.headingPath.join(" › ") : "(start)";
  const line = `- L${s.startLine}–${s.endLine} ${heading} (${fmt(s.tokens)} tok)`;
  return s.synopsis !== "" ? `${line} — ${s.synopsis}` : line;
}

/** Outline lines for a document's current content: stored sections when its hash matches, else its `##`/`###` headings outside code fences. */
export function outline(content: string, doc: GuardedDocument): string[] {
  return currentSections(content, doc).map(outlineLine);
}

function refusal(doc: GuardedDocument, sections: OutlineSection[]): string {
  const tokens = sections.reduce((n, s) => n + s.tokens, 0);
  const count = `${sections.length} ${sections.length === 1 ? "section" : "sections"}`;
  return [
    `${doc.displayPath} is stored by section (${fmt(tokens)} tok, ${count}). Read only the sections you need, with offset and limit:`,
    ...sections.map(outlineLine),
  ].join("\n");
}

/** One file a call reads, and which of its lines, given how many it has. */
interface ReadRequest {
  path: string;
  span: (total: number) => [number, number];
}

const whole = (total: number): [number, number] => [1, total];

/** A whole number ≥ 1, or undefined. */
function positive(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

function readToolRequests(toolInput: Record<string, unknown>, cwd: string): ReadRequest[] {
  const file = toolInput.file_path;
  if (typeof file !== "string" || file === "") return [];
  const offset = positive(toolInput.offset) ?? 1;
  const limit = positive(toolInput.limit) ?? READ_DEFAULT_LIMIT;
  return [{ path: resolve(cwd, file), span: () => [offset, offset + limit - 1] }];
}

/** Commands whose reads swarm can't see through: substitutions, heredocs, redirects. */
const OPAQUE = /\$\(|`|<<|>/;

/** Split a command at `&&`, `||`, `;` and newlines outside quotes. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') current += command[i++];
      current += command[i] ?? "";
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || c === ";" || c === "\n") {
      out.push(current);
      current = "";
      if (two === "&&" || two === "||") i++;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** A segment's words with quotes removed; null when it pipes or runs in the background. */
function words(segment: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      inWord = true;
    } else if (c === "|" || c === "&") {
      return null;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(current);
      current = "";
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) out.push(current);
  return out;
}

/** A `head`/`tail` line count: "20", or "+5" (from line 5, for tail). */
function lineCount(value: string | undefined): { n: number; from: boolean } | null {
  const m = value === undefined ? null : /^(\+?)(\d+)$/.exec(value);
  return m ? { n: Number(m[2]), from: m[1] === "+" } : null;
}

/** The files and lines one reader command reads, or null when it isn't one. */
function readerRequests(argv: string[]): { files: string[]; span: ReadRequest["span"] } | null {
  const [cmd, ...args] = argv;
  const name = cmd.slice(cmd.lastIndexOf("/") + 1);
  if (name === "cat" || name === "less" || name === "more") {
    const files = args.filter((a) => !a.startsWith("-"));
    return files.length > 0 ? { files, span: whole } : null;
  }
  if (name === "head" || name === "tail") {
    let count: { n: number; from: boolean } | null = { n: 10, from: false };
    const files: string[] = [];
    for (let i = 0; i < args.length && count !== null; i++) {
      const a = args[i];
      const inline = /^(?:-n|--lines=)(\+?\d+)$/.exec(a) ?? /^-(\d+)$/.exec(a);
      if (a === "-n" || a === "--lines") count = lineCount(args[++i]);
      else if (inline) count = lineCount(inline[1]);
      else if (a.startsWith("-")) count = null;
      else files.push(a);
    }
    if (count === null || files.length === 0) return null;
    const { n, from } = count;
    if (name === "head") return { files, span: (total) => [1, Math.min(n, total)] };
    return { files, span: (total) => (from ? [n, total] : [Math.max(1, total - n + 1), total]) };
  }
  if (name === "sed" && args[0] === "-n" && args.length >= 3) {
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(args[1]);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : m[2] === "$" ? Number.POSITIVE_INFINITY : Number(m[2]);
    return { files: args.slice(2), span: (total) => [start, Math.min(end, total)] };
  }
  return null;
}

function bashRequests(command: string, cwd: string): ReadRequest[] {
  if (OPAQUE.test(command)) return [];
  const requests: ReadRequest[] = [];
  // Where later segments run; null once a `cd` goes somewhere swarm can't follow.
  let dir: string | null = cwd;
  for (const segment of segments(command)) {
    const argv = words(segment);
    if (argv === null) continue;
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
    if (argv.length === 0) continue;
    if (argv[0] === "cd") {
      const target = argv.length === 2 ? argv[1] : undefined;
      const followable = target !== undefined && target !== "-" && !target.startsWith("~");
      dir = followable && (dir !== null || isAbsolute(target)) ? resolve(dir ?? "/", target) : null;
      continue;
    }
    const reader = readerRequests(argv);
    if (!reader) continue;
    for (const file of reader.files) {
      if (dir === null && !isAbsolute(file)) continue;
      requests.push({ path: resolve(dir ?? "/", file), span: reader.span });
    }
  }
  return requests;
}

type Outcome = { kind: "refused"; reason: string } | { kind: "bounded" | "whole"; range: ReadRange };

function judge(guard: DocumentGuard, doc: GuardedDocument, content: string, span: ReadRequest["span"]): Outcome | null {
  const lines = toLines(content);
  const [from, to] = span(lines.length);
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  if (start > end) return null;
  const sections = currentSections(content, doc);
  const spanned = sections.filter((s) => s.startLine <= end && s.endLine >= start).length;
  if (spanned > 1 && estimateTokens(lines.slice(start - 1, end)) > guard.maxReadTokens) {
    return { kind: "refused", reason: refusal(doc, sections) };
  }
  const covered = start === 1 && end === lines.length && sections.length > 1;
  return { kind: covered ? "whole" : "bounded", range: { path: doc.displayPath, startLine: start, endLine: end } };
}

/**
 * Decide one Read or Bash call. `readFile` is injected for tests; it returns
 * null when the file can't be read. `canonical` maps an absolute path to the
 * one paths are compared by (the hook follows symlinks); by default, itself.
 */
export function decideDocumentRead(
  guard: DocumentGuard,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  readFile: (absolutePath: string) => string | null,
  reads: DocumentReadCounter,
  canonical: (absolutePath: string) => string = (p) => p,
): GuardDecision {
  try {
    const command = toolInput.command;
    const requests =
      toolName === "Read"
        ? readToolRequests(toolInput, cwd)
        : toolName === "Bash" && typeof command === "string"
          ? bashRequests(command, cwd)
          : [];
    if (requests.length === 0) return { refuse: false };
    const byPath = new Map(guard.documents.map((d) => [canonical(resolve(d.absolutePath)), d]));
    const outcomes: Outcome[] = [];
    for (const request of requests) {
      const doc = byPath.get(canonical(request.path));
      if (!doc || !MARKDOWN.test(doc.absolutePath)) continue;
      const content = readFile(doc.absolutePath);
      if (content === null) continue;
      const outcome = judge(guard, doc, content, request.span);
      if (outcome) outcomes.push(outcome);
    }
    // Counted only once every read is decided: a refused call reads nothing.
    const refused = outcomes.filter((o): o is Extract<Outcome, { kind: "refused" }> => o.kind === "refused");
    if (refused.length > 0) {
      for (let i = 0; i < refused.length; i++) reads.add("refused");
      return { refuse: true, reason: refused.map((o) => o.reason).join("\n\n") };
    }
    for (const o of outcomes) if (o.kind !== "refused") reads.add(o.kind, o.range);
    return { refuse: false };
  } catch {
    return { refuse: false };
  }
}

/** Subset of the SDK's SyncHookJSONOutput this hook returns. */
export type DocumentGuardHookOutput =
  | { hookSpecificOutput?: undefined }
  | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

/** The hook callback, shaped like the SDK's HookCallback. */
export type DocumentGuardHookCallback = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<DocumentGuardHookOutput>;

function readUtf8(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** The path with symlinks resolved; the path itself when it doesn't exist. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The Agent SDK PreToolUse hook built on decideDocumentRead (shape as in fnl-hook.ts). */
export function documentGuardPreToolUse(opts: {
  guard: DocumentGuard;
  cwd?: string;
  reads: DocumentReadCounter;
  readFile?: (p: string) => string | null;
}): DocumentGuardHookCallback {
  return async (input): Promise<DocumentGuardHookOutput> => {
    const hook = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    if (typeof hook.tool_name !== "string" || hook.tool_input === null || typeof hook.tool_input !== "object") return {};
    const cwd = typeof hook.cwd === "string" && hook.cwd !== "" ? hook.cwd : (opts.cwd ?? process.cwd());
    const decision = decideDocumentRead(
      opts.guard,
      hook.tool_name,
      hook.tool_input as Record<string, unknown>,
      cwd,
      opts.readFile ?? readUtf8,
      opts.reads,
      realPath,
    );
    return decision.refuse
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }
      : {};
  };
}
