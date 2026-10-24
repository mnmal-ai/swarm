/**
 * Measure how many tokens fnl's digests save a claude-code session.
 *
 * The fnl PreToolUse hook (fnl-hook.ts) tells a FnlSavingsMeter about each
 * Bash call it wrapped, by tool_use_id, with the rewritten command; the meter
 * keeps only what the command's kept suffix does to its output (keptTail).
 * After the call, fnlSavingsHook, an Agent SDK PostToolUse and
 * PostToolUseFailure hook on Bash, measures it:
 *
 * - sent: the result as Claude Code sends it to the model (sentText), or a
 *   failed call's error text;
 * - raw: fnl's full output for the run, `fnl show <id>`, the id read from the
 *   digest's footer (footerRunId);
 * - withoutFnl: what the agent's own command would have shown: the raw output
 *   through the same `| tail`, as Claude Code would have handed it to the
 *   model (see CLAUDE_CODE; oversized when it would have been cut);
 * - saved: withoutFnl minus sent, never below zero.
 *
 * A command fails, for Claude Code, when it exits non-zero, and `fnl run`
 * keeps the command's exit code, so a failing build without a `| tail`
 * reaches the PostToolUseFailure hook; it is measured there. A wrapped call
 * it can't measure (no footer in the result, `fnl show` failing, the call
 * interrupted or never finishing, a suffix it can't follow) counts as
 * unmeasured.
 *
 * The hook never changes a tool result and never throws. It sees command
 * text and output but keeps neither: only character counts leave it.
 *
 * Shapes are the Agent SDK's (sdk.d.ts, sdk-tools.d.ts): `PostToolUseHookInput`
 * carries tool_name, tool_use_id and `tool_response`, which for Bash is a
 * `BashOutput` (stdout, stderr, interrupted, and optionally tokenSaverOutput
 * or persistedOutputPath); `PostToolUseFailureHookInput` carries an `error`.
 */

import type { FnlSavings } from "@mnmal-ai/swarm-types";
import { runFnl } from "./fnl-hook.js";

/**
 * What a wrapped command's kept suffix does to its output: keep the last N
 * lines (`| tail -N`), keep lines from N on (`| tail -n +N`), or nothing
 * (null: no suffix, or only `2>&1`).
 */
export type Tail = { last: number } | { from: number } | null;

/** What precedes the command fnl runs, as one shell word: `<fnl> run -- `. */
const RUN = " run -- ";
/**
 * What fnl keeps after that word: `2>&1`, then `| tail` with the arguments
 * swarm can follow (none, -N, -n N, -nN, -n +N), or nothing.
 */
const KEPT_SUFFIX = /^(?:\s+2>&1)?(\s*\|\s*tail(?:\s+(?:-(\d+)|-n\s*(\+?)(\d+)))?)?\s*$/;

/** What `tail` keeps with no line count. */
const TAIL_DEFAULT_LINES = 10;

/** Where the shell word starting at `start` ends: plain characters, '…' and "…" runs, and \-escapes. */
function wordEnd(s: string, start: number): number | undefined {
  let i = start;
  while (i < s.length && !/[\s|&;<>()]/.test(s[i])) {
    if (s[i] === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return undefined;
      i = close + 1;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return undefined;
      i = j + 1;
    } else {
      i += s[i] === "\\" ? 2 : 1;
    }
  }
  return i > start && i <= s.length ? i : undefined;
}

/**
 * What the suffix of a rewritten command (`… fnl run -- '<command>' 2>&1 |
 * tail -40`) does to its output; undefined when it is a suffix this can't
 * follow. fnl passes the command as one word, quoted unless it is plain.
 */
export function keptTail(rewritten: string): Tail | undefined {
  const run = rewritten.indexOf(RUN);
  if (run < 0) return undefined;
  const end = wordEnd(rewritten, run + RUN.length);
  if (end === undefined) return undefined;
  const kept = KEPT_SUFFIX.exec(rewritten.slice(end));
  if (!kept) return undefined;
  const [, tail, dash, plus, n] = kept;
  if (tail === undefined) return null;
  if (dash !== undefined) return { last: Number(dash) };
  if (n !== undefined) return plus === "+" ? { from: Number(n) } : { last: Number(n) };
  return { last: TAIL_DEFAULT_LINES };
}

/** `output` as `tail` would pass it on. */
export function applyTail(output: string, tail: Tail): string {
  if (tail === null) return output;
  const lines = output.split("\n");
  // A final newline ends the last line; it doesn't start another.
  if (lines[lines.length - 1] === "") lines.pop();
  if ("last" in tail) return tail.last === 0 ? "" : lines.slice(-tail.last).join("\n");
  return lines.slice(Math.max(0, tail.from - 1)).join("\n");
}

