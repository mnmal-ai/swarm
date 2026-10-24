/**
 * Per-goal stacked-PR bookkeeping for `swarm run`'s goal loop.
 *
 * Extracted from run.ts so the goal loop's stack decisions — which branch a
 * goal's commits land on, and whether a completed goal is handed to the
 * end-of-run push+PR step — are testable against a real git repo without
 * driving the whole orchestrator.
 */

import { execFile } from "node:child_process";
import type { GoalPublication, LeftForPersonGroup } from "@mnmal-ai/swarm-types";
import { completedFromPublication, goalBranchName, materializeGoalBranch, resolveStackBase } from "@mnmal-ai/swarm-orchestrator";

/** A completed goal queued for the stacked push, in completion (= stack) order. */
export interface CompletedGoalRef {
  goalId: string;
  goalDescription: string;
  goalUrl?: string;
  /** The branch the goal was built on; its PR targets it. */
  base?: string;
  /** What reviewers left for a person, listed in the PR body. */
  leftForPerson?: LeftForPersonGroup[];
}

/**
 * The stacked push's queue for a run that resumes: the goals earlier runs
 * finished but did not publish (`pending`, in the order they finished), then
 * this run's. A goal this run finished again is pushed once, as this run's.
 */
export function stackPushQueue(pending: readonly GoalPublication[], thisRun: readonly CompletedGoalRef[]): CompletedGoalRef[] {
  const again = new Set(thisRun.map((g) => g.goalId));
  const earlier = pending.filter((r) => r.mode === "stack" && !again.has(r.goal_id)).map(completedFromPublication);
  return [...earlier, ...thisRun];
}

/** Whether `branch` exists in `repoRoot` as a local branch. */
export function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot }, (err) => resolve(!err));
  });
}

export interface GoalDispatchPlanInput {
  /** `orchestrator.getMaxConcurrency()`. */
  maxConcurrency: number;
  /** Whether a WorktreeManager exists (worktrees enabled for this run). */
  hasWorktreeManager: boolean;
  stackPRs: boolean;
  repoRoot: string;
  branchPrefix: string;
  goalId: string;
  projectBaseBranch: string;
  /** `projectConfig.base_branch` as configured (may be undefined). */
  configuredBaseBranch: string | undefined;
  previousGoalBranch: string | null;
  log?: { info(msg: string): void; warn(msg: string): void };
}

export interface GoalDispatchPlan {
  /** True when tasks run in worktrees via dispatchParallel. */
  parallel: boolean;
  /** The goal's branch, or null when stack mode is off or it could not be made. */
  goalBranch: string | null;
  /** The branch the goal is built on. */
  stackBase: string;
  /** `baseBranch` for dispatchParallel (task worktrees branch off it). */
  dispatchBaseBranch: string | undefined;
}

/**
 * Decide how a goal is dispatched and, in stack mode, materialize its branch.
 *
 * Stack mode applies to BOTH dispatch modes. With worktrees (parallel), task
 * worktrees branch off the goal branch and auto-merge back into it. Without
 * worktrees (max_workers 1 / --no-worktrees) tasks run in the repo root, so
 * HEAD is switched onto the goal branch before the first task runs: the
 * worker then sees the stack base's tree, and commitLiveRepo commits there.
 * Skipping this on the sequential path is what left a single-worker run's
 * commits on the base branch with nothing queued for push.
 */
