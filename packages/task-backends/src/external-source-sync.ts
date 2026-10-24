import type {
  SwarmEventMap,
  ExternalTaskSource,
  ISwarmEventBus,
  LeftForPersonGroup,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoalLifecycleSyncOptions {
  /** The source's external ID for a goal, or undefined when the goal did not
   *  come from this source. */
  externalIdFor: (goalId: string) => string | undefined;
  /** Called when the source rejects an update. Syncing is best-effort: a
   *  failure is reported here and never interrupts the run. */
  onError?: (err: unknown, event: keyof SwarmEventMap) => void;
  /** source_control.merge_prs is on: each goal's PR opens, and may merge, as
   *  soon as the goal is done. `afterMerge` "done" moves a merged goal's item
   *  to the source's merged status; "review" leaves it where the PR put it. */
  mergePrs?: { afterMerge: "done" | "review" };
}

// ---------------------------------------------------------------------------
// syncGoalLifecycle — mirror goal progress onto the external source
// ---------------------------------------------------------------------------

/**
 * Subscribe to the run's goal events and mirror them onto the external item
 * each goal came from:
 *
 *   goal:start               -> in_progress, with a comment
 *   task:escalated           -> a comment naming the task and the reason code
 *   goal:completed (partial) -> a comment, then failed
 *   goal:completed (all)     -> a comment only; review waits for the PR
 *   source_control:pr_created -> a comment with the PR URL, then completed
 *   source_control:pr_merged  -> a comment naming the merge commit, then
 *                                merged (unless mergePrs.afterMerge is "review")
 *   source_control:merge_skipped -> a comment with swarm's reason
 *   goal:left_for_person     -> a comment listing what reviewers left for a person
 *   run:login_expired        -> a comment, then the item goes back to the queue
 *
 * An item is handed to review only once its pull request exists, so a run
 * that ends without opening one leaves the item in progress, not in review.
 *
 * Comments carry swarm's own status text — never worker output, which can
 * hold code, fixtures or data the tracker is not approved to hold. The one
 * exception is the reviewers' list of items left for a person: one line each,
 * cut short, because a person has to act on them. The detail stays in the
 * run log.
 *
 * Returns a function that detaches every handler.
 */
export function syncGoalLifecycle(
  bus: ISwarmEventBus,
  source: ExternalTaskSource,
  options: GoalLifecycleSyncOptions,
): () => void {
  const { externalIdFor, onError, mergePrs } = options;
  const startedGoalIds: string[] = [];

  // Each item's updates run one after another, in event order. Source calls
  // take real time (a CLI round-trip each), so without this a later event's
  // update could land before an earlier one's and leave the item in the
  // wrong state — Blocked after Review, say.
  const queues = new Map<string, Promise<void>>();

  const guard = (id: string, event: keyof SwarmEventMap, work: () => Promise<void>) => {
    const run = async () => {
      try {
        await work();
      } catch (err) {
        onError?.(err, event);
      }
    };
    const previous = queues.get(id) ?? Promise.resolve();
    queues.set(id, previous.then(run, run));
  };

  const onGoalStart = (e: SwarmEventMap["goal:start"]) => {
    const id = externalIdFor(e.goalId);
    if (!id) return;
    startedGoalIds.push(e.goalId);
    guard(id, "goal:start", async () => {
      await source.updateStatus(id, "in_progress");
      await source.postComment(id, `Swarm started this card: ${e.taskCount} tasks planned.`);
    });
  };

  const onTaskEscalated = (e: SwarmEventMap["task:escalated"]) => {
    // Task IDs are prefixed with their goal's ID; take the longest match.
    const goalId = startedGoalIds
      .filter((g) => e.taskId.startsWith(`${g}-`))
      .sort((a, b) => b.length - a.length)[0];
    const id = goalId ? externalIdFor(goalId) : undefined;
    if (!id) return;
    guard(id, "task:escalated", () =>
      source.postComment(id, `Task ${e.taskId} escalated (${e.reason}). The detail is in the run log, not on this card.`),
    );
  };

  const onGoalCompleted = (e: SwarmEventMap["goal:completed"]) => {
    const id = externalIdFor(e.goalId);
    if (!id) return;
    const tally = `${e.completedTasks} of ${e.totalTasks} tasks`;
    guard(id, "goal:completed", async () => {
      if (e.completedTasks < e.totalTasks) {
        await source.postComment(id, `Swarm stopped: ${tally} completed. The rest need a person; see the run log.`);
        await source.updateStatus(id, "failed");
      } else {
        await source.postComment(
          id,
          mergePrs
            ? `Swarm finished ${tally}. The pull request follows now.`
            : `Swarm finished ${tally}. The pull request follows at the end of the run.`,
        );
      }
    });
  };

  const onPrCreated = (e: SwarmEventMap["source_control:pr_created"]) => {
    const id = externalIdFor(e.goalId);
    if (!id) return;
    guard(id, "source_control:pr_created", async () => {
      await source.postComment(id, `Pull request opened: ${e.prUrl}`);
      await source.updateStatus(id, "completed");
    });
  };

  const onPrMerged = (e: SwarmEventMap["source_control:pr_merged"]) => {
    const id = externalIdFor(e.goalId);
    if (!id) return;
    guard(id, "source_control:pr_merged", async () => {
      const commit = e.mergeCommit ? ` as ${e.mergeCommit.slice(0, 12)}` : "";
      await source.postComment(id, `Pull request merged into ${e.base}${commit}: ${e.prUrl}`);
      if (mergePrs?.afterMerge !== "review") await source.updateStatus(id, "merged");
    });
  };

  const onMergeSkipped = (e: SwarmEventMap["source_control:merge_skipped"]) => {
    const id = externalIdFor(e.goalId);
    if (!id) return;
    guard(id, "source_control:merge_skipped", () =>
      source.postComment(id, `Swarm did not merge ${e.prUrl ?? "this card's work"}: ${e.reason}.`),
    );
  };

  const onLeftForPerson = (e: SwarmEventMap["goal:left_for_person"]) => {
    const id = externalIdFor(e.goalId);
    if (!id || e.groups.length === 0) return;
    guard(id, "goal:left_for_person", () => source.postComment(id, formatLeftForPersonComment(e.groups)));
  };

  const onLoginExpired = (e: SwarmEventMap["run:login_expired"]) => {
    // Only a goal swarm started (and so moved) goes back; one still being
    // planned never left the queue.
    if (!e.goalId || !startedGoalIds.includes(e.goalId)) return;
    const id = externalIdFor(e.goalId);
    if (!id) return;
    guard(id, "run:login_expired", async () => {
      await source.postComment(id, "Swarm stopped: its Claude login expired. This card goes back to the queue; re-running swarm after logging in picks it up again.");
      await source.returnToQueue?.(id);
    });
  };

  bus.on("goal:start", onGoalStart);
  bus.on("goal:left_for_person", onLeftForPerson);
  bus.on("run:login_expired", onLoginExpired);
  bus.on("source_control:pr_merged", onPrMerged);
  bus.on("source_control:merge_skipped", onMergeSkipped);
  bus.on("task:escalated", onTaskEscalated);
  bus.on("goal:completed", onGoalCompleted);
  bus.on("source_control:pr_created", onPrCreated);

  return () => {
    bus.off("goal:start", onGoalStart);
    bus.off("goal:left_for_person", onLeftForPerson);
    bus.off("run:login_expired", onLoginExpired);
    bus.off("source_control:pr_merged", onPrMerged);
    bus.off("source_control:merge_skipped", onMergeSkipped);
    bus.off("task:escalated", onTaskEscalated);
    bus.off("goal:completed", onGoalCompleted);
    bus.off("source_control:pr_created", onPrCreated);
  };
}

/** Most items a source-item comment lists; the pull request has them all. */
const COMMENT_MAX_ITEMS = 20;
/** Longest item a source-item comment shows. */
const COMMENT_MAX_ITEM_CHARS = 300;

/**
 * The source-item comment for what reviewers left for a person: a count, then
 * each task and its items. Long lists and long items are cut; the goal's pull
 * request lists them in full.
 */
export function formatLeftForPersonComment(groups: readonly LeftForPersonGroup[]): string {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const lines = [`Left for a person: the reviewers passed this card's work but left ${total} item${total === 1 ? "" : "s"} for a person.`];
  let shown = 0;
  for (const group of groups) {
    if (shown >= COMMENT_MAX_ITEMS) break;
    lines.push("", `${group.task}:`);
    for (const item of group.items) {
      if (shown >= COMMENT_MAX_ITEMS) break;
      const text = [...item].length > COMMENT_MAX_ITEM_CHARS ? `${[...item].slice(0, COMMENT_MAX_ITEM_CHARS - 1).join("")}…` : item;
      lines.push(`- ${text}`);
      shown++;
    }
  }
  if (shown < total) lines.push("", `…and ${total - shown} more; the pull request lists them all.`);
  return lines.join("\n");
}