/**
 * How Claude Code hands a Bash result to the model, which `withoutFnl`
 * models (read from the CLI the Agent SDK bundles, and checked against the
 * installed one swarm launches):
 *
 * - a successful result is sent whole up to the Bash output limit: 30,000
 *   characters by default, or BASH_MAX_OUTPUT_LENGTH when it is a positive
 *   number, capped at 150,000. Over the limit it is saved to a file and the
 *   model gets a preview of its first 2,000 characters, with the file's path;
 * - a failed command (non-zero exit) is sent as error text: `Exit code N`,
 *   stderr and stdout. Over 10,000 characters it keeps its first 5,000 and
 *   last 5,000.
 */
const CLAUDE_CODE = {
  defaultOutputLimit: 30_000,
  maxOutputLimit: 150_000,
  previewChars: 2_000,
  failureTextLimit: 10_000,
} as const;

/**
 * Claude Code's Bash output limit, in characters, from the session's
 * BASH_MAX_OUTPUT_LENGTH as Claude Code reads it (CLAUDE_CODE).
 */
export function bashOutputLimit(value: string | undefined): number {
  if (!value) return CLAUDE_CODE.defaultOutputLimit;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return CLAUDE_CODE.defaultOutputLimit;
  return Math.min(n, CLAUDE_CODE.maxOutputLimit);
}

/** A digest's footer, at its end: `[fnl <id>]` or `[fnl <id> · … · fnl show <id>]`. */
const FOOTER = /\[fnl ([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?: · [^\]\n]*)?\]\s*$/;

/** The run a digest names in its footer, or null when the text doesn't end with one. */
export function footerRunId(text: string): string | null {
  return FOOTER.exec(text)?.[1] ?? null;
}

/** Output as Claude Code returns it: no leading blank lines, no trailing space. */
const asReturned = (text: string): string => text.replace(/^(\s*\n)+/, "").trimEnd();

/**
 * What the agent's own command would have shown it without fnl, in
 * characters: fnl's full output through the command's kept tail, as Claude
 * Code hands a result (or, for a failed call, its error text) to the model
 * (CLAUDE_CODE). Oversized when Claude Code would have cut it, so the agent
 * would have needed more reads to find the result.
 */
export function withoutFnl(raw: string, tail: Tail, opts: { failed: boolean; outputLimit: number }): { chars: number; oversized: boolean } {
  const shown = asReturned(applyTail(raw, tail)).length;
  if (opts.failed) {
    return shown > CLAUDE_CODE.failureTextLimit ? { chars: CLAUDE_CODE.failureTextLimit, oversized: true } : { chars: shown, oversized: false };
  }
  return shown > opts.outputLimit ? { chars: Math.min(shown, CLAUDE_CODE.previewChars), oversized: true } : { chars: shown, oversized: false };
}

/**
 * A Bash result as Claude Code sends it to the model: stdout (or the
 * compressed output it sent instead), then stderr. Null when the result
 * isn't plain output: an interrupted call, output saved to a file, or a
 * shape this doesn't know.
 */
export function sentText(toolResponse: unknown): string | null {
  if (toolResponse === null || typeof toolResponse !== "object") return null;
  const r = toolResponse as Record<string, unknown>;
  if (typeof r.stdout !== "string" || r.interrupted === true || r.persistedOutputPath !== undefined) return null;
  const stdout = typeof r.tokenSaverOutput === "string" && r.tokenSaverOutput !== "" ? r.tokenSaverOutput : asReturned(r.stdout);
  const stderr = typeof r.stderr === "string" ? r.stderr.trim() : "";
  return [stdout, stderr].filter((part) => part !== "").join("\n");
}

/** swarm's token estimate. */
const tokens = (chars: number): number => Math.ceil(chars / 4);

/** One session's wrapped Bash calls, and what measuring them found. */
export class FnlSavingsMeter {
  /** Wrapped calls not yet measured: tool_use_id → their kept tail (undefined: one this can't follow). */
  private pending = new Map<string, Tail | undefined>();
  private wrappedCalls = 0;
  private calls = 0;
  private unmeasuredCalls = 0;
  private oversizedCalls = 0;
  private chars = { raw: 0, sent: 0, withoutFnl: 0, saved: 0 };

  /** The PreToolUse hook wrapped this call; `rewritten` is the command it runs (not kept). */
  wrapped(toolUseId: string | undefined, rewritten: string): void {
    this.wrappedCalls++;
    if (toolUseId === undefined) {
      this.unmeasuredCalls++;
      return;
    }
    this.pending.set(toolUseId, keptTail(rewritten));
  }

