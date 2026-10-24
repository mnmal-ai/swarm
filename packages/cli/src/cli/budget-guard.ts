// Session budget enforcement, in tokens.
//
// Evaluated at every task boundary against the session's tokens so far (all
// input — fresh, cache reads, cache writes — plus output): a session warns
// once at 80% of max_tokens_per_session and aborts the moment it exceeds it.
// The limit always exists; a project that sets none gets its trust level's.

/**
 * The two session-budget predicates the guard consumes. Orchestrator satisfies
 * this structurally; the narrow shape keeps the decision logic unit-testable
 * without standing up a full Orchestrator.
 */
export interface BudgetGuard {
  shouldWarnTokens(tokens: number): boolean;
  isSessionTokenExceeded(tokens: number): boolean;
}

/** Whether the 80% warning has already been emitted this session. */
export interface BudgetWarnState {
  tokenWarningIssued: boolean;
}

export interface BudgetDecision {
  /** Emit the 80% token warning now (false once already issued). */
  warnTokens: boolean;
  /** True when the session token limit is exceeded and the session must pause. */
  abort: boolean;
}

/** Evaluate the session token budget for the tokens used so far. */
export function evaluateSessionBudget(
  guard: BudgetGuard,
  cumulativeTokens: number,
  state: BudgetWarnState,
): BudgetDecision {
  return {
    warnTokens: !state.tokenWarningIssued && guard.shouldWarnTokens(cumulativeTokens),
    abort: guard.isSessionTokenExceeded(cumulativeTokens),
  };
}
