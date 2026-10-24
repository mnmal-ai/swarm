/**
 * Goal publications: which finished goals swarm has pushed, opened a pull
 * request for and (under source_control.merge_prs) merged. The records live
 * in the run's checkpoint, so a run that could not publish a goal (a push
 * that failed, a run that stopped first) leaves it for the next run, which
 * publishes it without the goal being in its goal list and without repeating
 * anything already done.
 */

import type { SwarmEventMap, GoalPublication, ISwarmEventBus, LeftOpenKind } from "@mnmal-ai/swarm-types";
import type { CompletedGoal, MergeableGoal } from "./index.js";

/** Left-open kinds a later run (or `swarm merge`) tries again without being asked. */
export const RETRYABLE_LEFT_OPEN_KINDS: ReadonlySet<LeftOpenKind> = new Set<LeftOpenKind>(["conflict", "base_kept_moving", "refused"]);

/** Attempts in all (the first included) after which runs stop retrying a left-open pull request on their own; `swarm merge` still retries when asked. */
export const MERGE_PRS_MAX_ATTEMPTS = 3;

/** source_control settings that decide what publishing a stacked goal means. */
export interface PublicationSettings {
  /** source_control.auto_push is not false. */
  autoPush: boolean;
  /** source_control.pr_on_goal_complete is not false. */
  openPr: boolean;
}

/**
 * Whether swarm still has publishing to do for `record`.
 *
 * Stacked: its branch is not pushed, or it has no pull request (each only
 * when the settings ask for it). Merge-as-you-go: it is not merged, and swarm
 * has not yet decided to leave its pull request open (a pull request plus a
 * reason). A goal whose branch never got pushed or never got a pull request
 * is pending in both modes. One left open on purpose (its gate failed, a skip
 * label) is not; one left open for a reason swarm can retry (a conflict, a base
 * that kept moving, a refusal) is, until MERGE_PRS_MAX_ATTEMPTS attempts in all.
 */
export function isPublicationPending(record: GoalPublication, settings: PublicationSettings): boolean {
  if (record.mode === "merge") {
    if (record.merged) return false;
    if (!(record.pr_url && record.left_open_reason)) return true;
    return record.left_open_kind !== undefined && RETRYABLE_LEFT_OPEN_KINDS.has(record.left_open_kind) && (record.merge_attempts ?? 1) < MERGE_PRS_MAX_ATTEMPTS;
  }
  return (settings.autoPush && !record.pushed) || (settings.openPr && !record.pr_url);
}

/** The `mode` records still to publish, in the order their goals finished. */
export function pendingPublications(
  records: readonly GoalPublication[],
  mode: GoalPublication["mode"],
  settings: PublicationSettings,
): GoalPublication[] {
  return records.filter((r) => r.mode === mode && isPublicationPending(r, settings));
}

/**
 * Where a resumed stacked run builds its first goal: the newest stacked
 * goal's branch, while that stack is still open — some of its goals are yet
 * to be published, or the previous run stopped in the middle of a goal (which
 * was built on that branch). Otherwise null: the stack starts again from the
 * base branch.
 */
export function resumeStackHead(
  records: readonly GoalPublication[],
  opts: { interrupted: boolean; settings: PublicationSettings },
): string | null {
  const stacked = records.filter((r) => r.mode === "stack");
  if (stacked.length === 0) return null;
  const open = opts.interrupted || stacked.some((r) => isPublicationPending(r, opts.settings));
  return open ? stacked[stacked.length - 1].branch : null;
}

/** Where the records are kept (the orchestrator, which saves them). */
export interface PublicationStore {
  getGoalPublications(): GoalPublication[];
  updateGoalPublication(goalId: string, patch: Partial<Omit<GoalPublication, "goal_id">>): void;
}

/**
 * Keep the records in step with what source control reports: a pushed branch,
 * an opened pull request, a merge, a pull request left open. Driven by events
 * so a step is recorded the moment it happens, even when a later step in the
 * same call fails. Returns a function that detaches the listeners.
 */
export function trackGoalPublications(bus: ISwarmEventBus, store: PublicationStore): () => void {
  const onPushed = (e: SwarmEventMap["source_control:branch_pushed"]) => {
    for (const r of store.getGoalPublications()) {
      if (r.branch === e.branch && !r.pushed) store.updateGoalPublication(r.goal_id, { pushed: true });
    }
  };
  const onPrCreated = (e: SwarmEventMap["source_control:pr_created"]) => {
    if (e.prUrl) store.updateGoalPublication(e.goalId, { pr_url: e.prUrl });
  };
  const onMerged = (e: SwarmEventMap["source_control:pr_merged"]) => {
    store.updateGoalPublication(e.goalId, { merged: true, ...(e.prUrl ? { pr_url: e.prUrl } : {}) });
  };
  const onSkipped = (e: SwarmEventMap["source_control:merge_skipped"]) => {
    // Without a pull request nothing was decided: the goal stays pending.
    if (!e.prUrl) return;
    const attempts = (store.getGoalPublications().find((r) => r.goal_id === e.goalId)?.merge_attempts ?? 0) + 1;
    store.updateGoalPublication(e.goalId, { pr_url: e.prUrl, left_open_reason: e.reason, ...(e.kind ? { left_open_kind: e.kind } : {}), merge_attempts: attempts });
  };
  bus.on("source_control:branch_pushed", onPushed);
  bus.on("source_control:pr_created", onPrCreated);
  bus.on("source_control:pr_merged", onMerged);
  bus.on("source_control:merge_skipped", onSkipped);
  return () => {
    bus.off("source_control:branch_pushed", onPushed);
    bus.off("source_control:pr_created", onPrCreated);
    bus.off("source_control:pr_merged", onMerged);
    bus.off("source_control:merge_skipped", onSkipped);
  };
}

/** A merge-mode record as the goal SourceControlManager.mergeGoal takes. */
export function mergeableFromPublication(record: GoalPublication): MergeableGoal {
  return {
    goalId: record.goal_id,
    goalDescription: record.description,
    ...(record.url ? { goalUrl: record.url } : {}),
    branch: record.branch,
    // A record without verdicts is not eligible to merge; its PR still opens.
    verdicts: record.verdicts ?? ["no verdict recorded"],
    ...(record.labels ? { labels: record.labels } : {}),
    ...(record.left_for_person?.length ? { leftForPerson: record.left_for_person } : {}),
    // A retry asks the code host what became of this pull request before anything else.
    ...(record.pr_url ? { prUrl: record.pr_url } : {}),
    ...(record.left_open_reason ? { lastLeftOpenReason: record.left_open_reason } : {}),
  };
}

/** A stack-mode record as the goal SourceControlManager.onGoalComplete takes. */
export function completedFromPublication(record: GoalPublication): CompletedGoal {
  return {
    goalId: record.goal_id,
    goalDescription: record.description,
    ...(record.url ? { goalUrl: record.url } : {}),
    ...(record.base ? { base: record.base } : {}),
    ...(record.left_for_person?.length ? { leftForPerson: record.left_for_person } : {}),
  };
}
