import { execFile } from "node:child_process";

/**
 * Stacked-PR helpers for the goal loop.
 *
 * When `source_control.stack_prs` is enabled, each goal in a multi-goal run
 * is built on top of the previous goal's branch instead of the project base
 * branch. This produces a chain of PRs that stack on each other
 * (goal-2's PR targets goal-1's branch as its base, etc.) rather than N
 * independent PRs that all target main and conflict pairwise.
 *
 * This module exposes:
 * - `resolveStackBase` — pure: what branch should goal N+1 be built on?
 * - `goalBranchName` — pure: the naming convention for a goal's persistent branch.
 * - `materializeGoalBranch` — git side-effect: create or repoint the branch.
 */

/**
 * Inputs that determine the base branch for the next goal's worktrees.
 *
 * `previousGoalBranch` is null on the first goal of a run, and also reset
 * to null after any goal that didn't complete successfully — we don't stack
 * follow-up goals on top of partial/broken work.
 */
export interface StackBaseInputs {
  stackPRs: boolean;
  projectBaseBranch: string;
  previousGoalBranch: string | null;
}

export function resolveStackBase(inputs: StackBaseInputs): string {
  if (!inputs.stackPRs) return inputs.projectBaseBranch;
  return inputs.previousGoalBranch ?? inputs.projectBaseBranch;
}

/**
 * Sanitize a goal id for use as part of a git ref. Mirrors the sanitization
 * inside WorktreeManager.create() but for the goal-level branch rather than
 * the per-task worktree branch.
 */
function sanitizeGoalId(goalId: string): string {
  if (!goalId) throw new Error("goalId must be a non-empty string");
  return goalId
    .replace(/[~^: \\?*[]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]/, "g")
    .toLowerCase();
}

/**
 * Compose the stable branch name for a goal.
 *
 * Goal branches outlive task worktrees so the next goal can reference them;
 * they are namespaced under `${branchPrefix}goal-${goalId}` so an operator
 * can `git branch --list "${branchPrefix}goal-*"` to see the whole stack.
 */
export function goalBranchName(branchPrefix: string, goalId: string): string {
  const prefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  return `${prefix}goal-${sanitizeGoalId(goalId.replace(/^goal-/i, ""))}`;
}

/**
 * Default value for the `stack_prs` config field. Exported so the CLI and
 * tests reference the same constant rather than duplicating `?? true`.
 */
export const STACK_PRS_DEFAULT = false;

/**
 * Materialize (or re-point) the per-goal branch in the main repo.
 *
 * If the branch already exists and is a descendant of `base` (i.e. task work
 * was already merged into it during a prior pass of the same session), the
 * branch is left untouched — we never destroy partial work from a resumed
 * session. Otherwise `git branch -f` repoints the branch to `base` so a
 * fresh attempt always starts from the right commit.
 *
 * Throws if the underlying git call fails (not a git repo, base ref doesn't
 * exist, permission denied, etc.). Callers in the goal loop are expected to
 * catch and fall back to non-stack mode for that goal, not crash the whole
 * run.
 */
export async function materializeGoalBranch(
  repoRoot: string,
  goalBranch: string,
  base: string,
): Promise<void> {
  // Check whether goalBranch already descends from base. If it does, partial
  // task work that was merged in is preserved. The check also returns false
  // when goalBranch doesn't exist yet, so we fall through to create it.
  const isAncestor = await new Promise<boolean>((resolve) => {
    execFile("git", ["merge-base", "--is-ancestor", base, goalBranch], { cwd: repoRoot }, (err) => {
      resolve(!err);
    });
  });

  if (isAncestor) return;

  await new Promise<void>((resolveP, rejectP) => {
    execFile("git", ["branch", "-f", goalBranch, base], { cwd: repoRoot }, (err) => {
      if (err) rejectP(err);
      else resolveP();
    });
  });
}
