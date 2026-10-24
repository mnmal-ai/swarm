// What `swarm run` prints about budgets, in tokens.
//
// Kept apart from run.ts so the preflight limits, the over-limit prompt and
// the end-of-run summary can be tested as the text a person reads. Token
// counts are all input (fresh, cache reads, cache writes) plus output.

import type { FnlCoverage } from "@mnmal-ai/swarm-types";
import { describeFnlCoverage } from "./fnl-coverage.js";
import { formatTokens, tokenBreakdownTotal } from "@mnmal-ai/swarm-types";
import type { TokenBreakdown } from "@mnmal-ai/swarm-types";

/** The preflight screen's limit rows. */
export function formatTokenLimitLines(limits: { session: number; goal: number; task: number }): string[] {
  return [
    `Session     ${formatTokens(limits.session)} tokens`,
    `Per goal    ${formatTokens(limits.goal)} tokens`,
    `Per task    ${formatTokens(limits.task)} tokens`,
  ];
}

/** The line shown when a task used more tokens than its limit. */
export function describeTaskOverrun(taskLabel: string, taskTokens: number, limit: number): string {
  return `Task "${taskLabel}" exceeded its token limit (${formatTokens(taskTokens)} > ${formatTokens(limit)} tokens)`;
}

export interface TaskOverrunDecision {
  action: "increase" | "skip" | "abort";
  /** The raised per-task limit, when the choice was to increase it. */
  newLimit?: number;
  /** What to print once the choice is made. */
  message: string;
  /** The orchestration event to record, if any. */
  event?: { type: "token_limit_increased" | "task_token_exceeded"; detail: string; tokens: number };
}

/**
 * What a choice at the over-limit prompt does. "increase" raises the per-task
 * limit to 1.5x what the task used; "skip" skips the task; anything else
 * aborts the run (after a checkpoint).
 */
export function resolveTaskOverrun(choice: string, taskTokens: number, limit: number): TaskOverrunDecision {
  if (choice === "increase") {
    const newLimit = Math.ceil(taskTokens * 1.5);
    return {
      action: "increase",
      newLimit,
      message: `Per-task limit increased to ${formatTokens(newLimit)} tokens. Continuing...`,
      event: {
        type: "token_limit_increased",
        detail: `Per-task limit increased from ${formatTokens(limit)} to ${formatTokens(newLimit)} tokens`,
        tokens: newLimit,
      },
    };
  }
  if (choice === "skip") {
    return {
      action: "skip",
      message: "Task skipped. Continuing with remaining tasks...",
      event: {
        type: "task_token_exceeded",
        detail: `Task skipped: ${formatTokens(taskTokens)} tokens (limit: ${formatTokens(limit)} tokens)`,
        tokens: taskTokens,
      },
    };
  }
  return { action: "abort", message: "Saving checkpoint and exiting..." };
}

/** The session's tokens: the exact total, then the split. */
export function formatSessionTokens(tokens: TokenBreakdown): string {
  const cached = tokens.cacheRead + tokens.cacheWrite;
  return (
    `${tokenBreakdownTotal(tokens).toLocaleString("en-US")} ` +
    `(input ${formatTokens(tokens.freshInput)} · cached ${formatTokens(cached)} · output ${formatTokens(tokens.output)})`
  );
}

/** The end-of-run summary rows, label first. */
export function sessionSummaryLines(summary: {
  project: string;
  tasksCompleted: number;
  tasksRun: number;
  tokens: TokenBreakdown;
  duration: string;
  /** The run's fnl coverage, when its sessions counted it. */
  fnl?: FnlCoverage;
}): string[] {
  return [
    `Project:         ${summary.project}`,
    `Tasks completed: ${summary.tasksCompleted}`,
    `Tasks run:       ${summary.tasksRun}`,
    `Total tokens:    ${formatSessionTokens(summary.tokens)}`,
    ...(summary.fnl ? [`fnl coverage:    ${describeFnlCoverage(summary.fnl, { firstRead: true }) ?? "no build/test commands ran"}`] : []),
    `Duration:        ${summary.duration}`,
  ];
}
