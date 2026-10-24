/**
 * Goal-level dependency gating for the orchestrator.
 *
 * Pure function that determines which pending goals can execute based on
 * their dependsOn declarations. Goals whose dependencies haven't completed
 * are blocked.
 */

import type { Goal } from "@mnmal-ai/swarm-types";
import { SUCCESS_GOAL_STATUSES } from "@mnmal-ai/swarm-types";

/**
 * Given a list of goals (some completed, some pending), return which
 * pending goals can execute and which are blocked by incomplete dependencies.
 *
 * A goal whose own `status === "blocked"` is a hard skip: it is placed in
 * `skipped` (with reason "goal status is blocked") regardless of its
 * dependency state, before any dependency-based routing. The orchestrator
 * must not decompose or dispatch such a goal (zero LLM calls). Re-attempts
 * flip a goal back to "pending" upstream before it reaches this filter, so
 * this branch only fires for goals still blocked at filter time.
 *
 * When `skipBlockedGoals` is true, *non-blocked* goals whose dependencies have
 * failed (a dependency is "blocked" with unmet deps of its own) are placed in
 * `skipped` (reason "dependency failed") instead of `blocked`. This lets the
 * orchestrator continue with independent goals rather than stopping when a
 * dependency fails.
 *
 * `skipReasons` maps each skipped goal's id to a one-line reason so callers
 * (the CLI) can surface why a goal was skipped.
 */
export function getExecutableGoals(
  goals: Goal[],
  skipBlockedGoals = false,
): {
  executable: Goal[];
  blocked: Goal[];
  skipped: Goal[];
  skipReasons: Record<string, string>;
} {
  // A literal `status === "completed"` check undercounts
  // here just like it did in cli/run.ts. Goals that ended a lifecycle in
  // `completed_with_notes` or `completed_with_deferrals` (the two
  // reviewer/arbiter-issued terminal-done variants) were not landing in
  // `completedIds`, so any downstream goal's `dependsOn` check against them
  // failed and the dependent goal was placed in `blocked` — even though the
  // dependency had genuinely completed. Use SUCCESS_GOAL_STATUSES so all
  // three terminal-done variants count as completed dependencies.
  const completedIds = new Set(
    goals.filter((g) => SUCCESS_GOAL_STATUSES.has(g.status)).map((g) => g.id),
  );
  // Goals that have failed: "blocked" status AND have unmet dependencies.
  // This set governs whether a *dependent* goal gets skipped (its dependency
  // failed), independent of the own-status hard skip above. Guard for
  // non-empty dependsOn — a blocked goal with no dependencies did not fail a
  // dependency, so it does not cause its dependents to be skipped.
  const failedIds = new Set(
    goals
      .filter((g) =>
        g.status === "blocked" &&
        g.dependsOn != null &&
        g.dependsOn.length > 0 &&
        !g.dependsOn.every((dep) => completedIds.has(dep)),
      )
      .map((g) => g.id),
  );
  const executable: Goal[] = [];
  const blocked: Goal[] = [];
  const skipped: Goal[] = [];
  const skipReasons: Record<string, string> = {};

  for (const goal of goals) {
    // Only pending and blocked goals are candidates; completed / in_progress /
    // terminal-done variants are already handled and never re-dispatched.
    if (goal.status !== "pending" && goal.status !== "blocked") continue;

    // swarm bug#3: a goal whose own status is "blocked" is an orchestrator-level
    // hard skip. It is removed from `executable` and placed in `skipped` BEFORE
    // any dependency evaluation, so it never reaches decomposition (zero LLM
    // calls) — regardless of whether its own dependencies are satisfied. This
    // takes precedence over dependency-based routing. A re-attempt resets the
    // goal to "pending" upstream before this filter runs, so this branch only
    // fires for goals that are still blocked at filter time.
    if (goal.status === "blocked") {
      skipped.push(goal);
      skipReasons[goal.id] = "goal status is blocked";
      continue;
    }

    const deps = goal.dependsOn ?? [];
    if (deps.every((dep) => completedIds.has(dep))) {
      executable.push(goal);
    } else if (skipBlockedGoals && deps.some((dep) => failedIds.has(dep))) {
      // A dependency failed and skip_blocked_goals is enabled — skip this goal
      skipped.push(goal);
      skipReasons[goal.id] = "dependency failed";
    } else {
      blocked.push(goal);
    }
  }
  return { executable, blocked, skipped, skipReasons };
}
