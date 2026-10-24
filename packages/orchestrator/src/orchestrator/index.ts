/**
 * Orchestrator — core dispatch and token-budget engine for the Swarm SDK.
 *
 * Responsibilities:
 * - Build trust-appropriate dispatch directives for Worker agents
 * - Track cumulative tokens and enforce per-session / per-task / per-goal token limits
 * - Manage checkpoints for session resume
 * - Record structured orchestration events
 */

import type {
  Goal,
  Task,
  TaskBackend,
  ProjectConfig,
  DispatchDirective,
  ContextDepth,
  TrustLevel,
  Checkpoint,
  GoalPublication,
  OrchestrationEvent,
  OrchestrationEventType,
  ISwarmEventBus,
  SwarmOversightRunResult,
  GoalSummary,
  PrerequisiteValidation,
  AutonomyConfig,
} from "@mnmal-ai/swarm-types";
import { execFile } from "node:child_process";
import { RateLimitError, SUCCESS_VERDICTS, formatTokens } from "@mnmal-ai/swarm-types";
import { validatePrerequisites as validatePrereqs } from "./prerequisites.js";
import { deriveAutonomy } from "../autonomy/index.js";
import { gitIdentityEnv, taskCommitSubject } from "../source-control/commit-policy.js";

// Minimal git wrapper for the live-repo commit path. WorktreeManager and
// SourceControlManager have their own copies; rather than create a shared
// module for three callsites, the helper is inlined here too.
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
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ---------------------------------------------------------------------------
// TaskTimeoutError — typed error for timeout detection (avoids string matching)
// ---------------------------------------------------------------------------

export class TaskTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// WorkerWedgedError — raised by the dispatch-loop watchdog when no active
// worker settles within the heartbeat window. The wedged workers may have
// hung in the LLM SDK below the per-task `queryTimeoutMs` translation layer,
// so the dispatch loop itself stops making progress. The watchdog forces
// the race to resolve, marks the active workers as failed, and lets the
// existing failure / replan path continue the run instead of hanging
// indefinitely.
// ---------------------------------------------------------------------------

export class WorkerWedgedError extends Error {
  readonly activeTaskIds: string[];
  readonly heartbeatMs: number;
  constructor(activeTaskIds: string[], heartbeatMs: number) {
    super(
      `No worker settled within ${heartbeatMs}ms heartbeat — ${activeTaskIds.length} wedged: ${activeTaskIds.join(", ")}`,
    );
    this.name = "WorkerWedgedError";
    this.activeTaskIds = [...activeTaskIds];
    this.heartbeatMs = heartbeatMs;
  }
}
import type { WorktreeManager } from "../worktree/index.js";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateDAG, getExecutableTasks, applySerializationConstraints, applySharedFileConstraints, applyCreateModifyConstraints, injectDynamicEdges } from "./dag.js";
import type { DAGNode } from "./dag.js";
import { runDiscovery as runDiscoveryFn } from "./discovery.js";
import type { DiscoveryCommand, DiscoveryPhaseResult } from "./discovery.js";
import { loadConflictHistory, getSerializationFiles } from "./conflict-history.js";
import type { RateLimitGate } from "../rate-limit-gate.js";

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  projectConfig: ProjectConfig;
  backend: TaskBackend;
  checkpointPath?: string;
  eventBus?: ISwarmEventBus;
  /** Path to conflict_history.json for automatic merge conflict learning. */
  conflictHistoryPath?: string;
  /** Optional Substrate client for entity-based goal loading, task tracking, and learning. */
  substrateClient?: SubstrateClient;
  /**
   * Working repo for live-repo commits (no-worktrees mode). When set, the
   * orchestrator will `git add -A && git commit` after each approved task
   * verdict so worker output survives crash/restart and produces a real git
   * history. When undefined, no live-repo commits happen — workers still
   * mutate the working tree directly but the orchestrator stays out of git.
   *
   * Defaults to undefined for safety: tests and ad-hoc Orchestrator
   * construction don't accidentally write commits into the developer's
   * checkout. The CLI passes process.cwd() explicitly when launching a
   * production run.
   */
  repoRoot?: string;
  /**
   * Dispatch-loop watchdog: if no active worker settles within this many
   * milliseconds, the orchestrator emits `task_wedged`, marks the
   * currently-active workers as failed, and continues the loop instead of
   * blocking forever on `Promise.race`. Defaults to 30 minutes. The
   * underlying LLM SDK has its own per-call `queryTimeoutMs`; this is a
   * layer above that — it catches the case where the SDK fails to translate
   * its own timeout into a rejected promise (observed empirically in
   * production runs against claude.exe).
   */
  workerHeartbeatMs?: number;
}

// ---------------------------------------------------------------------------
// Substrate JSON field parsing helper
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string that should be an array. Returns an empty
 * array on parse failure or non-array values. Substrate stores arrays as
 * serialized JSON strings.
 */
