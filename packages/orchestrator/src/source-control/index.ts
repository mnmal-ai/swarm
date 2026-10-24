/**
 * SourceControlManager — Configurable branching strategy for worktree persistence.
 *
 * When the orchestrator creates worktrees for parallel task execution, completed
 * work is ephemeral by default — worktrees are destroyed and no branches survive.
 *
 * This module lets callers configure how completed work persists:
 * - "ephemeral": No-op. Current behavior.
 * - "local_branch": Creates a session branch that accumulates all goal work.
 *   Worktree merges target the session branch instead of the base branch.
 * - "remote_pr": Like local_branch, but pushes the branch and optionally opens
 *   a PR via `gh` CLI when a goal completes.
 *
 * Given a GitHubCredential (source_control.github_account), `gh` runs and
 * pushes to an HTTPS GitHub remote are made as that account: its token goes in
 * those calls' env only. Without one, gh's active account is used as before.
 */

import { execFile } from "node:child_process";
import type { SourceControlConfig, ISwarmEventBus, GitHubCredential, MergePrsGateConfig, LeftForPersonGroup, LeftOpenKind } from "@mnmal-ai/swarm-types";
import type { MergeQueue, MergeTurn } from "./merge-lock.js";
import { MERGE_PRS_DEFAULT_MAX_ROUNDS, MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS } from "./commit-policy.js";
import { gitIdentityEnvVars } from "@mnmal-ai/swarm-types";
import type { CodeHost } from "./code-host.js";
import { GitHubCodeHost } from "./github-host.js";
import { RETRYABLE_LEFT_OPEN_KINDS } from "./publications.js";
import { resolveStackBase, goalBranchName, materializeGoalBranch } from "./stack.js";
import { mergeEligibility, redactGateOutput, runMergeGate } from "./merge.js";

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** GitHub rejects pull request titles longer than this many characters. */
export const GITHUB_PR_TITLE_MAX = 256;

/**
 * The PR title for a goal: `swarm: <description>` on one line, whole when it
 * fits GitHub's title limit, otherwise cut at the last word boundary that
 * fits and ended with an ellipsis. Never cut mid-word unless a single word
 * is itself longer than the limit.
 */
