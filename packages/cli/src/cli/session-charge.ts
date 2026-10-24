// Charging work to the session, in tokens.
//
// A task's run and the decomposition call that splits a task both use tokens.
// Charging them through one helper adds them to the orchestrator's total (the
// session budget check reads it) and to the dashboard's running split
// together, so the two always count the same work.

import { addTokenBreakdown, emptyTokenBreakdown, tokenBreakdown } from "@mnmal-ai/swarm-types";
import type { TokenBreakdown } from "@mnmal-ai/swarm-types";

/** One piece of work: a task result or a sub-decomposition result. A
 *  decomposition that made no call reports no `tokensUsed`. */
export interface Spend {
  /** `input` counts all input tokens, cache included. */
  tokensUsed?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** The session counter the budget check reads; Orchestrator satisfies this. */
export interface SessionCounters {
  addTokens(n: number): void;
}

/** The token split of several pieces of work combined. */
export function spendTokens(...spends: Spend[]): TokenBreakdown {
  let sum = emptyTokenBreakdown();
  for (const s of spends) {
    if (s.tokensUsed) sum = addTokenBreakdown(sum, tokenBreakdown(s.tokensUsed));
  }
  return sum;
}

/**
 * Charge work to the session: its input + output tokens go to the
 * orchestrator's total, and its split to the session's running split for the
 * dashboard. Returns the work's split and the new running split.
 */
export function chargeSession(
  counters: SessionCounters,
  sessionTokens: TokenBreakdown,
  ...spends: Spend[]
): { tokens: TokenBreakdown; sessionTokens: TokenBreakdown } {
  let billable = 0;
  for (const s of spends) {
    if (s.tokensUsed) billable += s.tokensUsed.input + s.tokensUsed.output;
  }
  counters.addTokens(billable);
  const tokens = spendTokens(...spends);
  return { tokens, sessionTokens: addTokenBreakdown(sessionTokens, tokens) };
}
