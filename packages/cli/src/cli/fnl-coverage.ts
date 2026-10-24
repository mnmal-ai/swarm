/**
 * How swarm run reports fnl coverage: how many of a session's build and test
 * commands fnl digested, why it left the others as written, and the tokens
 * the digests saved. Each session's counts come from its backend (FnlCoverage,
 * counted from fnl's own decisions, and FnlSavings, measured after each
 * wrapped call); FnlTotals adds them up for the run. A miss is then visible
 * while the run goes, not only as an empty fnl store afterwards.
 */

import { formatTokens, type FnlCoverage, type FnlSavings } from "@mnmal-ai/swarm-types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** fnl's reasons for leaving build commands alone, most common first: "structure 3, deny-rule 1". */
function reasons(leftAlone: Record<string, number>): string {
  const entries = Object.entries(leftAlone).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 1) return entries[0][0];
  return entries.map(([reason, n]) => `${reason} ${n}`).join(", ");
}

/**
 * One line for a session or a run, e.g. "wrapped 1 of 4 build/test commands
 * (3 left alone: structure) · saved ~12k tokens · 1 large log digested". Null
 * when there is nothing to say: no build commands and fnl answered every
 * time. `firstRead` says what the saving is, for the run summary: tokens of
 * output the agents didn't read the first time (each result is re-sent on
 * every later call). A large log is one Claude Code would have cut, so the
 * agent got the result without further reads.
 */
export function describeFnlCoverage(c: FnlCoverage, opts: { firstRead?: boolean } = {}): string | null {
  if (c.buildCommands === 0 && c.unanswered === 0) return null;
  const left = c.buildCommands - c.wrapped;
  let line = c.buildCommands === 0 ? "no build/test commands" : `wrapped ${c.wrapped} of ${c.buildCommands} build/test commands`;
  if (left > 0) line += ` (${left} left alone: ${reasons(c.leftAlone)})`;
  if (c.unanswered > 0) line += `; fnl didn't answer for ${plural(c.unanswered, "command", "commands")}`;
  if (c.savings && c.savings.calls > 0) {
    line += ` · saved ~${formatTokens(c.savings.savedTokens)} tokens${opts.firstRead ? " of output (first read)" : ""}`;
    if (c.savings.oversized > 0) line += ` · ${plural(c.savings.oversized, "large log", "large logs")} digested`;
  }
  return line;
}

const SAVINGS_FIELDS = ["calls", "rawTokens", "sentTokens", "withoutFnlTokens", "savedTokens", "unmeasured", "oversized"] as const;

/** The run's fnl coverage: every session's counts, added up. */
export class FnlTotals {
  sessions = 0;
  private sum: FnlCoverage = { buildCommands: 0, wrapped: 0, leftAlone: {}, byTool: {}, unanswered: 0 };
  /** The sessions' savings added up; undefined until a session has some. */
  private savings: FnlSavings | undefined;

  add(c: FnlCoverage): void {
    this.sessions++;
    const s = this.sum;
    s.buildCommands += c.buildCommands;
    s.wrapped += c.wrapped;
    s.unanswered += c.unanswered;
    if (c.savings) {
      const t = (this.savings ??= { calls: 0, rawTokens: 0, sentTokens: 0, withoutFnlTokens: 0, savedTokens: 0, unmeasured: 0, oversized: 0 });
      for (const field of SAVINGS_FIELDS) t[field] += c.savings[field];
    }
    for (const [reason, n] of Object.entries(c.leftAlone)) s.leftAlone[reason] = (s.leftAlone[reason] ?? 0) + n;
    for (const [tool, n] of Object.entries(c.byTool)) {
      const t = (s.byTool[tool] ??= { wrapped: 0, leftAlone: 0 });
      t.wrapped += n.wrapped;
      t.leftAlone += n.leftAlone;
    }
  }

  /** The run's total, or null when no session counted coverage. */
  total(): FnlCoverage | null {
    if (this.sessions === 0) return null;
    const s = this.sum;
    return {
      buildCommands: s.buildCommands,
      wrapped: s.wrapped,
      leftAlone: { ...s.leftAlone },
      byTool: Object.fromEntries(Object.entries(s.byTool).map(([tool, n]) => [tool, { ...n }])),
      unanswered: s.unanswered,
      ...(this.savings ? { savings: { ...this.savings } } : {}),
    };
  }
}