  /** The wrapped call with this id, taken off the pending list; undefined when it wasn't one. */
  take(toolUseId: string | undefined): { tail: Tail | undefined } | undefined {
    if (toolUseId === undefined || !this.pending.has(toolUseId)) return undefined;
    const tail = this.pending.get(toolUseId);
    this.pending.delete(toolUseId);
    return { tail };
  }

  /** A wrapped call measured, in characters; oversized when Claude Code would have cut its output. */
  measured(m: { raw: number; sent: number; withoutFnl: number; oversized: boolean }): void {
    this.calls++;
    if (m.oversized) this.oversizedCalls++;
    this.chars.raw += m.raw;
    this.chars.sent += m.sent;
    this.chars.withoutFnl += m.withoutFnl;
    this.chars.saved += Math.max(0, m.withoutFnl - m.sent);
  }

  /** A wrapped call that couldn't be measured. */
  unmeasured(): void {
    this.unmeasuredCalls++;
  }

  /** The session's savings so far, or undefined when it wrapped nothing. Calls still pending count as unmeasured. */
  snapshot(): FnlSavings | undefined {
    if (this.wrappedCalls === 0) return undefined;
    return {
      calls: this.calls,
      rawTokens: tokens(this.chars.raw),
      sentTokens: tokens(this.chars.sent),
      withoutFnlTokens: tokens(this.chars.withoutFnl),
      savedTokens: tokens(this.chars.saved),
      unmeasured: this.unmeasuredCalls + this.pending.size,
      oversized: this.oversizedCalls,
    };
  }
}

/** How the savings hook reaches fnl and what it measures against. */
export interface FnlSavingsHookOptions {
  /** Absolute path to fnl; run without a shell. */
  bin: string;
  /** The session's meter, shared with its fnl PreToolUse hook. */
  meter: FnlSavingsMeter;
  /** Working directory when the hook input carries none. */
  cwd?: string;
  /** Claude Code's Bash output limit for the session (bashOutputLimit). Default 30,000. */
  outputLimit?: number;
  /** How long `fnl show` may take. Default 5000 ms. */
  timeoutMs?: number;
  /** The most output `fnl show` may print. Default 16 MiB; a larger log is unmeasured. */
  maxBuffer?: number;
}

/** The hook callback, shaped like the SDK's HookCallback; it returns no output. */
export type FnlSavingsHookCallback = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, never>>;

const DEFAULT_SHOW_TIMEOUT_MS = 5000;
const DEFAULT_SHOW_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The PostToolUse (and PostToolUseFailure) hook on Bash that measures each
 * wrapped call; see the file header.
 */
export function fnlSavingsHook(opts: FnlSavingsHookOptions): FnlSavingsHookCallback {
  const outputLimit = opts.outputLimit ?? CLAUDE_CODE.defaultOutputLimit;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHOW_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_SHOW_MAX_BUFFER;

  return async (input, toolUseID, options) => {
    let call: { tail: Tail | undefined } | undefined;
    try {
      const hook = (input ?? {}) as {
        hook_event_name?: unknown;
        tool_name?: unknown;
        tool_use_id?: unknown;
        tool_response?: unknown;
        error?: unknown;
        is_interrupt?: unknown;
        cwd?: unknown;
      };
      if (hook.tool_name !== "Bash") return {};
      call = opts.meter.take(typeof hook.tool_use_id === "string" ? hook.tool_use_id : toolUseID);
      if (!call) return {};
      const tail = call.tail;
      const failed = hook.hook_event_name === "PostToolUseFailure";
      let sent: string | null = null;
      if (failed) {
        // A failed call's error text is what the model got: exit code, stderr, stdout.
        if (typeof hook.error === "string" && hook.is_interrupt !== true) sent = hook.error;
      } else if (hook.hook_event_name === "PostToolUse") {
        sent = sentText(hook.tool_response);
      }
      const runId = sent === null ? null : footerRunId(sent);
      if (sent === null || runId === null || tail === undefined) {
        opts.meter.unmeasured();
        return {};
      }
      const cwd = typeof hook.cwd === "string" && hook.cwd !== "" ? hook.cwd : opts.cwd;
      const shown = await runFnl(opts.bin, ["show", runId], cwd, timeoutMs, { maxBuffer, signal: options?.signal });
      if (shown.code !== 0) {
        opts.meter.unmeasured();
        return {};
      }
      const without = withoutFnl(shown.stdout, tail, { failed, outputLimit });
      opts.meter.measured({ raw: shown.stdout.length, sent: sent.length, withoutFnl: without.chars, oversized: without.oversized });
    } catch {
      if (call) opts.meter.unmeasured();
    }
    return {};
  };
}