function safeParseJsonArray(value: string | undefined | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trust-level mapping tables
// ---------------------------------------------------------------------------

/**
 * Low trust = full context (agents get maximum guidance to reduce mistakes).
 * High trust = lean context (proven agents need less hand-holding).
 */
const CONTEXT_DEPTH_BY_TRUST: Record<TrustLevel, ContextDepth> = {
  low: "full",
  medium: "standard",
  high: "lean",
};

// SKILLS_BY_TRUST and REVIEW_REQUIRED_BY_TRUST removed — these are now
// derived from the AutonomyConfig via deriveAutonomy().

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly config: ProjectConfig;
  private readonly backend: TaskBackend;
  private readonly checkpointDir: string | undefined;
  private readonly sessionId: string;
  private readonly startTime: number;
  private cumulativeTokens: number;
  /** Finished goals and how far publishing them got; see saveCheckpoint. */
  private goalPublications: GoalPublication[] = [];
  private readonly events: OrchestrationEvent[];
  private readonly eventBus?: ISwarmEventBus;
  private readonly conflictHistoryPath?: string;
  private readonly goalSummaries: GoalSummary[] = [];
  private readonly autonomy: AutonomyConfig;
  private readonly substrateClient?: SubstrateClient;
  private readonly repoRoot?: string;
  private readonly workerHeartbeatMs: number;
  /**
   * Per-goal count of live-repo commits that actually landed. Indexed by
   * `task.goal_id` and incremented inside `commitLiveRepo` only after a
   * commit actually succeeds — *not* on no-op early returns or
   * checkout-failure abort paths. The CLI reads this at goal-completion
   * time via `getCommitsForGoal(goalId)` so it can log + emit
   * `goal_completed_no_commits` telemetry when a goal marked `completed`
   * actually produced zero commits — the "ghost-completion" case that
   * hid investigative/refactor-only goals in the 2026-05-30 run and made
   * the DAG resolver look permissive when it was acting on an honest
   * `completed` signal with no work behind it.
   *
   * Keyed by goal_id (instead of a single counter + reset) so the
   * lifecycle stays stateless between calls — callers can't observe
   * stale counts from a previous goal, and there's no "you must reset
   * me at the start of each goal" implicit contract to forget.
   */
  private readonly commitsByGoal = new Map<string, number>();

  constructor(opts: OrchestratorConfig) {
    this.config = opts.projectConfig;
    this.backend = opts.backend;
    this.repoRoot = opts.repoRoot;
    this.workerHeartbeatMs = opts.workerHeartbeatMs ?? 30 * 60 * 1000;
    this.checkpointDir = opts.checkpointPath;
    this.eventBus = opts.eventBus;
    this.conflictHistoryPath = opts.conflictHistoryPath;
    this.substrateClient = opts.substrateClient;
    this.sessionId = randomUUID();
    this.startTime = Date.now();
    this.cumulativeTokens = 0;
    this.events = [];
    // Own copy of the execution block: updateTaskTokenLimit changes it, and
    // deriveAutonomy may return a shared preset object.
    const autonomy = deriveAutonomy(opts.projectConfig);
    this.autonomy = { ...autonomy, execution: { ...autonomy.execution } };
  }

  // -------------------------------------------------------------------------
  // Substrate helpers (fire-and-forget)
  // -------------------------------------------------------------------------

  /**
   * Fire-and-forget Substrate mutation. If the client is not configured or
   * the mutation fails, log a warning but never block orchestration.
   */
  private async substrateMutate<T>(
    mutationName: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.substrateClient) return null;
    try {
      return await this.substrateClient.mutate<T>(mutationName, params, { id: true });
    } catch (err) {
      console.warn(
        `[swarm] Substrate ${mutationName} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Live-repo commit path — invoked when worktrees are disabled (e.g.,
   * max_workers=1 with --no-worktrees). Worktree mode handles commits via
   * WorktreeManager.commitChanges + merge; without worktrees, the worker
   * has been mutating the orchestrator's working tree directly. Without
   * this method, those mutations accumulate uncommitted and are lost on
   * crash / restart / accidental reset.
   *
   * No-ops when `repoRoot` is unset (safety: tests, ad-hoc construction,
   * or future call sites cannot accidentally write commits into whatever
   * `process.cwd()` happens to be). The CLI passes process.cwd() at
   * `new Orchestrator(...)` time when launching a production run.
   *
   * Best-effort: emits `commit_failed` and continues if any git step
   * errors. Does NOT push (separate concern; operator may not have a
   * remote configured or credentials available).
   *
   * Skips when there's nothing staged (an investigation task that doesn't
   * write files, or any task whose output was already committed by a
   * sibling tool).
   *
   * Public on Orchestrator so the sequential dispatch loops in
   * `packages/cli/src/cli/run.ts` (sub-task execution + remediation
   * execution) can invoke it directly. It was first wired into
   * `_dispatchFlat` only, and those sequential loops bypass
   * `dispatchParallel` entirely on max_workers=1 setups, so commits never
   * landed despite the orchestrator being correctly configured.
   */
  /**
   * How many commits the given goal has produced in this Orchestrator's
   * lifetime — across BOTH the live-repo path (`commitLiveRepo`) and the
   * worktree path (`worktreeManager.commitChanges` + merge). Read by the
   * CLI at goal-completion time: if the goal's final status is
   * `completed` but this is 0, the CLI emits a `goal_completed_no_commits`
   * event and logs a clear warning so the operator sees the no-op
   * completion instead of mistaking it for real work.
   *
   * Counting in both paths matters: the original counter only fired on
   * the live-repo path, so any goal run with worktrees enabled
   * (max_workers > 1) would have ghost-completion false-positive on
   * every goal regardless of how much work landed.
   */
  getCommitsForGoal(goalId: string): number {
    return this.commitsByGoal.get(goalId) ?? 0;
  }

  /**
   * Internal: bump the per-goal commit count. Called from both the
   * live-repo commit path (`commitLiveRepo`) and the worktree commit
   * path (after `commitChanges` actually staged AND `merge` succeeded
   * to bring the commit onto the orchestrator's branch). Both code
   * paths converge here so future commit-landing sites have one place
   * to wire up instead of an implicit contract.
   */
  private incrementCommitCount(goalId: string): void {
    this.commitsByGoal.set(goalId, (this.commitsByGoal.get(goalId) ?? 0) + 1);
  }

  /**
   * Commit the worker's output for `task` to the live working tree.
   *
   * `opts.goalBranch` is the per-call branch context — when set, HEAD is
   * switched to that branch before committing so each goal's diff lands
   * on its own `swarm-worker/goal-N` branch in stack-PR mode. Pass
   * `null` (or omit) to commit on whatever HEAD currently is (the
   * non-stack default).
   *
   * The per-call shape is deliberate: the original 2026-05-30 regression
   * was a missing-wiring bug, and an earlier draft of this fix used a
   * stateful setter + ambient state — recreating exactly the class of
   * brittleness the review caught. Passing the branch in-line per call
   * means there's no setup protocol to forget; the dispatch paths and
   * the CLI's sequential loops each pass `goalBranch` explicitly.
   */
  /** Env for git commands that create commits: the configured
   *  source_control.git_identity as author and committer, else inherited. */
  private commitEnv(): NodeJS.ProcessEnv | undefined {
    return gitIdentityEnv(this.config.source_control?.git_identity);
  }

  async commitLiveRepo(
    task: Task,
    opts?: { goalBranch?: string | null },
  ): Promise<void> {
    if (!this.repoRoot) return;
    const cwd = this.repoRoot;
    const goalBranch = opts?.goalBranch ?? null;
    try {
      // Stack-PR fix: when a goal branch is configured, switch HEAD to it
      // before committing. Pre-fix, this method ran `git commit` on
      // whatever HEAD happened to be when the orchestrator started — so
      // even though the CLI had pre-materialized `swarm-worker/goal-N`
      // for each goal, every task's diff landed on the orchestrator's
      // starting branch (123-commit incident, 2026-05-30).
      //
      // `git checkout <branch>` preserves uncommitted worker output as
      // long as the target branch's tree doesn't conflict — the common
      // case here because the goal branch was just created from the
      // stack base (resolveStackBase) and shares the same tree.
      //
      // Best-effort: on checkout failure (conflict, missing branch,
      // etc.), emit `commit_failed` with a stack-specific detail AND a
      // dirty-tree indicator. The worker's modifications stay in the
      // working tree (we don't auto-discard), so the operator can
      // inspect them — but the next commit on a *different* goal could
      // silently inherit them. The dirty-tree flag in the event surfaces
      // that risk so the operator can intervene before more work runs.
      if (goalBranch) {
        const { stdout: headRef } = await execFileAsync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd },
        );
        if (headRef.trim() !== goalBranch) {
          try {
            // `git switch` (Git 2.23+) instead of `git checkout` — same
            // tree-preserving branch-switch semantics but cannot
            // accidentally interpret the ref as a file path and detach
            // HEAD onto it. The branch name comes from goalBranchName()
            // which is already ref-sanitized, but `switch` is the
            // narrower, less-overloaded command.
            await execFileAsync(
              "git",
              ["switch", goalBranch],
              { cwd },
            );
          } catch (checkoutErr) {
            const detail = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
            // Probe whether worker output is still in the working tree.
            // `git status --porcelain` is empty on a clean tree, non-empty
            // otherwise. Include the flag in the event so a dashboard or
            // operator review can spot in-flight uncommitted output.
            let isDirty = false;
            try {
              const { stdout: statusOut } = await execFileAsync(
                "git",
                ["status", "--porcelain"],
                { cwd },
              );
              isDirty = statusOut.trim().length > 0;
            } catch {
              // status probe failure is non-fatal; treat tree as clean for safety
            }
            // Prevent worker-output bleed: a future `commitLiveRepo` for a
            // DIFFERENT task would otherwise `git add -A` and stage both
            // its own files AND this task's stranded output, producing a
            // commit with the wrong message/attribution and breaking the
            // commit counter.
            //
            // We `git stash push -u` (covers tracked modifications AND
            // untracked new files — both leak into a subsequent
            // `git add -A`). The stash is labeled with the task id and
            // failed branch so the operator can find it via
            // `git stash list` and `git stash apply` to inspect what
            // the worker produced. Better than `git restore .` (which
            // misses untracked) or `git clean -fd` (destructive +
            // unrecoverable). The stash failure is non-fatal — the
            // commit_failed event already named the symptom.
            let stashSaved = false;
            if (isDirty) {
              try {
                await execFileAsync(
                  "git",
                  [
                    "stash",
                    "push",
                    "-u",
                    "-m",
                    `swarm: failed-checkout salvage for task "${task.id}" (could not switch to ${goalBranch})`,
                  ],
                  { cwd, env: this.commitEnv() },
                );
                stashSaved = true;
              } catch {
                // stash failure is non-fatal; we still emit the warning below
              }
            }
            const dirtyFlag = !isDirty
              ? ""
              : stashSaved
                ? " [worker output stashed — recover via `git stash list` / `git stash apply`]"
                : " [dirty working tree — worker output uncommitted AND stash failed; may bleed into next task]";
            this.recordEvent(
              "commit_failed",
              `Live-repo commit for task "${task.id}" skipped — could not checkout ${goalBranch}: ${detail}${dirtyFlag}`,
              { task_id: task.id },
            );
            return;
          }
        }
      }

      await execFileAsync("git", ["add", "-A"], { cwd });
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--cached", "--name-only"],
        { cwd },
      );
      const stagedFiles = stdout.trim();
      if (!stagedFiles) return;

      const subject = taskCommitSubject(task, this.config.source_control?.commit_style);
      const message = `${subject}\n\nGoal: ${task.goal_id}\nTask: ${task.id}\nSession: ${this.sessionId}`;
      await execFileAsync("git", ["commit", "-m", message, "--no-verify"], { cwd, env: this.commitEnv() });

      const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
      const sha = shaOut.trim();
      const fileCount = stagedFiles.split("\n").length;
      // Track per-goal commit volume keyed by task.goal_id so the CLI can
      // detect ghost completions (goal status = completed but 0 commits
      // landed). Goal-id keying keeps the counter stateless between
      // calls — no reset signal to forget.
      this.incrementCommitCount(task.goal_id);
      this.recordEvent(
        "task_committed",
        `Task "${task.id}" committed as ${sha.slice(0, 8)} (${fileCount} file${fileCount === 1 ? "" : "s"})`,
        { task_id: task.id },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.recordEvent(
        "commit_failed",
        `Live-repo commit for task "${task.id}" failed: ${detail}`,
        { task_id: task.id },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Goal loading from Substrate
  // -------------------------------------------------------------------------

  /**
   * Load goals from Substrate entities. Returns null when substrateClient is not
   * configured (caller should fall back to filesystem).
   *
   * Queries all Goal entities, filters by projectId client-side, parses
   * JSON string fields, and sorts by priority.
   */
  async loadGoalsFromSubstrate(projectId: string): Promise<Goal[] | null> {
    if (!this.substrateClient) return null;

    const raw = await this.substrateClient.query<{
      goalId: string;
      projectId: string;
      description: string;
      priority: string;
      status: string;
      acceptanceCriteria: string;
      constraints: string;
      dependsOn: string;
      timestamp: string;
    }>("Goal", {}, {
      goalId: true,
      projectId: true,
      description: true,
      priority: true,
      status: true,
      acceptanceCriteria: true,
      constraints: true,
      dependsOn: true,
      timestamp: true,
    });

    // Filter by projectId client-side (Substrate auto-CRUD only filters by id/limit)
    const projectGoals = raw.filter(g => g.projectId === projectId);

    // Convert Substrate entities to Goal interface
    const goals: Goal[] = projectGoals.map(g => ({
      id: g.goalId,
      description: g.description,
      priority: parseInt(g.priority, 10) || 0,
      status: (g.status as Goal["status"]) || "pending",
      acceptance_criteria: safeParseJsonArray(g.acceptanceCriteria),
      constraints: safeParseJsonArray(g.constraints),
      dependsOn: safeParseJsonArray(g.dependsOn),
    }));

    // Sort by priority (same as the filesystem path)
    goals.sort((a, b) => a.priority - b.priority);

    return goals;
  }

  // -------------------------------------------------------------------------
  // Dispatch directive builder
  // -------------------------------------------------------------------------

  /**
   * Build a DispatchDirective for a given goal + task, applying trust-level
   * constraints from the project configuration.
   */
  buildDirective(goal: Goal, task: Task): DispatchDirective {
    const trust = this.config.trust_level ?? "medium";
    const isolation = this.config.isolation;

    // Interpolate ${TASK_ID} in isolation commands
    const interpolate = (s: string) => s.replace(/\$\{TASK_ID\}/g, task.id);

    const isolationBlock = isolation ? {
      setup: interpolate(isolation.setup),
      verify: interpolate(isolation.verify),
      teardown: interpolate(isolation.teardown),
      env: isolation.env
        ? Object.fromEntries(Object.entries(isolation.env).map(([k, v]) => [k, interpolate(v)]))
        : undefined,
    } : undefined;

    return {
      task_id: task.id,
      goal_id: goal.id,
      intent: task.intent,
      description: task.description,
      directive: {
        trust_level: trust,
        context_depth: CONTEXT_DEPTH_BY_TRUST[trust],
        skills_allowed: [...this.autonomy.context.skill_tiers],
        review_required: this.autonomy.review.require_review,
        acceptance_criteria: [`Task completed as described: ${task.description}`],
        constraints: [...goal.constraints],
        escalation_triggers: [
          `Touches files outside scope of: ${task.description}`,
          "Requires new dependency not in constraints",
          "Cannot meet acceptance criteria",
        ],
        isolation: isolationBlock,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  /** Returns the stable session ID for this orchestrator instance. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Returns the maximum number of concurrent workers allowed. */
  getMaxConcurrency(): number {
    if (!this.autonomy.execution.parallel_workers) return 1;
    return this.autonomy.execution.max_workers;
  }

  /** Returns the task backend used by this orchestrator. */
  getBackend(): TaskBackend {
    return this.backend;
  }

  // -------------------------------------------------------------------------
  // Prerequisite validation
  // -------------------------------------------------------------------------

  /**
   * Validate prerequisites defined in the project config.
   * Returns null if no prerequisites are configured.
   * When hard-blocked, emits a human:escalation event.
   */
  validatePrerequisites(): PrerequisiteValidation | null {
    const checks = this.config.prerequisites;
    if (!checks || checks.length === 0) return null;

    const validation = validatePrereqs(checks);

    if (validation.passed) {
      const softNames = validation.softBlocked.map((r) => r.check.name);
      const detail = softNames.length > 0
        ? `Prerequisites passed (warnings: ${softNames.join(", ")} unavailable but optional/mockable)`
        : "All prerequisites available";
      this.recordEvent("prerequisite_check", detail);
      this.eventBus?.emit("prerequisite:checked", {
        project: this.config.project,
        passed: true,
        totalChecks: validation.results.length,
        hardBlocked: 0,
        softBlocked: validation.softBlocked.length,
        details: validation.results.map((r) => ({
          name: r.check.name,
          type: r.check.type,
          available: r.available,
          detail: r.detail,
        })),
        timestamp: Date.now(),
      });
    } else {
      const blockedNames = validation.hardBlocked.map((r) => r.check.name);
      this.recordEvent(
        "prerequisite_failed",
        `Missing required prerequisites: ${blockedNames.join(", ")}`,
      );
      this.eventBus?.emit("prerequisite:checked", {
        project: this.config.project,
        passed: false,
        totalChecks: validation.results.length,
        hardBlocked: validation.hardBlocked.length,
        softBlocked: validation.softBlocked.length,
        details: validation.results.map((r) => ({
          name: r.check.name,
          type: r.check.type,
          available: r.available,
          detail: r.detail,
        })),
        timestamp: Date.now(),
      });
      this.eventBus?.emit("human:escalation", {
        project: this.config.project,
        reason: `Cannot proceed — missing required prerequisites: ${blockedNames.join(", ")}`,
        blockedPrerequisites: blockedNames,
        timestamp: Date.now(),
      });
    }

    return validation;
  }

  // -------------------------------------------------------------------------
  // Token budgets
  //
  // Budgets are in tokens at three levels — session, goal, task — each
  // counting all input (fresh input, cache reads, cache writes) plus output.
  // The limits come from deriveAutonomy: the project's own, or its trust
  // level's where it sets none, so no check is ever inert.
  // -------------------------------------------------------------------------

  /** The limits this run enforces. */
  getTokenLimits(): { session: number; goal: number; task: number } {
    const e = this.autonomy.execution;
    return { session: e.max_tokens_per_session, goal: e.max_tokens_per_goal, task: e.max_tokens_per_task };
  }

  /** Returns the total tokens accumulated in this session. */
  getCumulativeTokens(): number {
    return this.cumulativeTokens;
  }

  /** Add `n` to the cumulative token counter. */
  addTokens(n: number): void {
    this.cumulativeTokens += n;
  }

  /** True when `tokens` has reached 80% of the per-session token limit. */
  shouldWarnTokens(tokens: number): boolean {
    return tokens >= this.autonomy.execution.max_tokens_per_session * 0.8;
  }

  /** True when `tokens` exceeds the per-session token limit. */
  isSessionTokenExceeded(tokens: number): boolean {
    return tokens > this.autonomy.execution.max_tokens_per_session;
  }

  /** True when `tokens` exceeds the per-goal token limit. */
  isGoalTokenExceeded(tokens: number): boolean {
    return tokens > this.autonomy.execution.max_tokens_per_goal;
  }

  /** True when `tokens` exceeds the per-task token limit. */
  isTaskTokenExceeded(tokens: number): boolean {
    return tokens > this.autonomy.execution.max_tokens_per_task;
  }

  /** Update the per-task token limit (e.g., after the user chooses to raise it). */
  updateTaskTokenLimit(newLimit: number): void {
    this.autonomy.execution.max_tokens_per_task = newLimit;
  }

  /** Return the current per-task token limit. */
  getTaskTokenLimit(): number {
    return this.autonomy.execution.max_tokens_per_task;
  }

  // -------------------------------------------------------------------------
  // Elapsed time
  // -------------------------------------------------------------------------

  /** Milliseconds since this Orchestrator was constructed. */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  // -------------------------------------------------------------------------
  // Goal summaries (SDK-23: per-goal context reset)
  // -------------------------------------------------------------------------

  /**
   * Record a completed goal summary. Called after each goal finishes so the
   * orchestrator can carry forward a compact representation of prior goals
   * without retaining the full event/session history.
   */
  addGoalSummary(summary: GoalSummary): void {
    this.goalSummaries.push(summary);
  }

  /** Returns all recorded goal summaries. */
  getGoalSummaries(): GoalSummary[] {
    return [...this.goalSummaries];
  }

  /**
   * Build a compact text summary of all completed goals, suitable for
   * injecting into a fresh Swarm context window as `additionalContext`.
   * Keeps each goal to one line to minimize token consumption.
   */
  buildPriorGoalsContext(): string {
    if (this.goalSummaries.length === 0) return "";

    const lines = this.goalSummaries.map((s) => {
      const status = s.status === "completed" ? "DONE" : s.status === "blocked" ? "BLOCKED" : s.status.toUpperCase();
      return `- [${status}] ${s.description} (${s.tasksCompleted}/${s.tasksCompleted + s.tasksFailed + s.tasksSkipped} tasks, ${formatTokens(s.tokens)} tokens)`;
    });

    return `## Prior goals in this session\n${lines.join("\n")}`;
  }

  /**
   * Clear accumulated events to free memory between goals.
   * Token totals and goal summaries are preserved — only the detailed event log
   * (which can grow very large during multi-task goals) is trimmed.
   */
  trimEventsForNextGoal(): void {
    // Keep only the last 5 events as recent context; discard the rest
    if (this.events.length > 5) {
      this.events.splice(0, this.events.length - 5);
    }
  }

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  /**
   * Check if isolation is needed but not configured. When max_workers > 1
   * and no isolation config exists, the caller should infer isolation
   * instructions from the project context before dispatching workers.
   */
  needsIsolationInference(): boolean {
    return !this.config.isolation && this.getMaxConcurrency() > 1;
  }

  /**
   * Store an inferred isolation config on the project config.
   * Called after a worker generates isolation instructions from
   * the project's overview, conventions, and constraints.
   */
  setIsolationConfig(isolation: { setup: string; verify: string; teardown: string; env?: Record<string, string> }): void {
    this.config.isolation = isolation;
    this.recordEvent("discovery_completed" as any, `Isolation config inferred: setup=${isolation.setup.slice(0, 80)}...`);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Run a discovery phase to understand project state before task decomposition.
   * Emits discovery_started and discovery_completed events.
   */
  async runDiscovery(
    commands: DiscoveryCommand[],
    goalId?: string,
  ): Promise<DiscoveryPhaseResult> {
    this.recordEvent("discovery_started", `Running ${commands.length} discovery command(s)`, {
      goal_id: goalId,
    });

    const result = await runDiscoveryFn(commands);

    this.recordEvent("discovery_completed", result.summary, {
      goal_id: goalId,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * Persist a checkpoint to disk. The caller supplies partial data (fields
   * that only the orchestration loop knows); the Orchestrator fills in
   * trust_level, cumulative_tokens, elapsed_ms, last_updated and the goal
   * publication records, so no save can drop them.
   */
  async saveCheckpoint(partial: Omit<Checkpoint, "trust_level" | "cumulative_tokens" | "elapsed_ms" | "last_updated" | "goal_publications">): Promise<void> {
    if (!this.checkpointDir) {
      throw new Error("No checkpointPath configured");
    }

    await mkdir(this.checkpointDir, { recursive: true });

    const checkpoint: Checkpoint = {
      ...partial,
      trust_level: this.config.trust_level,
      cumulative_tokens: this.cumulativeTokens,
      elapsed_ms: this.getElapsedMs(),
      last_updated: new Date().toISOString(),
      ...(this.goalPublications.length > 0 ? { goal_publications: this.getGoalPublications() } : {}),
    };

    const filePath = join(this.checkpointDir, "checkpoint.json");
    await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  /**
   * Load the most recent checkpoint from disk. Returns null if no
   * checkpoint file exists.
   */
  async loadCheckpoint(): Promise<Checkpoint | null> {
    if (!this.checkpointDir) {
      return null;
    }

    const filePath = join(this.checkpointDir, "checkpoint.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      const checkpoint = JSON.parse(raw) as Checkpoint;
      // Carried into every later save, so a resumed run keeps what it must
      // still publish and what it already did.
      this.goalPublications = Array.isArray(checkpoint.goal_publications)
        ? checkpoint.goal_publications.map((r) => ({ ...r }))
        : [];
      return checkpoint;
    } catch {
      // File doesn't exist or is unreadable — that's fine.
      return null;
    }
  }

  /** Delete the checkpoint file so the next run starts fresh. */
  async clearCheckpoint(): Promise<void> {
    this.goalPublications = [];
    if (!this.checkpointDir) return;
    const filePath = join(this.checkpointDir, "checkpoint.json");
    try {
      await unlink(filePath);
    } catch {
      // File doesn't exist — that's fine.
    }
  }

  // -------------------------------------------------------------------------
  // Goal publications (saved with the checkpoint)
  // -------------------------------------------------------------------------

  /** Every finished goal swarm publishes, in the order they finished. Copies. */
  getGoalPublications(): GoalPublication[] {
    return this.goalPublications.map((r) => ({ ...r }));
  }

  /** Record a finished goal, replacing any earlier record of the same goal
   *  (a goal re-run to completion), which moves it to the end. */
  recordGoalPublication(record: GoalPublication): void {
    this.goalPublications = [...this.goalPublications.filter((r) => r.goal_id !== record.goal_id), { ...record }];
  }

  /** Update a goal's record; a goal with no record is ignored. */
  updateGoalPublication(goalId: string, patch: Partial<Omit<GoalPublication, "goal_id">>): void {
    this.goalPublications = this.goalPublications.map((r) => (r.goal_id === goalId ? { ...r, ...patch } : r));
  }

  // -------------------------------------------------------------------------
  // Event recording
  // -------------------------------------------------------------------------

  /**
   * Record a structured orchestration event. Returns the created event
   * for the caller's convenience.
   */
  recordEvent(
    eventType: OrchestrationEventType,
    detail: string,
    extra?: Partial<Pick<OrchestrationEvent, "goal_id" | "task_id" | "tokens" | "cumulative_tokens" | "active_workers" | "escalation_reason" | "dispatch_directive" | "worktree_outcome">>,
  ): OrchestrationEvent {
    const event: OrchestrationEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      event_type: eventType,
      project: this.config.project,
      trust_level: this.config.trust_level,
      active_workers: extra?.active_workers ?? 0,
      detail,
      ...extra,
    };

    this.events.push(event);

    // Bridge to event bus for dashboard/telemetry
    this.eventBus?.emit("orchestration:event", {
      id: event.id,
      eventType: event.event_type,
      project: event.project,
      goalId: event.goal_id,
      taskId: event.task_id,
      trustLevel: event.trust_level,
      tokens: event.tokens,
      cumulativeTokens: event.cumulative_tokens,
      detail: event.detail ?? "",
      timestamp: Date.now(),
    });

    return event;
  }

  /** Returns a shallow copy of all recorded events. */
  getEvents(): OrchestrationEvent[] {
    return [...this.events];
  }

  // -------------------------------------------------------------------------
  // Parallel dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch tasks in parallel using a worker-pool pattern bounded by
   * `max_workers`. When `max_workers === 1`, tasks execute sequentially
   * and no worktrees are created.
   *
   * When tasks have `dependsOn` fields, the orchestrator builds a DAG and
   * dispatches tasks in topological tiers: all tasks in tier N run in
   * parallel (bounded by max_workers), and tier N+1 only starts after
   * tier N completes. If a task fails, all downstream dependents are skipped.
   *
   * Tasks without `dependsOn` are placed in tier 0 — behavior is unchanged
   * from the pre-DAG implementation when no dependencies are declared.
   */
  async dispatchParallel(options: ParallelDispatchOptions): Promise<ParallelDispatchResult> {
    // Validate prerequisites before dispatching any work
    const prereqResult = this.validatePrerequisites();
    if (prereqResult && !prereqResult.passed) {
      const names = prereqResult.hardBlocked.map((r) => r.check.name).join(", ");
      throw new Error(`Cannot dispatch — missing required prerequisites: ${names}`);
    }

    // Check if any tasks have explicit dependencies
    const hasDeps = options.tasks.some((t) => t.dependsOn && t.dependsOn.length > 0);

    // Check if serialization constraints could introduce implicit dependencies
    const hasSerializationConstraints =
      (this.config.serialization_constraints?.patterns?.length ?? 0) > 0 &&
      options.tasks.some((t) => t.serializedFiles && t.serializedFiles.length > 0);

    // Check if any tasks share the same serializedFiles entries (even without
    // explicit constraint patterns). Two tasks declaring the same file should
    // be serialized to prevent merge conflicts.
    const hasSharedFiles = (() => {
      const fileToTask = new Map<string, string>();
      for (const t of options.tasks) {
        if (!t.serializedFiles) continue;
        for (const f of t.serializedFiles) {
          if (fileToTask.has(f) && fileToTask.get(f) !== t.id) return true;
          fileToTask.set(f, t.id);
        }
      }
      return false;
    })();

    if (hasDeps || hasSerializationConstraints || hasSharedFiles) {
      return this._dispatchWithDAG(options);
    }

    // Original flat dispatch (no dependencies)
    return this._dispatchFlat(options);
  }

  // -------------------------------------------------------------------------
  // DAG-aware dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch tasks respecting dependency ordering via topological sort.
   * Tasks are grouped into tiers; each tier runs in parallel, then the
   * next tier is evaluated using getExecutableTasks (accounting for failures).
   */
  private async _dispatchWithDAG(options: ParallelDispatchOptions): Promise<ParallelDispatchResult> {
    const { tasks, abortSignal } = options;

    // Build DAG nodes from tasks
    let dagNodes: DAGNode[] = tasks.map((t) => ({
      id: t.id,
      dependsOn: t.dependsOn ?? [],
      serializedFiles: t.serializedFiles,
      createsFiles: t.createsFiles,
    }));

    // Load conflict history and inject learned serialization constraints.
    // Files that previously caused merge conflicts get added to the
    // serializedFiles of any node working in the same directory, so the
    // DAG automatically serializes tasks that touch them.
    if (this.conflictHistoryPath) {
      try {
        const conflictHistory = loadConflictHistory(this.conflictHistoryPath);
        const learnedFiles = getSerializationFiles(conflictHistory);
        if (learnedFiles.length > 0) {
          for (const node of dagNodes) {
            // Initialize serializedFiles if empty — all implementation tasks
            // could potentially touch learned conflict files
            if (!node.serializedFiles) {
              node.serializedFiles = [];
            }
            for (const f of learnedFiles) {
              if (!node.serializedFiles.includes(f)) {
                node.serializedFiles.push(f);
              }
            }
          }
        }
      } catch {
        // Conflict history loading is best-effort — don't block dispatch
      }
    }

    // Apply create → modify constraints — if task A creates file X and task B
    // modifies file X, B must wait for A. This prevents "file not found" errors
    // when tasks run concurrently.
    dagNodes = applyCreateModifyConstraints(dagNodes);

    // Apply serialization constraints — inject synthetic dependencies for
    // tasks that would concurrently modify conflict-prone files (e.g. pbxproj)
    const constraintPatterns = this.config.serialization_constraints?.patterns ?? [];
    if (constraintPatterns.length > 0) {
      dagNodes = applySerializationConstraints(dagNodes, constraintPatterns);
    }

    // Apply shared-file constraints — serialize tasks that declare the same
    // file in serializedFiles, even if no explicit constraint pattern matches.
    // This prevents merge conflicts when two tasks modify the same source file.
    dagNodes = applySharedFileConstraints(dagNodes);

    // Validate the DAG
    const validation = validateDAG(dagNodes);
    if (!validation.valid) {
      throw new Error(`Invalid task dependency graph: ${validation.error}`);
    }

    // Build task lookup
    const taskMap = new Map<string, Task>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    const completed: Array<{ task: Task; result: SwarmOversightRunResult }> = [];
    const failed: Array<{ task: Task; error: Error }> = [];
    const skipped: Task[] = [];
    let totalTokens = 0;

    const completedIds = new Set<string>();
    const failedIds = new Set<string>();
    let consecutiveFailures = 0;
    let replanAttempted = false;

    // Recompute tiers after each round to support mid-dispatch replanning.
    // Instead of pre-computing all tiers once, we compute one tier at a time
    // from the remaining (non-completed, non-failed) nodes.
    while (true) {
      // Check abort signal
      if (abortSignal?.aborted) {
        for (const node of dagNodes) {
          if (!completedIds.has(node.id) && !failedIds.has(node.id)) {
            const task = taskMap.get(node.id);
            if (task) skipped.push(task);
          }
        }
        break;
      }

      // Filter to remaining nodes and re-sort
      const remainingNodes = dagNodes.filter(
        (n) => !completedIds.has(n.id) && !failedIds.has(n.id),
      );
      if (remainingNodes.length === 0) break;

      // Determine which tasks are executable
      const { executable, skipped: globallySkipped } = getExecutableTasks(
        dagNodes,
        completedIds,
        failedIds,
      );

      // Record skipped tasks
      for (const skipId of globallySkipped) {
        if (!completedIds.has(skipId) && !failedIds.has(skipId)) {
          const task = taskMap.get(skipId);
          if (task) {
            skipped.push(task);
            this.recordEvent("task_skipped_dependency", `Task "${skipId}" skipped: dependency failed`, {
              task_id: skipId,
            });
          }
          failedIds.add(skipId);
        }
      }

      if (executable.length === 0) {
        // All remaining tasks are blocked with no executable ones — deadlock
        for (const node of remainingNodes) {
          if (!failedIds.has(node.id)) {
            const task = taskMap.get(node.id);
            if (task) skipped.push(task);
            failedIds.add(node.id);
          }
        }
        break;
      }

      // Enforce per-goal token limit
      if (this.isGoalTokenExceeded(totalTokens)) {
        for (const node of remainingNodes) {
          const task = taskMap.get(node.id);
          if (task) {
            skipped.push(task);
            this.recordEvent("task_skipped_dependency", `Task "${node.id}" skipped: goal token limit reached`, {
              task_id: node.id,
            });
          }
          failedIds.add(node.id);
        }
        break;
      }

      // Dispatch executable tasks using the flat dispatch logic
      const tierTasks = executable.map((id) => {
        const task = taskMap.get(id);
        if (!task) throw new Error(`Internal DAG error: task "${id}" missing from taskMap`);
        return task;
      });
      const tierResult = await this._dispatchFlat({
        ...options,
        tasks: tierTasks,
      });

      // Merge results
      let tierHadFailures = false;
      for (const c of tierResult.completed) {
        completed.push(c);
        completedIds.add(c.task.id);
        totalTokens += resultTokens(c.result);
        consecutiveFailures = 0; // Reset on success
      }
      for (const f of tierResult.failed) {
        failed.push(f);
        failedIds.add(f.task.id);
        consecutiveFailures++;
        tierHadFailures = true;
      }
      for (const s of tierResult.skipped) {
        skipped.push(s);
        if (!completedIds.has(s.id) && !failedIds.has(s.id)) {
          this.recordEvent("task_failed", `Task "${s.id}" skipped during dispatch`, {
            task_id: s.id,
          });
          failedIds.add(s.id);
        }
      }

      // Mid-goal replanning: after 3 consecutive failures, try to reorder
      if (consecutiveFailures >= 3 && tierHadFailures && !replanAttempted) {
        replanAttempted = true; // Only attempt once per dispatch
        // Check if dynamic edges can unblock tasks
        const { analyzeGoalResults, categorizeFailure } = await import("./replan.js");
        const replanResults = failed.map((f) => {
          const output = f.task.result?.output ?? "";
          const failureReason = f.error.message;
          return {
            taskId: f.task.id,
            status: "failed" as const,
            failureReason,
            output,
            failureCategory: categorizeFailure(output, failureReason),
            retryCount: f.task.result?.retry_count ?? 0,
          };
        });
        const decision = analyzeGoalResults(replanResults, 0, 2, tasks);
        if (decision.action === "reorder_with_edges" && decision.newEdges) {
          // Inject dynamic edges and continue — the while loop will re-sort
          dagNodes = injectDynamicEdges(dagNodes, decision.newEdges);
          const revalidation = validateDAG(dagNodes);
          if (revalidation.valid) {
            this.recordEvent("replan_triggered", `Injected ${decision.newEdges.length} dynamic edge(s): ${decision.reason}`);
            // Reset failed tasks involved in replanning so they can retry.
            // Both the blocked task (edge.to) AND its new dependency (edge.from)
            // need to be retried — if edge.from already failed, keeping it in
            // failedIds would cause edge.to to be skipped as a dependent.
            for (const edge of decision.newEdges) {
              failedIds.delete(edge.to);
              failedIds.delete(edge.from);
            }
            consecutiveFailures = 0;
            continue; // Re-enter the loop with new DAG
          }
          // If revalidation fails (cycle), fall through to normal processing
        }
      }
    }

    return { completed, failed, skipped, totalTokens };
  }

  // -------------------------------------------------------------------------
  // Flat dispatch (no dependency ordering)
  // -------------------------------------------------------------------------

  /**
   * Original flat dispatch: all tasks are placed in a single pool and
   * dispatched up to max_workers at a time with no ordering constraints.
   */
  private async _dispatchFlat(options: ParallelDispatchOptions): Promise<ParallelDispatchResult> {
    const maxWorkers = this.getMaxConcurrency();
    const { tasks, executeTask, worktreeManager, onTaskComplete, abortSignal, taskTimeoutMs, onTaskTimeout, rateLimitGate } = options;

    const queue = [...tasks];
    const active = new Map<string, Promise<{ task: Task; result?: SwarmOversightRunResult; error?: Error; timedOut?: boolean }>>();
    const completed: Array<{ task: Task; result: SwarmOversightRunResult }> = [];
    const failed: Array<{ task: Task; error: Error }> = [];
    const skipped: Task[] = [];
    let totalTokens = 0;
    let goalTokens = 0;

    const useWorktrees = maxWorkers > 1 && !!worktreeManager;

    while (queue.length > 0 || active.size > 0) {
      // Check abort signal
      if (abortSignal?.aborted) {
        // Skip remaining queued tasks
        skipped.push(...queue.splice(0));
        break;
      }

      // Fill worker pool up to max_workers
      while (queue.length > 0 && active.size < maxWorkers) {
        // Wait for the global rate limit gate before starting new work
        if (rateLimitGate?.isLimited()) {
          await rateLimitGate.wait();
        }

        // Check the session token limit before dispatching
        if (this.isSessionTokenExceeded(this.cumulativeTokens)) {
          skipped.push(...queue.splice(0));
          break;
        }

        // Check the goal token limit
        if (this.isGoalTokenExceeded(goalTokens)) {
          skipped.push(...queue.splice(0));
          break;
        }

        const task = queue.shift()!;

        // Determine working directory
        let workingDir = options.workingDirectory;
        if (useWorktrees) {
          try {
            const wtInfo = await worktreeManager!.create(task.id, options.baseBranch);
            workingDir = wtInfo.path;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            failed.push({ task, error });
            try { await onTaskComplete?.(task, null, error); } catch { /* ignore */ }
            continue;
          }
        }

        // Launch task execution, optionally wrapped in a timeout (SDK-25)
        const taskPromise = (async (): Promise<{ task: Task; result?: SwarmOversightRunResult; error?: Error; timedOut?: boolean }> => {
          // Resolve per-task timeout: function form uses the task's actual complexity
          const resolvedTimeout = typeof taskTimeoutMs === "function"
            ? taskTimeoutMs(task)
            : taskTimeoutMs;

          try {
            if (resolvedTimeout && resolvedTimeout > 0) {
              // Race the task against a timeout, clearing the timer on completion
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new TaskTimeoutError(resolvedTimeout)), resolvedTimeout);
              });
              try {
                const result = await Promise.race([
                  executeTask(task, workingDir),
                  timeoutPromise,
                ]);
                return { task, result };
              } finally {
                if (timer !== undefined) clearTimeout(timer);
              }
            }
            const result = await executeTask(task, workingDir);
            return { task, result };
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const timedOut = error instanceof TaskTimeoutError;
            return { task, error, timedOut };
          }
        })();

        active.set(task.id, taskPromise);

        // Emit task_dispatched with accurate post-addition active worker count
        this.recordEvent("task_dispatched", `Task "${task.id}" dispatched`, {
          task_id: task.id,
          active_workers: active.size,
        });
      }

      if (active.size === 0) break;

      // Wait for at least one worker to finish, racing against the
      // dispatch-loop heartbeat. Without this race, a wedged worker (e.g.,
      // the claude.exe SDK failing to translate its own queryTimeoutMs into
      // a rejected promise — observed in production) hangs Promise.race
      // forever and the entire dispatch goes silent. The watchdog forces
      // the race to resolve, marks every currently-active worker as failed,
      // and lets the loop continue with the queue.
      const wedgedIds = [...active.keys()];
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const heartbeatPromise = new Promise<never>((_, reject) => {
        heartbeatTimer = setTimeout(
          () => reject(new WorkerWedgedError(wedgedIds, this.workerHeartbeatMs)),
          this.workerHeartbeatMs,
        );
      });

      let settled: { task: Task; result?: SwarmOversightRunResult; error?: Error; timedOut?: boolean };
      try {
        settled = await Promise.race([
          ...active.values(),
          heartbeatPromise,
        ]);
      } catch (err) {
        if (err instanceof WorkerWedgedError) {
          this.recordEvent(
            "task_wedged",
            `No worker settled within ${err.heartbeatMs}ms heartbeat — ${err.activeTaskIds.length} task(s) wedged: ${err.activeTaskIds.join(", ")}`,
            { active_workers: 0 },
          );
          // Mark each wedged active worker as failed and clear the map so
          // the loop can continue. The underlying promises are intentionally
          // leaked — they may eventually settle in the background, but they
          // no longer block dispatch. The next iteration picks up the next
          // queued task.
          for (const id of err.activeTaskIds) {
            const wedgedTask = tasks.find((t) => t.id === id);
            if (!wedgedTask) continue;
            failed.push({ task: wedgedTask, error: err });
            this.recordEvent(
              "task_failed",
              `Task "${id}" failed: ${err.message}`,
              { task_id: id, active_workers: 0 },
            );
            if (useWorktrees) {
              try { await worktreeManager!.cleanup(id, false); } catch { /* ignore */ }
            }
            try { await onTaskComplete?.(wedgedTask, null, err); } catch { /* ignore */ }
          }
          active.clear();
          continue;
        }
        throw err;
      } finally {
        if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      }

      // Remove completed task from active map BEFORE emitting events,
      // so active_workers reflects the post-cleanup count
      active.delete(settled.task.id);

      // Process result
      if (settled.error) {
        // SDK-25: If the task timed out and we have a decomposition callback,
        // attempt to break it into sub-tasks and enqueue them.
        if (settled.timedOut && onTaskTimeout && !settled.task.parentTaskId) {
          const timedOutMs = settled.error instanceof TaskTimeoutError ? settled.error.timeoutMs : "unknown";
          this.recordEvent("task_timeout", `Task "${settled.task.id}" timed out after ${timedOutMs}ms — attempting decomposition`, {
            task_id: settled.task.id,
            active_workers: active.size,
          });

          try {
            const subTasks = await onTaskTimeout(settled.task);
            if (subTasks.length > 0) {
              this.recordEvent("task_timeout_decomposed", `Decomposed timed-out task "${settled.task.id}" into ${subTasks.length} sub-tasks`, {
                task_id: settled.task.id,
                active_workers: active.size,
              });
              // Enqueue sub-tasks at the front of the queue
              queue.unshift(...subTasks);

              if (useWorktrees) {
                // Force destroy the parent worktree — sub-tasks will get their own.
                // Using cleanup(id, false) leaves it "active" which inflates the worker count.
                try { await worktreeManager!.destroy(settled.task.id); } catch { /* ignore */ }
              }
              // Don't call onTaskComplete for the parent — the sub-tasks replace it
              continue;
            }
          } catch {
            // Decomposition failed — fall through to normal failure handling
          }
        }

        // If the failure is a rate limit, close the global gate so all
        // other pending dispatches pause until the limit resets.
        if (rateLimitGate && settled.error instanceof RateLimitError) {
          rateLimitGate.trigger(settled.error.resetAt.getTime(), settled.error.waitMs);
        } else if (rateLimitGate && (
          settled.error.message.includes("rate limit") ||
          settled.error.message.includes("resets soon") ||
          settled.error.message.includes("429")
        )) {
          // Heuristic fallback for backends that throw plain errors: default 60s
          rateLimitGate.trigger(Date.now() + 60_000, 60_000);
        }

        failed.push({ task: settled.task, error: settled.error });

        // Emit task_failed with post-cleanup active worker count
        this.recordEvent("task_failed", `Task "${settled.task.id}" failed: ${settled.error.message}`, {
          task_id: settled.task.id,
          active_workers: active.size,
        });

        // Fire-and-forget: record failed TaskExecution in Substrate
        this.substrateMutate("createTaskExecution", {
          goalId: settled.task.goal_id,
          sessionId: this.sessionId,
          workerResultId: "",
          status: "failed",
          retries: settled.task.result?.retry_count ?? 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });

        if (useWorktrees) {
          try { await worktreeManager!.cleanup(settled.task.id, false); } catch { /* ignore */ }
        }

        await onTaskComplete?.(settled.task, null, settled.error);
      } else if (settled.result) {
        const taskTokens = resultTokens(settled.result);
        totalTokens += taskTokens;
        goalTokens += taskTokens;
        this.addTokens(taskTokens);

        completed.push({ task: settled.task, result: settled.result });

        // Emit task_completed with post-cleanup active worker count
        this.recordEvent("task_completed", `Task "${settled.task.id}" completed`, {
          task_id: settled.task.id,
          tokens: taskTokens,
          cumulative_tokens: this.cumulativeTokens,
          active_workers: active.size,
        });

        // Fire-and-forget: record completed TaskExecution in Substrate
        this.substrateMutate("createTaskExecution", {
          goalId: settled.task.goal_id,
          sessionId: this.sessionId,
          workerResultId: "",
          status: "completed",
          retries: settled.result.oversight.retryCount ?? 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });

        if (useWorktrees) {
          const verdictOk = SUCCESS_VERDICTS.has(settled.result.oversight.verdict);
          if (verdictOk) {
            // Track whether the worker actually produced staged content
            // (investigation tasks legitimately write nothing — commitChanges
            // throws "no changes" in that case). Only count toward
            // commitsByGoal if BOTH commitChanges and merge succeeded;
            // anything less means no committed work landed on the goal's
            // branch and ghost-completion should still fire.
            let commitChangesLanded = false;
            try {
              await worktreeManager!.commitChanges(
                settled.task.id,
                taskCommitSubject(settled.task, this.config.source_control?.commit_style),
              );
              commitChangesLanded = true;
            } catch { /* no changes to commit — ok for investigation tasks */ }

            // Merge and check result — a merge conflict means the task failed
            // even though the worker succeeded. This feeds into the replanner.
            const mergeResult = await worktreeManager!.merge(settled.task.id);
            if (!mergeResult.success) {
              this.recordEvent("task_merge_conflict", `Task "${settled.task.id}" merge conflict on files: ${(mergeResult.conflictFiles ?? []).join(", ")}`, {
                task_id: settled.task.id,
                active_workers: active.size,
              });
              // Move from completed to failed so replanner sees the conflict
              const idx = completed.findLastIndex(e => e.task.id === settled.task.id);
              if (idx !== -1) completed.splice(idx, 1);
              const mergeConflictError = new Error(`Merge conflict: ${(mergeResult.conflictFiles ?? []).join(", ")}`);
              failed.push({
                task: settled.task,
                error: mergeConflictError,
              });
              await onTaskComplete?.(settled.task, null, mergeConflictError);
            } else {
              if (commitChangesLanded) {
                this.incrementCommitCount(settled.task.goal_id);
              }
              await worktreeManager!.destroy(settled.task.id, true);
              await onTaskComplete?.(settled.task, settled.result);
            }
          } else {
            // Task failed oversight — leave worktree for inspection
            try { await worktreeManager!.cleanup(settled.task.id, false); } catch { /* ignore */ }
            await onTaskComplete?.(settled.task, settled.result);
          }
        } else {
          // Live-repo path (no worktrees): commit success-verdict tasks
          // directly to this.repoRoot so work survives crash/restart and a
          // running swarm produces a real git history operators can review.
          // No-ops if repoRoot is unset (e.g., in tests).
          const verdictOk = SUCCESS_VERDICTS.has(settled.result.oversight.verdict);
          if (verdictOk) {
            await this.commitLiveRepo(settled.task, { goalBranch: options.goalBranch });
          }
          await onTaskComplete?.(settled.task, settled.result);
        }
      }
    }

    // Wait for remaining active workers to finish if we broke out of the loop
    if (active.size > 0) {
      const remaining = await Promise.allSettled([...active.values()]);
      for (const r of remaining) {
        if (r.status === "fulfilled") {
          const settled = r.value;
          active.delete(settled.task.id);
          if (settled.error) {
            failed.push({ task: settled.task, error: settled.error });
            this.recordEvent("task_failed", `Task "${settled.task.id}" failed: ${settled.error.message}`, {
              task_id: settled.task.id,
              active_workers: active.size,
            });
          } else if (settled.result) {
            const taskTokens = resultTokens(settled.result);
            totalTokens += taskTokens;
            this.addTokens(taskTokens);
            completed.push({ task: settled.task, result: settled.result });
            this.recordEvent("task_completed", `Task "${settled.task.id}" completed`, {
              task_id: settled.task.id,
              tokens: taskTokens,
              cumulative_tokens: this.cumulativeTokens,
              active_workers: active.size,
            });
          }
          if (useWorktrees) {
            const verdictOk = settled.result && SUCCESS_VERDICTS.has(settled.result.oversight.verdict);
            if (verdictOk) {
              // Mirror the main loop's commit-counting logic: only count
              // toward commitsByGoal when both commitChanges staged real
              // work AND merge succeeded onto the orchestrator's branch.
              let commitChangesLanded = false;
              try {
                await worktreeManager!.commitChanges(
                  settled.task.id,
                  taskCommitSubject(settled.task, this.config.source_control?.commit_style),
                );
                commitChangesLanded = true;
              } catch { /* no changes to commit — ok for investigation tasks */ }

              const mergeResult = await worktreeManager!.merge(settled.task.id);
              if (!mergeResult.success) {
                this.recordEvent("task_merge_conflict", `Task "${settled.task.id}" merge conflict on files: ${(mergeResult.conflictFiles ?? []).join(", ")}`, {
                  task_id: settled.task.id,
                  active_workers: active.size,
                });
                const idx = completed.findLastIndex(e => e.task.id === settled.task.id);
                if (idx !== -1) completed.splice(idx, 1);
                const mergeConflictError = new Error(`Merge conflict: ${(mergeResult.conflictFiles ?? []).join(", ")}`);
                failed.push({
                  task: settled.task,
                  error: mergeConflictError,
                });
                await onTaskComplete?.(settled.task, null, mergeConflictError);
              } else {
                if (commitChangesLanded) {
                  this.incrementCommitCount(settled.task.goal_id);
                }
                await worktreeManager!.destroy(settled.task.id, true);
                await onTaskComplete?.(settled.task, settled.result!);
              }
            } else {
              try { await worktreeManager!.cleanup(settled.task.id, false); } catch { /* ignore */ }
              await onTaskComplete?.(settled.task, settled.result ?? null, settled.error);
            }
          } else {
            // Live-repo path (no worktrees): commit success-verdict tasks
            // directly to this.repoRoot — same logic as the main loop above.
            const verdictOk = settled.result && SUCCESS_VERDICTS.has(settled.result.oversight.verdict);
            if (verdictOk) {
              await this.commitLiveRepo(settled.task, { goalBranch: options.goalBranch });
            }
            await onTaskComplete?.(settled.task, settled.result ?? null, settled.error);
          }
        }
      }
    }

    return { completed, failed, skipped, totalTokens };
  }
}

// ---------------------------------------------------------------------------
// Parallel dispatch types
// ---------------------------------------------------------------------------

export interface ParallelDispatchOptions {
  tasks: Task[];
  goal: Goal;
  project: string;
  workingDirectory: string;
  worktreeManager?: WorktreeManager;
  /** Git branch to use as base for worktrees. Defaults to current HEAD. */
  baseBranch?: string;
  /**
   * The branch that live-repo commits for this dispatch should land on.
   * Passed straight through to `commitLiveRepo` so each goal's commits
   * land on its `swarm-worker/goal-N` branch in stack-PR mode. Null /
   * undefined = commit on current HEAD (the non-stack default).
   */
  goalBranch?: string | null;
  abortSignal?: AbortSignal;
  onTaskComplete?: (task: Task, result: SwarmOversightRunResult | null, error?: Error) => Promise<void>;
  /** Externally-provided task execution function. */
  executeTask: (task: Task, workingDirectory: string) => Promise<SwarmOversightRunResult>;
  /**
   * SDK-25: Per-task timeout in milliseconds. When a task exceeds this timeout,
   * it is aborted and (if `onTaskTimeout` is provided) may be sub-decomposed.
   *
   * Can be a static number (same timeout for all tasks) or a function that
   * returns a timeout based on the task (e.g., scaled by complexity band).
   */
  taskTimeoutMs?: number | ((task: Task) => number);
  /**
   * SDK-25: Callback invoked when a task times out. Return replacement sub-tasks
   * to enqueue, or an empty array to simply fail the task.
   */
  onTaskTimeout?: (task: Task) => Promise<Task[]>;
  /**
   * Global rate limit gate. When provided, each new dispatch will
   * wait for the gate to open before starting. When a task fails with a rate
   * limit error, the gate is triggered so all other pending dispatches pause.
   */
  rateLimitGate?: RateLimitGate;
}

export interface ParallelDispatchResult {
  completed: Array<{ task: Task; result: SwarmOversightRunResult }>;
  failed: Array<{ task: Task; error: Error }>;
  skipped: Task[];
  /** Tokens the completed tasks used: all input (cache included) plus output. */
  totalTokens: number;
}

/** A task result's tokens as the budgets count them: all input (fresh,
 *  cache reads, cache writes) plus output. */
function resultTokens(result: SwarmOversightRunResult): number {
  return result.tokensUsed.input + result.tokensUsed.output;
}