export function formatPrTitle(goalDescription: string): string {
  const title = `swarm: ${goalDescription.replace(/\s+/g, " ").trim()}`;
  const chars = [...title]; // code points, not UTF-16 units
  if (chars.length <= GITHUB_PR_TITLE_MAX) return title;
  const room = chars.slice(0, GITHUB_PR_TITLE_MAX - 1).join(""); // leave 1 for "…"
  const nextIsSpace = chars[GITHUB_PR_TITLE_MAX - 1] === " ";
  const lastSpace = room.lastIndexOf(" ");
  const cut = nextIsSpace || lastSpace <= "swarm:".length ? room : room.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

/** "Source: <url>\n" when the goal came from a ticket, else "". */
function sourceLine(goal: CompletedGoal): string {
  return goal.goalUrl ? `Source: ${goal.goalUrl}\n` : "";
}

/**
 * The PR body's "Left for a person" section: each task the reviewers passed
 * with items left for a person, and those items. "" when there are none, so
 * a goal without deferrals gets the same body as before.
 */
export function leftForPersonSection(groups: readonly LeftForPersonGroup[] | undefined): string {
  const listed = (groups ?? []).filter((g) => g.items.length > 0);
  if (listed.length === 0) return "";
  const lines = ["", "", "## Left for a person", "", "Reviewers passed this work but left these items for a person:"];
  for (const group of listed) {
    lines.push("", `**${prBodyText(group.task)}**`);
    for (const item of group.items) lines.push(`- ${prBodyText(item)}`);
  }
  return lines.join("\n");
}

/** Longest task title or item a PR body shows. */
const PR_BODY_ITEM_MAX = 500;

/**
 * Model-written text made safe for a PR body: one line, cut to a readable
 * length, with no @mention that would notify anyone, no HTML, and no markdown
 * that could break out of its list item.
 */
function prBodyText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const cut = [...line].length > PR_BODY_ITEM_MAX ? `${[...line].slice(0, PR_BODY_ITEM_MAX - 1).join("")}…` : line;
  return cut
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=\w)/g, "@\u200b")
    .replace(/([*_`[\]])/g, "\\$1");
}

/** A goal that finished and should be persisted to a branch + PR. */
export interface CompletedGoal {
  goalId: string;
  goalDescription: string;
  /** Link to the ticket the goal came from; named in the PR body. */
  goalUrl?: string;
  /** Stacked PRs: the branch the goal was built on. Its PR targets it, rather
   *  than the previous goal in the list (a goal finished in an earlier run
   *  was built on whatever was the stack's head then). */
  base?: string;
  /** What reviewers left for a person, listed in the PR body. */
  leftForPerson?: LeftForPersonGroup[];
}

/** Per-goal outcome of the push+PR step. */
export interface GoalPushResult {
  goalId: string;
  /** The branch the goal's work was materialized onto. */
  branch: string;
  /** The base the goal's PR targets (previous goal's head, or stack root). */
  base: string;
  /** True iff the branch was pushed to the remote (not left local-only). */
  pushed: boolean;
  /** The opened PR URL, if a PR was created. */
  prUrl?: string;
}

/**
 * Result of {@link SourceControlManager.onGoalComplete}.
 *
 * `pushed`/`prUrl` retain the single-goal shape callers depended on
 * (top-of-stack PR for stacked runs). `goals` is the per-goal breakdown that
 * makes the stacked-PR chain observable and testable.
 */
export interface OnGoalCompleteResult {
  pushed: boolean;
  prUrl?: string;
  goals: GoalPushResult[];
}

/** A done goal handed to {@link SourceControlManager.mergeGoal}. */
export interface MergeableGoal extends CompletedGoal {
  /** The goal's branch, holding its commits. */
  branch: string;
  /** The final review verdict of each of the goal's tasks. */
  verdicts: string[];
  /** The source item's labels. */
  labels?: string[];
  /** The pull request an earlier attempt opened and left open. A retry asks
   *  the code host what became of it first, and never opens another. */
  prUrl?: string;
  /** Why the earlier attempt left it open; the same reason is not commented again. */
  lastLeftOpenReason?: string;
}

/** Settings for {@link SourceControlManager.mergeGoal}. */
export interface MergeGoalOptions {
  gate: MergePrsGateConfig;
  skipLabels: readonly string[];
  /** One merge per repository and base at a time. Absent: no turn-taking. */
  queue?: MergeQueue;
  /** This project's name, shown to other runs while it holds the turn. */
  project?: string;
  /** Rounds before leaving the PR open because the base kept moving. */
  maxRounds?: number;
  /** How long to wait for GitHub to compute mergeability. Default 60 s. */
  mergeableWaitMs?: number;
  /** How often to ask while waiting. Default 2 s. */
  mergeablePollMs?: number;
  /** Hands a conflict with the base back to a worker (Task 6). Absent: a conflict leaves the PR open. */
  resolveConflict?: ConflictResolver;
  /** How many hand-backs one merge may make. Default 2. */
  maxConflictRounds?: number;
}

/** What happened to one goal under source_control.merge_prs. */
export interface MergeGoalResult {
  goalId: string;
  branch: string;
  base: string;
  prUrl?: string;
  merged: boolean;
  /** The merge commit on the base branch, when merged. */
  mergeCommit?: string;
  /** Why the PR was left open, when not merged. Swarm's own text. */
  reason?: string;
  /** The underlying error, when a step failed: redacted, for the run log only
   *  (never posted on the PR or the source item). */
  error?: string;
  /** The merge gate's outcome, when it ran. */
  gate?: { passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; tail: string };
  /** Why it was left open, as a kind: decides whether a later run retries. */
  kind?: LeftOpenKind;
  /** Rounds the merge took (1 when nothing moved). */
  rounds?: number;
  /** Time spent waiting for the repository's merge turn. */
  waitedMs?: number;
  /** Conflicts a worker resolved before the merge. */
  conflictsResolved?: number;
  /** Set when the merge queue could not be used and the merge ran without a turn. */
  queueWarning?: string;
}

/** Options for {@link SourceControlManager}. */
export interface SourceControlManagerOptions {
  /** The account swarm's own GitHub operations run as (from
   *  source_control.github_account). Absent: gh's active account. Used to
   *  build the default GitHub code host. */
  github?: GitHubCredential;
  /** Where pull requests live. Default: GitHub through `gh`, as `github`. */
  codeHost?: CodeHost;
}

/** What a worker needs to resolve a conflict with the base. */
export interface ConflictContext {
  goalId: string;
  goalDescription: string;
  branch: string;
  base: string;
  remote: string;
  /** Files git could not merge. */
  files: string[];
  /** Commits on the base, since the branch's merge base, that touched those files. Newest first, at most 20. */
  baseCommits: Array<{ sha: string; subject: string }>;
}
export type ConflictResolver = (ctx: ConflictContext) => Promise<{ resolved: boolean; reason?: string }>;

/** One round's outcome inside mergeGoal. */
type Attempt =
  | { kind: "merged"; mergeCommit?: string }
  | { kind: "retry"; why: "base_moved" | "refused"; error?: unknown }
  | { kind: "conflict"; files: string[]; error: unknown }
  | { kind: "leave"; reason: string; leaveKind: LeftOpenKind; error?: unknown };


export class SourceControlManager {
  private readonly config: SourceControlConfig;
  private readonly repoRoot: string;
  private readonly eventBus?: ISwarmEventBus;
  /** Where pull requests live: GitHub unless the options name another host. */
  private readonly host: CodeHost;
  private sessionBranch: string | null = null;
  private _pushed = false;
  /** Head of the most-recently-pushed goal branch, so a goal completing in a
   *  later onGoalComplete() call stacks on top of an earlier goal's branch
   *  even when goals are reported one call at a time. */
  private lastStackHead: string | null = null;

  constructor(repoRoot: string, config: SourceControlConfig, eventBus?: ISwarmEventBus, options: SourceControlManagerOptions = {}) {
    this.config = { ...config, strategy: config.strategy ?? "ephemeral" };
    this.repoRoot = repoRoot;
    this.eventBus = eventBus;
    this.host = options.codeHost ?? new GitHubCodeHost(repoRoot, options.github);
  }

  /** Get the configured strategy. */
  getStrategy(): SourceControlConfig["strategy"] {
    return this.config.strategy;
  }

  /**
   * Create a session branch that accumulates all goal work.
   * Called once at the start of an orchestration run.
   * For "ephemeral" strategy, this is a no-op.
   */
  async createSessionBranch(sessionId: string): Promise<string | null> {
    if (this.config.strategy === "ephemeral") return null;

    const rawPrefix = this.config.branch_prefix ?? "swarm/";
    const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
    const date = new Date().toISOString().slice(0, 10);
    // The whole session id: run ids share a "run-<project>-" prefix and only
    // their random tail is unique, so a truncated id gave every run of a
    // project on the same day the same branch, and the second run's push failed.
    // Sanitize: remove invalid git ref characters, collapse runs of dots/slashes
    this.sessionBranch = `${prefix}session-${date}-${sessionId}`
      .replace(/[~^: \\]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/\/{2,}/g, "/")
      .replace(/^-/, "s-");

    const baseBranch = this.config.base_branch ?? "main";
    if (await this.branchExists(this.sessionBranch)) {
      // The name is unique per run, so an existing branch is this run's own,
      // left by an interrupted attempt: continue on it rather than fail.
      await this.git(["checkout", this.sessionBranch]);
    } else {
      await this.git(["checkout", "-b", this.sessionBranch, baseBranch]);
    }

    this.eventBus?.emit("source_control:branch_created", {
      branch: this.sessionBranch,
      strategy: this.config.strategy,
      timestamp: Date.now(),
    });

    return this.sessionBranch;
  }

  /** Get the session branch name, if created. */
  getSessionBranch(): string | null {
    return this.sessionBranch;
  }

  /**
   * After goals complete, push their work and optionally open PRs.
   *
   * For "ephemeral" / "local_branch": no push, no PR.
   *
   * For "remote_pr" with `stack_prs` enabled, this is an explicit per-goal
   * loop: each goal gets its own branch (materialized on top of the previous
   * goal's head, the first goal on the stack root), that branch is pushed, and
   * a PR is opened whose base is the previous goal's head. Each iteration
   * asserts the branch was pushed and the PR was opened — if any goal in the
   * chain would land local-only, a clear error is thrown rather than silently
   * dropping it. (Fixes the bug where a multi-goal stacked run produced only
   * one PR for the whole session branch.)
   *
   * For "remote_pr" without `stack_prs`, the legacy single-session-branch push
   * is preserved.
   *
   * Accepts either a single goal (`goalId`, `goalDescription`) or an ordered
   * list of completed goals. The function only touches `git`/`gh` via the
   * instance's exec surface, so it can be exercised against a stub gh client.
   */
  async onGoalComplete(goalId: string, goalDescription: string): Promise<OnGoalCompleteResult>;
  async onGoalComplete(goals: CompletedGoal[]): Promise<OnGoalCompleteResult>;
  async onGoalComplete(
    arg1: string | CompletedGoal[],
    goalDescription?: string,
  ): Promise<OnGoalCompleteResult> {
    const goals: CompletedGoal[] =
      typeof arg1 === "string"
        ? [{ goalId: arg1, goalDescription: goalDescription ?? "" }]
        : arg1;

    // Stacked PRs push each goal's own branch, so they need no session
    // branch, and no checkout: a working tree a failed task left dirty
    // cannot keep finished goals from being pushed.
    if (this.config.strategy === "remote_pr" && this.config.stack_prs === true) {
      return this.pushGoalStack(goals);
    }

    if (this.config.strategy === "ephemeral" || !this.sessionBranch) {
      return { pushed: false, goals: [] };
    }

    if (this.config.strategy === "local_branch") {
      return { pushed: false, goals: [] };
    }

    // remote_pr strategy
    return this.pushSessionBranch(goals);
  }

  /**
   * remote_pr, stack_prs=true: push one branch + open one PR per goal, each
   * stacked on the previous goal's head. Throws a descriptive error the moment
   * any goal's branch fails to push or its PR fails to open, so a half-pushed
   * stack can never masquerade as success.
   */
  private async pushGoalStack(goals: CompletedGoal[]): Promise<OnGoalCompleteResult> {
    const remote = this.config.remote ?? "origin";
    const projectBaseBranch = this.config.base_branch ?? "main";
    const branchPrefix = this.config.branch_prefix ?? "swarm/";
    const autoPush = this.config.auto_push !== false;
    const openPr = this.config.pr_on_goal_complete !== false;

    const results: GoalPushResult[] = [];
    let previousGoalBranch: string | null = this.lastStackHead;

    for (const goal of goals) {
      const base = goal.base ?? resolveStackBase({ stackPRs: true, projectBaseBranch, previousGoalBranch });
      const branch = goalBranchName(branchPrefix, goal.goalId);

      // Create/repoint the goal's branch onto its stack base. Throws if the
      // base ref doesn't exist or the repo is in a bad state — we let that
      // propagate; a goal we can't even materialize must not be reported done.
      await materializeGoalBranch(this.repoRoot, branch, base);

      let pushed = false;
      if (autoPush) {
        try {
          await this.push(remote, branch);
        } catch (err) {
          throw new Error(
            `stack-pr: goal "${goal.goalId}" branch "${branch}" failed to push to "${remote}" ` +
              `and would land local-only: ${(err as Error).message}`,
          );
        }
        pushed = true;
        // Wedge-style guard: never advance the stack on an unpushed branch.
        if (!pushed) {
          throw new Error(
            `stack-pr: goal "${goal.goalId}" branch "${branch}" reported unpushed — refusing to leave it local-only`,
          );
        }
        this._pushed = true;
        this.eventBus?.emit("source_control:branch_pushed", { branch, remote, timestamp: Date.now() });
      }

      let prUrl: string | undefined;
      if (openPr) {
        if (!pushed) {
          throw new Error(
            `stack-pr: goal "${goal.goalId}" branch "${branch}" cannot open a PR because it was not pushed`,
          );
        }
        try {
          prUrl = await this.host.openChangeRequest({
            title: formatPrTitle(goal.goalDescription),
            body: `Automated stacked PR from swarm orchestrator.\n\nGoal: ${goal.goalId}\n${sourceLine(goal)}Base: ${base}\n\n${goal.goalDescription}${leftForPersonSection(goal.leftForPerson)}`,
            base,
            head: branch,
          });
        } catch (err) {
          throw new Error(
            `stack-pr: goal "${goal.goalId}" branch "${branch}" pushed but PR creation failed ` +
              `(base "${base}"): ${(err as Error).message}`,
          );
        }
        // Wedge-style guard: a pushed branch with no PR is the exact failure
        // mode this rewrite exists to catch.
        if (!prUrl) {
          throw new Error(
            `stack-pr: goal "${goal.goalId}" branch "${branch}" pushed but gh returned no PR URL ` +
              `(base "${base}") — goal would land local-only`,
          );
        }
        this.eventBus?.emit("source_control:pr_created", { branch, prUrl, goalId: goal.goalId, timestamp: Date.now() });
      }

      results.push({ goalId: goal.goalId, branch, base, pushed, prUrl });
      previousGoalBranch = branch;
      this.lastStackHead = branch;
    }

    const allPushed = autoPush ? results.every((r) => r.pushed) : false;
    const topPr = results.length > 0 ? results[results.length - 1].prUrl : undefined;
    return { pushed: allPushed, prUrl: topPr, goals: results };
  }

  /**
   * remote_pr, stack_prs=false (legacy): push the single session branch and
   * optionally open one PR targeting the base branch.
   */
  private async pushSessionBranch(goals: CompletedGoal[]): Promise<OnGoalCompleteResult> {
    const sessionBranch = this.sessionBranch as string;
    const remote = this.config.remote ?? "origin";
    const baseBranch = this.config.base_branch ?? "main";
    const primary = goals[0] ?? { goalId: "", goalDescription: "" };
    let pushed = false;

    if (this.config.auto_push !== false) {
      try {
        await this.push(remote, sessionBranch);
        pushed = true;
        this._pushed = true;
        this.eventBus?.emit("source_control:branch_pushed", {
          branch: sessionBranch,
          remote,
          timestamp: Date.now(),
        });
      } catch {
        return {
          pushed: false,
          goals: [{ goalId: primary.goalId, branch: sessionBranch, base: baseBranch, pushed: false }],
        };
      }
    }

    if (this.config.pr_on_goal_complete !== false && pushed) {
      try {
        const prUrl = await this.host.openChangeRequest({
          title: formatPrTitle(primary.goalDescription),
          body: `Automated PR from swarm orchestrator.\n\nGoal: ${primary.goalId}\n${sourceLine(primary)}\n${primary.goalDescription}`,
          base: baseBranch,
          head: sessionBranch,
        });

        this.eventBus?.emit("source_control:pr_created", {
          branch: sessionBranch,
          prUrl,
          goalId: primary.goalId,
          timestamp: Date.now(),
        });

        return {
          pushed,
          prUrl,
          goals: [{ goalId: primary.goalId, branch: sessionBranch, base: baseBranch, pushed, prUrl }],
        };
      } catch {
        return {
          pushed,
          goals: [{ goalId: primary.goalId, branch: sessionBranch, base: baseBranch, pushed }],
        };
      }
    }

    return {
      pushed,
      goals: [{ goalId: primary.goalId, branch: sessionBranch, base: baseBranch, pushed }],
    };
  }

  /**
   * After the entire session ends, push the final state if not already pushed.
   * Skips if a prior onGoalComplete already pushed successfully.
   */
  async onSessionEnd(): Promise<void> {
    if (this.config.strategy === "remote_pr" && this.sessionBranch && this.config.auto_push !== false && !this._pushed) {
      const remote = this.config.remote ?? "origin";
      try {
        await this.push(remote, this.sessionBranch);
        this._pushed = true;
      } catch {
        // Best effort
      }
    }
  }

  /**
   * source_control.merge_prs: bring the local base branch to the remote's, so
   * the next goal starts from everything merged so far. Fast-forward only:
   * a local base that has diverged is left alone and the call throws.
   */
  async syncBaseBranch(): Promise<void> {
    const remote = this.config.remote ?? "origin";
    const base = this.config.base_branch ?? "main";
    await this.fetch(remote, base);
    const remoteRef = `${remote}/${base}`;
    const current = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (current === base) {
      await this.git(["merge", "--ff-only", remoteRef]);
      return;
    }
    if (!(await this.branchExists(base))) {
      await this.git(["branch", base, remoteRef]);
      return;
    }
    try {
      await this.git(["merge-base", "--is-ancestor", base, remoteRef]);
    } catch {
      throw new Error(`local ${base} has commits that ${remoteRef} does not; swarm will not move it`);
    }
    await this.git(["branch", "-f", base, remoteRef]);
  }

  /**
   * source_control.merge_prs: push a done goal's branch, open its PR against
   * the base branch and, when the goal is eligible, merge the latest base
   * into the branch, run the merge gate, push, and merge the PR as the
   * configured account. Never throws: whatever fails, the PR (if opened) is
   * left open with a comment saying why, and the work repo is put back on the
   * base branch at the remote, so the next goal is unaffected.
   */
  async mergeGoal(goal: MergeableGoal, options: MergeGoalOptions): Promise<MergeGoalResult> {
    const remote = this.config.remote ?? "origin";
    const base = this.config.base_branch ?? "main";
    const result: MergeGoalResult = { goalId: goal.goalId, branch: goal.branch, base, merged: false };
    const leaveOpen = async (reason: string, kind?: LeftOpenKind, cause?: unknown): Promise<MergeGoalResult> => {
      result.reason = reason;
      if (kind) result.kind = kind;
      if (cause !== undefined) result.error = this.errorText(cause);
      // No comment on a closed pull request, nor the same reason twice.
      if (result.prUrl && kind !== "closed" && reason !== goal.lastLeftOpenReason) {
        try {
          const retried = kind !== undefined && RETRYABLE_LEFT_OPEN_KINDS.has(kind) ? " Swarm tries again on a later run; close this pull request to stop it." : "";
          await this.host.comment(result.prUrl, `Swarm left this pull request open: ${reason}.${retried}`);
        } catch {
          // The skip event below still carries the reason.
        }
      }
      await this.returnToBase(remote, base);
      this.eventBus?.emit("source_control:merge_skipped", {
        goalId: goal.goalId,
        branch: goal.branch,
        ...(result.prUrl ? { prUrl: result.prUrl } : {}),
        reason,
        ...(kind ? { kind } : {}),
        ...(result.error ? { error: result.error } : {}),
        timestamp: Date.now(),
      });
      return result;
    };

    // 0. A retry: what a person did to the pull request since decides. Merged:
    //    record it. Closed: leave it closed. Open: merge that one, never another.
    if (goal.prUrl) {
      result.prUrl = goal.prUrl;
      let view: Awaited<ReturnType<CodeHost["viewChangeRequest"]>>;
      try {
        view = await this.host.viewChangeRequest(goal.prUrl);
      } catch (err) {
        return leaveOpen("swarm could not read the pull request's state; it tries again later", "refused", err);
      }
      if (view.state === "MERGED") {
        result.merged = true;
        if (view.mergeCommit) result.mergeCommit = view.mergeCommit;
        this.eventBus?.emit("source_control:pr_merged", { goalId: goal.goalId, branch: goal.branch, prUrl: goal.prUrl, mergeCommit: view.mergeCommit ?? "", base, timestamp: Date.now() });
        return result;
      }
      if (view.state === "CLOSED") return leaveOpen("a person closed the pull request; swarm leaves it closed", "closed");
      if (view.state !== "OPEN") return leaveOpen(`${this.host.displayName} reports the pull request as ${view.state}`, "refused");
      if (view.base !== base) return leaveOpen(`the pull request now targets ${view.base}, not ${base}`, "ineligible");
    }

    // 1. Push the branch and open (or find) its PR against the base.
    try {
      await this.push(remote, goal.branch);
      this._pushed = true;
      this.eventBus?.emit("source_control:branch_pushed", { branch: goal.branch, remote, timestamp: Date.now() });
    } catch (err) {
      return leaveOpen(`the branch ${goal.branch} could not be pushed`, "refused", err);
    }
    const opened = goal.prUrl ? { url: goal.prUrl } : await this.openOrFindPr(goal, base);
    const prUrl = opened.url;
    if (!prUrl) return leaveOpen(`no pull request could be opened for ${goal.branch}`, undefined, opened.error);
    result.prUrl = prUrl;
    this.eventBus?.emit("source_control:pr_created", { branch: goal.branch, prUrl, goalId: goal.goalId, timestamp: Date.now() });

    // 2. Only goals whose every task passed review, without a skip label.
    const eligibility = mergeEligibility({ verdicts: goal.verdicts, labels: goal.labels ?? [], skipLabels: options.skipLabels });
    if (!eligibility.eligible) return leaveOpen(eligibility.reason, "ineligible");

    const maxRounds = options.maxRounds ?? MERGE_PRS_DEFAULT_MAX_ROUNDS;
    const maxConflictRounds = options.maxConflictRounds ?? MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS;
    let conflictRounds = 0;
    let turn: MergeTurn | undefined;
    let turnTakenAt = 0;
    let warnedNoQueue = false;
    const release = async () => {
      if (!turn) return;
      const held = Date.now() - turnTakenAt;
      await turn.release().catch(() => {});
      turn = undefined;
      this.eventBus?.emit("source_control:merge_turn_released", { goalId: goal.goalId, repoKey: options.queue?.repoKey ?? "", heldMs: held, timestamp: Date.now() });
    };
    let lastRefusal: unknown;
    result.rounds = 0;
    try {
      while (result.rounds < maxRounds) {
        result.rounds++;
        if (!turn && options.queue && !warnedNoQueue) {
          try {
            turn = await options.queue.take(
              { project: options.project ?? "swarm", goalId: goal.goalId, prUrl },
              (w) =>
                this.eventBus?.emit("source_control:merge_waiting", {
                  goalId: goal.goalId,
                  repoKey: options.queue!.repoKey,
                  ahead: w.ahead,
                  ...(w.holder ? { holderProject: w.holder.project, ...(w.holder.pr ? { holderPrUrl: w.holder.pr } : {}) } : {}),
                  timestamp: Date.now(),
                }),
            );
            turnTakenAt = Date.now();
            result.waitedMs = (result.waitedMs ?? 0) + turn.waitedMs;
            this.eventBus?.emit("source_control:merge_turn_taken", {
              goalId: goal.goalId,
              repoKey: options.queue.repoKey,
              waitedMs: turn.waitedMs,
              ...(turn.tookOverFrom ? { tookOverFrom: turn.tookOverFrom } : {}),
              timestamp: Date.now(),
            });
          } catch (err) {
            // The lock directory cannot be used: merge as before this change,
            // still guarded by the base check below. Said once per merge.
            warnedNoQueue = true;
            result.queueWarning = `the merge queue could not be used (${this.errorText(err)}); merging without a turn`;
          }
        }
        const attempt = await this.attemptMerge(goal, prUrl, base, remote, options, result);
        if (attempt.kind === "merged") {
          await release();
          result.merged = true;
          if (attempt.mergeCommit) result.mergeCommit = attempt.mergeCommit;
          await this.returnToBase(remote, base);
          this.eventBus?.emit("source_control:pr_merged", {
            goalId: goal.goalId,
            branch: goal.branch,
            prUrl,
            mergeCommit: attempt.mergeCommit ?? "",
            base,
            timestamp: Date.now(),
          });
          return result;
        }
        if (attempt.kind === "retry") {
          lastRefusal = attempt.error ?? lastRefusal;
          if (result.rounds < maxRounds) {
            this.eventBus?.emit("source_control:merge_round", { goalId: goal.goalId, prUrl, round: result.rounds + 1, reason: attempt.why, timestamp: Date.now() });
          }
          continue;
        }
        if (attempt.kind === "conflict") {
          await release();
          if (!options.resolveConflict || conflictRounds >= maxConflictRounds) {
            return leaveOpen(`the branch conflicts with ${base}; a person needs to resolve it`, "conflict", attempt.error);
          }
          conflictRounds++;
          result.rounds--; // a hand-back is not a round
          const handed = await this.handBackConflict(goal, base, remote, attempt.files, options);
          if (!handed.resolved) {
            return leaveOpen(`the conflict with ${base} was not resolved: ${handed.reason ?? "no reason given"}`, "conflict");
          }
          result.conflictsResolved = (result.conflictsResolved ?? 0) + 1;
          continue;
        }
        await release();
        return leaveOpen(attempt.reason, attempt.leaveKind, attempt.error);
      }
      await release();
      return leaveOpen(`${base} kept moving while the gate ran (${maxRounds} rounds); swarm tries again later`, "base_kept_moving", lastRefusal);
    } finally {
      await release();
    }
  }

  /** One round: bring the base in, gate, push, check the base, wait for GitHub, merge. */
  private async attemptMerge(goal: MergeableGoal, prUrl: string, base: string, remote: string, options: MergeGoalOptions, result: MergeGoalResult): Promise<Attempt> {
    try {
      await this.git(["switch", goal.branch]);
      await this.fetch(remote, base);
    } catch (err) {
      return { kind: "leave", reason: `the branch could not be checked out or ${remote}/${base} fetched`, leaveKind: "refused", error: err };
    }
    let gatedBase: string;
    try {
      gatedBase = (await this.git(["rev-parse", `${remote}/${base}`])).stdout.trim();
      await this.gitAs(["merge", "--no-edit", "--no-ff", `${remote}/${base}`]);
    } catch (mergeErr) {
      const files = await this.conflictedFiles();
      try {
        await this.git(["merge", "--abort"]);
      } catch {
        // Nothing to abort.
      }
      return { kind: "conflict", files, error: mergeErr };
    }

    this.eventBus?.emit("source_control:merge_gate_started", { goalId: goal.goalId, branch: goal.branch, command: options.gate.command, timestamp: Date.now() });
    const gate = await runMergeGate(this.repoRoot, options.gate);
    result.gate = gate;
    this.eventBus?.emit("source_control:merge_gate_finished", {
      goalId: goal.goalId,
      branch: goal.branch,
      passed: gate.passed,
      exitCode: gate.exitCode,
      timedOut: gate.timedOut,
      durationMs: gate.durationMs,
      tail: gate.tail,
      timestamp: Date.now(),
    });
    if (!gate.passed) {
      const how = gate.timedOut ? "timed out" : `failed (exit ${gate.exitCode ?? "unknown"})`;
      return { kind: "leave", reason: `the merge gate ${how}; its output is in the run log`, leaveKind: "gate_failed" };
    }

    try {
      await this.push(remote, goal.branch);
    } catch (err) {
      return { kind: "leave", reason: `the branch could not be pushed after merging ${base} into it`, leaveKind: "refused", error: err };
    }
    let gatedHead: string;
    try {
      gatedHead = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    } catch (err) {
      return { kind: "leave", reason: "the gated commit could not be read", leaveKind: "refused", error: err };
    }

    // The base must be the one the gate ran with: what merges is what was gated.
    // The host's pinned merge pins only the head, so a base swarm cannot read
    // is never taken as unmoved.
    let remoteBase: string;
    try {
      remoteBase = await this.remoteHead(remote, base);
    } catch (err) {
      return { kind: "leave", reason: `swarm could not read ${base} on ${remote} to check it had not moved since the gate; swarm tries again later`, leaveKind: "refused", error: err };
    }
    if (remoteBase !== gatedBase) return { kind: "retry", why: "base_moved" };

    const settled = await this.waitMergeable(prUrl, options.mergeableWaitMs ?? 60_000, options.mergeablePollMs ?? 2_000);
    if (settled.headSha && settled.headSha !== gatedHead) {
      return { kind: "leave", reason: "the pull request's branch changed after the gate ran; a person needs to check it", leaveKind: "head_changed" };
    }
    if (settled.mergeable === "CONFLICTING") return { kind: "retry", why: "base_moved" };

    const outcome = await this.host.mergePinned(prUrl, gatedHead);
    if (outcome.kind === "merged") return { kind: "merged", ...(outcome.mergeCommit ? { mergeCommit: outcome.mergeCommit } : {}) };
    if (outcome.kind === "base_moved") {
      // The host's words also cover a rule that refuses the merge (branch
      // protection): only a base that really moved is worth another round.
      let now: string | undefined;
      try {
        now = await this.remoteHead(remote, base);
      } catch {
        now = undefined;
      }
      if (now !== undefined && now !== gatedBase) return { kind: "retry", why: "refused", error: outcome.error };
      return { kind: "leave", reason: `${this.host.displayName} refused to merge the pull request`, leaveKind: "refused", error: outcome.error };
    }
    if (outcome.kind === "unknown") {
      return { kind: "leave", reason: "swarm could not read the pull request's state after merging; check it by hand", leaveKind: "refused", error: outcome.error };
    }
    // A refusal because someone pushed to the branch after the gate: a person's
    // work, which no later run can merge for them (finished, not retried).
    let headNow: string | undefined;
    try {
      headNow = await this.remoteHead(remote, goal.branch);
    } catch {
      headNow = undefined;
    }
    if (headNow !== undefined && headNow !== gatedHead) {
      return { kind: "leave", reason: "the pull request's branch changed after the gate ran; a person needs to check it", leaveKind: "head_changed", error: outcome.error };
    }
    return {
      kind: "leave",
      reason: outcome.error !== undefined ? `${this.host.displayName} refused to merge the pull request` : `${this.host.displayName} reports the pull request as ${outcome.state ?? "unknown"}, not merged`,
      leaveKind: "refused",
      error: outcome.error,
    };
  }

  /** The remote's head of `branch` (git ls-remote), authenticated as the code host says. */
  private async remoteHead(remote: string, branch: string): Promise<string> {
    const out = await this.gitRemote(["ls-remote", remote, `refs/heads/${branch}`], remote);
    const sha = out.stdout.trim().split(/\s+/)[0];
    if (!sha) throw new Error(`${remote} has no ${branch}`);
    return sha;
  }

  /** Ask the code host until mergeability is no longer UNKNOWN, or the wait is over. Errors count as unknown. */
  private async waitMergeable(prUrl: string, waitMs: number, pollMs: number): Promise<{ mergeable?: string; headSha?: string }> {
    const until = Date.now() + waitMs;
    let last: { mergeable?: string; headSha?: string } = {};
    for (;;) {
      try {
        last = await this.host.mergeability(prUrl);
      } catch {
        last = {};
      }
      if (last.mergeable !== "UNKNOWN" || Date.now() >= until) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Files git left unmerged. */
  private async conflictedFiles(): Promise<string[]> {
    try {
      return (await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Give a conflict with the base to the injected resolver (a worker, then the
   * reviewer). The goal branch is checked out with the base merge in progress,
   * so the worker resolves exactly what git could not. Afterwards the branch
   * must still be checked out and keep its own commits, the merge must be
   * concluded with nothing left unmerged or uncommitted, and the base must be
   * contained; anything else puts the branch back where it was and removes
   * files the hand-back created, so no unreviewed resolution is ever pushed
   * or merged, and no other branch is touched.
   */
  private async handBackConflict(goal: MergeableGoal, base: string, remote: string, files: string[], options: MergeGoalOptions): Promise<{ resolved: boolean; reason?: string }> {
    let before: string;
    try {
      await this.git(["switch", goal.branch]);
      before = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      return { resolved: false, reason: "the branch could not be prepared for the worker" };
    }
    const untrackedBefore = new Set(await this.untrackedFiles());
    const baseCommits = await this.baseCommitsTouching(`${remote}/${base}`, files);
    this.eventBus?.emit("source_control:merge_conflict_handed_back", { goalId: goal.goalId, branch: goal.branch, files, timestamp: Date.now() });
    try {
      await this.gitAs(["merge", "--no-ff", "--no-commit", `${remote}/${base}`]);
    } catch {
      // Expected: the conflict is what the worker resolves.
    }
    let answer: { resolved: boolean; reason?: string };
    try {
      answer = await options.resolveConflict!({ goalId: goal.goalId, goalDescription: goal.goalDescription, branch: goal.branch, base, remote, files, baseCommits });
    } catch (err) {
      answer = { resolved: false, reason: `the resolution task stopped (${this.errorText(err)})` };
    }
    const onBranch = (await this.currentBranch()) === goal.branch;
    const unfinished = (await this.mergeInProgress()) || (await this.conflictedFiles()).length > 0;
    const uncommitted = !unfinished && (await this.workTreeChanges()) !== "";
    const keepsWork = await this.isAncestor(before, "HEAD");
    const containsBase = await this.isAncestor(`${remote}/${base}`, "HEAD");
    if (answer.resolved && onBranch && !unfinished && !uncommitted && keepsWork && containsBase) return { resolved: true };
    for (const step of [
      () => this.git(["merge", "--abort"]),
      // Back on the goal branch before the reset: never reset whatever branch the worker left checked out.
      () => (onBranch ? Promise.resolve() : this.git(["switch", "-f", goal.branch])),
      () => this.git(["reset", "--hard", before]),
      async () => {
        const created = (await this.untrackedFiles()).filter((f) => !untrackedBefore.has(f));
        if (created.length > 0) await this.git(["clean", "-f", "-q", "--", ...created]);
      },
    ]) {
      try {
        await step();
      } catch {
        // Each step is best effort; returnToBase still leaves the work repo on the base.
      }
    }
    if (!answer.resolved) return { resolved: false, reason: answer.reason ?? "the worker did not resolve it" };
    if (!onBranch) return { resolved: false, reason: "the worker moved off the branch" };
    if (unfinished) return { resolved: false, reason: "the worker left the merge unfinished" };
    if (uncommitted) return { resolved: false, reason: "the worker left changes uncommitted" };
    if (!keepsWork) return { resolved: false, reason: "the resolution dropped the branch's own commits" };
    return { resolved: false, reason: `the branch does not contain ${base}` };
  }

  /** The checked-out branch's name; "" when HEAD is detached. */
  private async currentBranch(): Promise<string> {
    try {
      return (await this.git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    } catch {
      return "";
    }
  }

  /** Uncommitted changes, untracked files included (git status --porcelain); "" when clean. */
  private async workTreeChanges(): Promise<string> {
    return (await this.git(["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
  }

  /** Untracked files git does not ignore. */
  private async untrackedFiles(): Promise<string[]> {
    try {
      return (await this.git(["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `ref`. */
  private async isAncestor(ancestor: string, ref: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, ref]);
      return true;
    } catch {
      return false;
    }
  }

  /** Commits on `baseRef` since the merge base with HEAD that touched `files`: newest first, at most 20. */
  private async baseCommitsTouching(baseRef: string, files: string[]): Promise<Array<{ sha: string; subject: string }>> {
    if (files.length === 0) return [];
    try {
      const mergeBase = (await this.git(["merge-base", "HEAD", baseRef])).stdout.trim();
      const { stdout } = await this.git(["log", "--format=%H%x09%s", "-n", "20", `${mergeBase}..${baseRef}`, "--", ...files]);
      return stdout.split("\n").filter(Boolean).map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha, subject: rest.join("\t") };
      });
    } catch {
      return [];
    }
  }

  /** Whether a merge is in progress (MERGE_HEAD exists). */
  private async mergeInProgress(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** An error's message for logs and events: the account's token masked,
   *  common secret shapes redacted, cut to one short paragraph. */
  private errorText(err: unknown): string {
    const raw = err instanceof Error ? `${err.message}${(err as { stderr?: unknown }).stderr ? ` ${String((err as { stderr?: unknown }).stderr)}` : ""}` : String(err);
    const masked = this.host.redact(raw);
    return redactGateOutput(masked).replace(/\s+/g, " ").trim().slice(0, 500);
  }

  /** The PR for `goal.branch` against `base`: opened now, or the open one a
   *  previous attempt left. Undefined when neither works. */
  private async openOrFindPr(goal: MergeableGoal, base: string): Promise<{ url?: string; error?: unknown }> {
    let createError: unknown;
    try {
      const url = await this.host.openChangeRequest({
        title: formatPrTitle(goal.goalDescription),
        body: `Automated PR from swarm orchestrator.\n\nGoal: ${goal.goalId}\n${sourceLine(goal)}Base: ${base}\n\n${goal.goalDescription}${leftForPersonSection(goal.leftForPerson)}`,
        base,
        head: goal.branch,
      });
      if (url) return { url };
    } catch (err) {
      // Maybe one is already open for this branch (a re-run).
      createError = err;
    }
    const found = await this.host.findChangeRequest(goal.branch);
    // Only an open PR into this run's base: a stale one into another branch is never merged.
    if (found && found.state === "OPEN" && found.base === base) return { url: found.url };
    return { error: createError };
  }

  /** Put the work repo back on the base branch at the remote. Best effort. */
  private async returnToBase(remote: string, base: string): Promise<void> {
    for (const step of [
      () => this.git(["merge", "--abort"]),
      () => this.git(["switch", base]),
      () => this.fetch(remote, base),
      () => this.git(["merge", "--ff-only", `${remote}/${base}`]),
    ]) {
      try {
        await step();
      } catch {
        // Each step is best effort; the next goal's syncBaseBranch reports a real problem.
      }
    }
  }

  /** git against `remote`, authenticated as the code host says (for GitHub: the account's token over HTTPS). */
  private async gitRemote(args: string[], remote: string): Promise<{ stdout: string; stderr: string }> {
    const auth = await this.host.gitAuth(remote);
    if (!auth) return this.git(args);
    return this.masked(execFileAsync("git", [...auth.args, ...args], { cwd: this.repoRoot, env: auth.env }));
  }

  /** `git fetch <remote> <branch>`. */
  private async fetch(remote: string, branch: string): Promise<void> {
    await this.gitRemote(["fetch", remote, branch], remote);
  }

  /** git with source_control.git_identity as author and committer, when set. */
  private async gitAs(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const identity = this.config.git_identity;
    if (!identity) return this.git(args);
    return execFileAsync("git", args, { cwd: this.repoRoot, env: { ...process.env, ...gitIdentityEnvVars(identity) } });
  }

  /** Return to the base branch. */
  async restoreBaseBranch(): Promise<void> {
    const baseBranch = this.config.base_branch ?? "main";
    try {
      await this.git(["checkout", baseBranch]);
    } catch {
      // Best effort
    }
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { cwd: this.repoRoot });
  }

  /** The call's result; if it fails, its error with the token masked in the
   *  message (which callers wrap into their own errors and print). */
  private async masked<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (err) {
      if (err instanceof Error) err.message = this.host.redact(err.message);
      throw err;
    }
  }

  /** `git push -u <remote> <branch>`. */
  private async push(remote: string, branch: string): Promise<void> {
    await this.gitRemote(["push", "-u", remote, branch], remote);
  }

  /** Whether a local branch exists, asked of git directly rather than read from its (localised) messages. */
  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }
}
