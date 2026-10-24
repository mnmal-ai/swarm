/**
 * `swarm run`'s side of goal publications (see the orchestrator's
 * source-control/publications.ts): finishing, at the start of a run, what an
 * earlier run left unpublished, and the console lines that say so.
 */

import type { GoalPublication } from "@mnmal-ai/swarm-types";
import { mergeableFromPublication } from "@mnmal-ai/swarm-orchestrator";
import type { MergeableGoal, MergeGoalOptions, MergeGoalResult, SourceControlManager } from "@mnmal-ai/swarm-orchestrator";

/** The part of SourceControlManager merge-as-you-go uses. */
export type GoalMerger = Pick<SourceControlManager, "mergeGoal" | "restoreBaseBranch">;

/**
 * Merge-as-you-go for one goal. mergeGoal does not throw, but an event
 * listener it calls could: whatever escapes is reported as the PR left open,
 * and the repo goes back to the base branch, so the run always goes on.
 */
export async function mergeGoalSafely(
  merger: GoalMerger,
  goal: MergeableGoal,
  options: MergeGoalOptions,
  base: string,
): Promise<MergeGoalResult> {
  try {
    return await merger.mergeGoal(goal, options);
  } catch (err) {
    await merger.restoreBaseBranch();
    return {
      goalId: goal.goalId,
      branch: goal.branch,
      base,
      merged: false,
      reason: "the merge step stopped unexpectedly; check the pull request by hand",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The merge options for publishing earlier goals. Once the run is stopping
 * (a pause, a budget or login stop), no conflict is handed to a worker:
 * that would spend on an agent after the stop. The conflict is left open,
 * and the next run retries it.
 */
export function earlierMergeOptions(options: MergeGoalOptions, opts: { stopping: boolean }): MergeGoalOptions {
  if (!opts.stopping) return options;
  const { resolveConflict: _dropped, ...rest } = options;
  return rest;
}

/**
 * Merge-as-you-go for goals earlier runs finished but did not publish, in the
 * order they finished: each gets its push, its pull request and, when its
 * tasks' verdicts and labels allow and its gate passes, its merge, exactly as
 * if it had just finished. Runs before this run's first goal, so that goal
 * starts from a base that has them. `onOutcome` sees each result as it lands
 * (to print it and save the checkpoint).
 */
export async function publishEarlierMergeGoals(
  merger: GoalMerger,
  pending: readonly GoalPublication[],
  options: MergeGoalOptions,
  base: string,
  onOutcome?: (outcome: MergeGoalResult) => Promise<void> | void,
): Promise<MergeGoalResult[]> {
  const outcomes: MergeGoalResult[] = [];
  for (const record of pending) {
    if (record.mode !== "merge") continue;
    const outcome = await mergeGoalSafely(merger, mergeableFromPublication(record), options, base);
    outcomes.push(outcome);
    await onOutcome?.(outcome);
  }
  return outcomes;
}

/** Console lines announcing the earlier goals this run publishes first. */
export function formatEarlierPublications(pending: readonly GoalPublication[], mode: GoalPublication["mode"]): string[] {
  if (pending.length === 0) return [];
  const what = mode === "merge" ? "pushes, opens and merges (when eligible)" : "adds to this run's stack";
  const lines = [`Publishing ${pending.length} goal(s) an earlier run finished but did not publish; this run ${what} them first:`];
  for (const r of pending) {
    const state = r.pr_url ? `PR ${r.pr_url}` : r.pushed ? "pushed, no PR" : "not pushed";
    lines.push(`  ${r.goal_id} "${r.description}" on ${r.branch} (${state})`);
  }
  return lines;
}