export async function prepareGoalDispatch(input: GoalDispatchPlanInput): Promise<GoalDispatchPlan> {
  const parallel = input.maxConcurrency > 1 && input.hasWorktreeManager;
  const stackBase = resolveStackBase({
    stackPRs: input.stackPRs,
    projectBaseBranch: input.projectBaseBranch,
    previousGoalBranch: input.previousGoalBranch,
  });
  let goalBranch: string | null = null;
  let dispatchBaseBranch: string | undefined = input.configuredBaseBranch;

  if (input.stackPRs) {
    goalBranch = goalBranchName(input.branchPrefix, input.goalId);
    try {
      await materializeGoalBranch(input.repoRoot, goalBranch, stackBase);
      if (!parallel) await switchBranch(input.repoRoot, goalBranch);
      dispatchBaseBranch = goalBranch;
      input.log?.info(`Stack: created '${goalBranch}' off '${stackBase}'${parallel ? "" : " (checked out)"}`);
      // The worker gets no PR hints: workers have no GitHub access, and stack
      // mode requires remote_pr (checked at startup), so swarm opens this
      // goal's PR at session end via SourceControlManager.onGoalComplete.
    } catch (err) {
      // Not a git repo, bad base ref, a dirty tree that blocks the switch…
      // Fall back to flat-base mode for THIS goal rather than crash the run;
      // the end-of-run step reports the goal as unstacked if it completes.
      input.log?.warn(
        `Stack: failed to create goal branch (${err instanceof Error ? err.message : String(err)}); falling back to base_branch for this goal`,
      );
      goalBranch = null;
    }
  }

  return { parallel, goalBranch, stackBase, dispatchBaseBranch };
}

/**
 * A goal that completed in stack mode but has no goal branch (its branch
 * could not be made), so the push+PR step cannot open a PR for it.
 */
export interface UnstackedGoalRef {
  goalId: string;
  goalDescription: string;
  /** The branch the goal's commits landed on, or null if unknown. */
  commitsOn: string | null;
  commitCount: number;
}

/** The stack pointer plus the goals queued for the end-of-run push step. */
export interface GoalStackLedger {
  previousGoalBranch: string | null;
  /** Completed goals whose work is on their goal branch, in stack order. */
  completed: CompletedGoalRef[];
  /** Completed goals that could not be stacked; reported at session end. */
  unstacked: UnstackedGoalRef[];
}

export function createGoalStackLedger(): GoalStackLedger {
  return { previousGoalBranch: null, completed: [], unstacked: [] };
}

/**
 * Advance the stack pointer once per completed goal and queue it for the
 * push+PR step. A non-completed goal retains the previous pointer. A goal
 * that completed in stack mode without a goal branch is recorded as
 * unstacked, with where its commits went, so it is reported rather than
 * silently left out of the push.
 */
export async function recordGoalOutcomeForStack(
  ledger: GoalStackLedger,
  input: {
    stackPRs: boolean;
    goalBranch: string | null;
    goalStatus: string;
    goal: CompletedGoalRef;
    commitCount: number;
    /** Resolved only for an unstacked goal. */
    commitsOn: () => Promise<string | null>;
  },
): Promise<void> {
  if (!input.stackPRs || input.goalStatus !== "completed") return;
  if (input.goalBranch) {
    ledger.previousGoalBranch = input.goalBranch;
    ledger.completed.push(input.goal);
    return;
  }
  ledger.unstacked.push({
    goalId: input.goal.goalId,
    goalDescription: input.goal.goalDescription,
    commitsOn: await input.commitsOn(),
    commitCount: input.commitCount,
  });
}

/**
 * Where a goal without a goal branch committed: worktree tasks merge into the
 * dispatch base branch; sequential tasks commit on the repo root's HEAD.
 */
export async function whereGoalCommitsLanded(plan: GoalDispatchPlan, repoRoot: string): Promise<string | null> {
  if (plan.parallel && plan.dispatchBaseBranch) return plan.dispatchBaseBranch;
  return currentBranchName(repoRoot);
}

function switchBranch(repoRoot: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["switch", branch], { cwd: repoRoot }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git switch ${branch} failed: ${String(stderr).trim() || err.message}`));
      else resolve();
    });
  });
}

/** HEAD's branch name in `repoRoot`, or null (detached / not a repo). */
export function currentBranchName(repoRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }, (err, stdout) => {
      if (err) return resolve(null);
      const name = String(stdout).trim();
      resolve(name && name !== "HEAD" ? name : null);
    });
  });
}
