/**
 * Goal, task, orchestration, autonomy, prerequisite, worktree, project config,
 * and related types.
 */

import type {
  BackendsConfig,
  TokenBreakdown,
} from "./config.js";
import type { LabelsConfig } from "./goal-label.js";
import type { LeftForPersonGroup } from "./left-for-person.js";

// ---------------------------------------------------------------------------
// Complexity estimation types
// ---------------------------------------------------------------------------

export type ComplexityBand = "simple" | "moderate" | "complex";

export interface ComplexitySignal {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
}

export interface ComplexityEstimate {
  score: number;
  band: ComplexityBand;
  signals: ComplexitySignal[];
  reasoning: string;
}

export interface ComplexityThresholds {
  simpleMax: number;
  complexMin: number;
  /** Share of the task token limit at which a running task escalates. */
  tokenEscalationFraction: number;
  turnEscalationFraction: number;
  timeoutEscalationFraction: number;
}

export type EscalationReason =
  | "token_threshold"
  | "reviewer_rejection"
  | "timeout_threshold"
  | "turn_threshold"
  | "complexity_preemptive";

// ---------------------------------------------------------------------------
// Trust and project configuration types
// ---------------------------------------------------------------------------

export type TrustLevel = "low" | "medium" | "high";

export type ContextDepth = "full" | "standard" | "lean";

export type SkillTier = "core" | "vetted" | "community";

/**
 * Token limits count all input tokens (fresh input, cache reads and cache
 * writes) plus output tokens. Each is optional: one left out takes its value
 * from the trust level's autonomy preset, so every level always has a limit.
 */
export interface ConcurrencyConfig {
  max_workers: number;
  /** Per-tool-call wedge threshold in ms. When a single tool call (e.g.,
   *  Bash running `pnpm verify:vercel` that hangs against a stale
   *  port-3000 server) exceeds this, the task's AbortController fires and
   *  the worker subprocess (plus its process-group descendants) gets
   *  reaped. Distinct from `max_tokens_per_task` (token-based)
   *  and `workerHeartbeatMs` (whole-loop-based, default 30 min). Default:
   *  300_000 (5 min). Set to 0 to disable.
   *
   *  Currently honored for `max_workers: 1`. Multi-worker setups need
   *  per-task event correlation, which is not built yet. */
  tool_call_timeout_ms?: number;
  /** Tokens one session may use before it pauses. */
  max_tokens_per_session?: number;
  /** Tokens one goal may use before its remaining tasks are skipped. */
  max_tokens_per_goal?: number;
  /** Tokens one task may use before the run asks whether to raise the limit. */
  max_tokens_per_task?: number;
}

/**
 * Serialization constraint for conflict-prone files.
 *
 * File path patterns (globs) that must not be modified by multiple tasks in
 * parallel. When two tasks in the same DAG tier both declare they will touch
 * a file matching one of these patterns, the orchestrator injects a synthetic
 * dependency so they execute sequentially instead of concurrently.
 *
 * Common examples: `*.pbxproj`, `package-lock.json`, `Cargo.lock`.
 */
export interface SerializationConstraint {
  /** Glob patterns for conflict-prone files. Supports `*` (any characters
   *  except `/`), `**` (any characters including `/` — cross-directory), and
   *  `?` (single non-separator character) wildcards. */
  patterns: string[];
}

export interface TaskBackendConfig {
  type: "local" | "github" | "trello";
  /** For github type: "owner/repo". */
  repo?: string;
  /** When true, swarm creates new tasks as GitHub issues. Default: false. */
  createTasks?: boolean;
  /** For trello type: where goals come from and how cards are moved. */
  trello?: TrelloSourceConfig;
  /** How goals are named on the live dashboard's badges. Absent: each
   *  ticket's id from its URL. */
  labels?: LabelsConfig;
}

/**
 * Trello as a goal source. Swarm never talks to the Trello API itself: it
 * runs the project's own Trello CLI, which holds the credentials and decides
 * which boards may be touched. The CLI must provide `cards BOARD --list NAME`,
 * `show CARD`, `update CARD --list NAME` and `comment CARD --text TEXT`, each
 * printing JSON.
 */
export interface TrelloSourceConfig {
  /** argv of the Trello CLI, run from the work repo root,
   *  e.g. ["./bin/trello-cli"]. */
  command: string[];
  /** Boards to take work from, in priority order. */
  boards: string[];
  /** Column swarm takes work from. Default: "To Do". */
  queue_list?: string;
  /** Cards taken from the top of each board's queue per run. Default: 1. */
  per_board?: number;
  /** Column a card moves to for each status. Defaults: Doing, Review, Blocked, Done.
   *  `pending` has no default: swarm never moves a card back to the queue. */
  lists?: TrelloStatusLists;
}

/** A source item's status as swarm reports it. "merged": the goal's PR was
 *  merged (source_control.merge_prs). */
export type ExternalItemStatus = "pending" | "in_progress" | "completed" | "failed" | "merged";

export interface TrelloStatusLists {
  pending?: string;
  in_progress?: string;
  completed?: string;
  failed?: string;
  /** Where a card goes once its PR is merged (source_control.merge_prs with
   *  after_merge "done"). Default: "Done". */
  merged?: string;
}

// ---------------------------------------------------------------------------
// Prerequisite types
// ---------------------------------------------------------------------------

export interface PrerequisiteCheck {
  /** Name of the prerequisite (env var name or service name). */
  name: string;
  /** Type of check: environment variable or running service. */
  type: "env_var" | "service";
  /** If true, failure blocks execution entirely. */
  required: boolean;
  /** If true, the prerequisite can be mocked/stubbed and is a soft block. */
  mockable: boolean;
}

export interface PrerequisiteResult {
  check: PrerequisiteCheck;
  available: boolean;
  detail: string;
}

export interface PrerequisiteValidation {
  passed: boolean;
  results: PrerequisiteResult[];
  hardBlocked: PrerequisiteResult[];
  softBlocked: PrerequisiteResult[];
}

// ---------------------------------------------------------------------------
// Source control configuration types
// ---------------------------------------------------------------------------

export interface SourceControlConfig {
  /** Branching strategy for completed work.
   *  - "ephemeral": Default. Worktrees destroyed, no branches survive.
   *  - "local_branch": Session branch created locally, accumulates all work.
   *  - "remote_pr": Like local_branch but pushes to remote and opens PRs. */
  strategy: "ephemeral" | "local_branch" | "remote_pr";
  /** Git remote name. Default: "origin". */
  remote?: string;
  /** Base branch for session branches. Default: "main". */
  base_branch?: string;
  /** Prefix for session branch names. Default: "swarm/". */
  branch_prefix?: string;
  /** Whether to auto-push on goal complete (remote_pr only). Default: true. */
  auto_push?: boolean;
  /** Whether to open a PR on goal complete (remote_pr only). Default: true. */
  pr_on_goal_complete?: boolean;
  /** Base each goal's task worktrees on the previous goal's branch instead
   *  of `base_branch`, so multi-goal runs produce a stacked-PR chain rather
   *  than N independent PRs that all target main and conflict with each
   *  other. Default: false.
   *
   *  When true, swarm creates a stable branch per goal (named via
   *  `branch_prefix` + `goal-${goalId}`), uses it as the merge target for
   *  every task in that goal, and feeds it as the base for the next goal's
   *  worktrees. Requires `strategy: "remote_pr"`: swarm pushes each goal's
   *  branch and opens its stacked PR at session end. Workers have no GitHub
   *  access, so stack_prs with any other strategy is refused at startup.
   *
   *  Set to false to revert to the pre-stacking behavior: every goal's
   *  worktrees branch directly off `base_branch`, and any task auto-merges
   *  land back on `base_branch` regardless of run position. */
  stack_prs?: boolean;
  /** Author AND committer for every commit swarm makes in the work repo
   *  (live-repo task commits, worktree task commits and merges, the initial
   *  commit of an empty repo). Overrides the repo's git config and any
   *  inherited GIT_AUTHOR_* / GIT_COMMITTER_* environment. Unset: git's
   *  usual resolution applies. */
  git_identity?: GitIdentity;
  /** Subject format for swarm's commits. Default: "swarm".
   *  - "swarm": `swarm(<task-id>): <title>`.
   *  - "conventional": the task title when it is already a Conventional
   *    Commit subject (`type(scope): summary`), else `chore(swarm): <title>`;
   *    decomposition asks for Conventional Commit task titles. */
  commit_style?: CommitStyle;
  /** The GitHub login swarm's own GitHub operations run as: opening PRs,
   *  reading and writing issues for the GitHub task backend, and pushing to
   *  an HTTPS GitHub remote. At run start swarm takes this account's token
   *  from gh (`gh auth token --user <login>`), checks it belongs to the
   *  account and that the account can see the work repo's remote, and stops
   *  the run if not. The token is held in memory and passed only to those
   *  calls. Unset: gh's active account is used, as before, and the preflight
   *  banner names it. Workers get no GitHub access either way. */
  github_account?: string;
  /** Where pull requests live. Default and, so far, only value: "github"
   *  (through the `gh` CLI). Another host is one more implementation of
   *  CodeHost in the orchestrator. */
  code_host?: "github";
  /** Merge each goal's pull request as soon as the goal is done, so the next
   *  goal starts from the updated base branch and nothing stacks. Off unless
   *  `merge_prs.enabled` is true. Requires `strategy: "remote_pr"` and a
   *  `github_account`, and cannot be combined with `stack_prs`. */
  merge_prs?: MergePrsConfig;
}

/**
 * Merge-as-you-go. For each goal that is done, swarm pushes its branch, opens
 * its PR against `base_branch`, merges the latest base into the branch, runs
 * the merge gate and, when the gate passes, merges the PR as
 * `github_account`. A goal that is not eligible, conflicts with the base,
 * fails the gate or fails to merge keeps its open PR, and the run continues
 * with the next goal from the base branch.
 */
export interface MergePrsConfig {
  /** Default: false. */
  enabled?: boolean;
  /** The command that must pass before a PR is merged, run in the work repo
   *  on the goal branch after the base has been merged into it. Required when
   *  `enabled` is true. */
  gate?: MergePrsGateConfig;
  /** Source labels that keep a goal's PR open for a person to merge.
   *  Matched case-insensitively, ignoring spaces around a colon.
   *  Default: ["swarm_merge: false"]. */
  skip_labels?: string[];
  /** Where the goal's source item goes once its PR is merged. "done": the
   *  source's merged status (Trello: the `merged` column, default "Done").
   *  "review": it stays where the PR left it, for boards where a deploy
   *  follows the merge. Default: "done". */
  after_merge?: "done" | "review";
  /** Rounds of bringing the base in, gating, checking the base and merging
   *  before swarm leaves the pull request open because the base kept moving.
   *  Default: 3. */
  max_rounds?: number;
  /** Hand a conflict with the base back to a worker (then the reviewer)
   *  instead of leaving the pull request open. Default: true. */
  resolve_conflicts?: boolean;
  /** How many conflict hand-backs one merge may make. Default: 2. */
  max_conflict_rounds?: number;
}

/** The merge gate: one shell command. */
export interface MergePrsGateConfig {
  /** Run with `sh -c`. */
  command: string;
  /** Working directory, relative to the work repo root. Default: the root. */
  cwd?: string;
  /** Extra environment for the command, added to swarm's own. */
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. Default: 3600000 (1 hour). */
  timeout_ms?: number;
}

/**
 * Why swarm left a merge-mode pull request open. `conflict`,
 * `base_kept_moving` and `refused` are retried by a later run or
 * `swarm merge`; `gate_failed` and `ineligible` only when a person asks.
 */
export type LeftOpenKind = "gate_failed" | "conflict" | "base_kept_moving" | "refused" | "ineligible" | "closed" | "head_changed";

/** A git author/committer identity. */
export interface GitIdentity {
  name: string;
  email: string;
}

export type CommitStyle = "swarm" | "conventional";

// ---------------------------------------------------------------------------
// Telemetry sharing types
// ---------------------------------------------------------------------------

export type TelemetrySharingIdentity =
  | { type: "github"; github_username: string; telemetry_id?: never }
  | { type: "anonymous"; telemetry_id: string; github_username?: never };

export interface TelemetrySharingConfig {
  enabled: boolean;
  share_logs?: boolean;
  share_trees?: boolean;
  share_context?: boolean;
  share_transcripts?: boolean;
  identity?: TelemetrySharingIdentity;
}

/** When the arbiter rules. "on_disagreement" (default): only when the reviewer
 *  still rejects after the worker's retries. "always": also signs off on every
 *  task the reviewer approves. */
export type ArbiterPolicy = "on_disagreement" | "always";

export interface ProjectConfig {
  project: string;
  swarm_path: string;
  trust_level: TrustLevel;
  concurrency: ConcurrencyConfig;
  task_backend: "local" | "github" | "trello";
  /** Extended task backend configuration. When provided, takes precedence over `task_backend`. */
  taskBackendConfig?: TaskBackendConfig;
  /** Oversight chain settings. */
  oversight?: {
    /** When the arbiter rules. See {@link ArbiterPolicy}. Default "on_disagreement". */
    arbiter?: ArbiterPolicy;
  };
  /** Model configuration. Override in config.json. */
  models?: {
    /** Model for Worker agents. Default: claude-sonnet-4-6 */
    worker?: string;
    /** Model for Reviewer agents. Default: claude-sonnet-4-6 */
    reviewer?: string;
    /** Model for Arbiter agents. Default: claude-opus-4-6 */
    arbiter?: string;
    /** Provider for all models. Default: anthropic */
    provider?: "anthropic" | "openai";
  };
  backends?: BackendsConfig;
  /** Git branch to use as base for worktrees. Defaults to current HEAD. */
  base_branch?: string;
  /** Work repo swarm operates on, decoupled from process.cwd().
   *  Overridden by the `--repo-path` CLI flag. Lets a swarm config live in one
   *  repo and drive a different work repo. Defaults to cwd when unset. */
  repo_root?: string;
  /** Alias for `repo_root` (lower precedence). Accepted for configs that use
   *  the `project_root` spelling. */
  project_root?: string;
  /** Serialization constraints for conflict-prone files. Tasks that declare
   *  they will modify files matching these patterns are serialized in the DAG
   *  to prevent parallel edits and merge conflicts. */
  serialization_constraints?: SerializationConstraint;
  /** Granular autonomy configuration. When present, used directly instead of
   *  deriving from trust_level. See AUTONOMY_PRESETS for defaults per level. */
  autonomy?: AutonomyConfig;
  /** Prerequisites that must be available before task execution begins. */
  prerequisites?: PrerequisiteCheck[];
  /** Source control strategy for persisting completed work. */
  source_control?: SourceControlConfig;
  /** Telemetry sharing settings (opt-in, configured during swarm init). */
  telemetry_sharing?: TelemetrySharingConfig;
  /**
   * Isolation configuration for concurrent workers.
   *
   * Each worker gets its own sandbox created by `setup`, validated by `verify`,
   * and destroyed by `teardown`. Commands are shell strings with ${TASK_ID}
   * interpolation for unique naming.
   *
   * When omitted and max_workers > 1, the orchestrator asks a worker to infer
   * the isolation config from the project's overview and conventions, then
   * caches it in Substrate as an IsolationTemplate for future runs.
   *
   * Examples:
   *   iOS: { setup: "xcrun simctl clone 'iPhone 16' 'worker-${TASK_ID}'", ... }
   *   Web: { setup: "createdb test_${TASK_ID} && PORT=0 npm run dev &", ... }
   *   Docker: { setup: "docker compose -p worker-${TASK_ID} up -d", ... }
   */
  isolation?: IsolationConfig;
  /** Maximum tool-call turns per worker. Default: 50. Set higher for MCP-heavy tasks. */
  maxTurns?: number;
  /**
   * When true, goals whose dependencies failed (status "blocked") are treated
   * as skippable rather than permanently blocked. The dependent goal is marked
   * skipped and execution continues with remaining independent goals.
   * Default: false (dependent goals are blocked when their dependency fails).
   */
  skip_blocked_goals?: boolean;
  /**
   * How much swarm splits work: how many tasks the planner may make of one
   * goal, and when a task may be split into sub-tasks. Default: no cap,
   * sub_decompose "auto" (swarm's behaviour before this setting existed).
   * A goal's `split` (from its swarm_split label) overrides it.
   */
  decomposition?: DecompositionConfig;
  /**
   * Route agents' Bash commands through fnl (https://github.com/mnmal-ai/fnl),
   * which hands back a short digest of build, test and lint output instead of
   * the whole log. Off unless `enabled` is true. See FnlConfig.
   */
  fnl?: FnlConfig;
  /**
   * How swarm context reaches agents. `sections` stores the swarm's markdown
   * and the project's documents as sections and fills the context budget
   * section by section. Off unless enabled. See ContextConfig.
   */
  context?: ContextConfig;
  created: string;
}

/** `context` in a project's config.json. */
export interface ContextConfig {
  sections?: {
    /** Store documents as sections and load context by section. Default false. */
    enabled?: boolean;
    /** Repository folders whose markdown is stored as sections. Default ["docs/"]. */
    paths?: string[];
    /** Changed files whose synopses are written at once, 1 to 8. Default 4. */
    concurrency?: number;
  };
  /**
   * Index the stored documents in the worker's context and have agents read
   * them by section (stage 2 of the context-sections spec). Needs `sections`.
   */
  pull?: {
    /** Append the index and guard reads of indexed documents. Default false. */
    enabled?: boolean;
    /** A read spanning several sections and more than this many tokens is refused, 500 to 100000. Default 4000. */
    maxReadTokens?: number;
  };
  /**
   * Deliver the project's rules like the document index
   * (docs/superpowers/specs/2026-10-03-agent-rules-design.md): over
   * `maxTokens`, `must` and pinned rules in full, the most relevant `should`
   * rules in full while they fit, the rest one line each read by line range.
   */
  rules?: {
    /** Default false. */
    enabled?: boolean;
    /** Rules up to this many tokens are delivered in full, as before. 200 to 100000. Default 2000. */
    maxTokens?: number;
    /** `should` rules delivered in full for matching the task, 0 to 20. Default 3. */
    relevant?: number;
    /** Rule files besides core/rules.md and the project's constraints.md, relative to the swarm folder. */
    paths?: string[];
  };
  /**
   * Rank sections by similarity to the task with a local embedding model, and
   * add the best-ranked ones the route didn't load (stage 3 of the
   * context-sections spec). Needs `sections`. The project's sidecar embeds
   * sections as they are stored; restart it after turning this on.
   */
  ranking?: {
    /** Rank sections. Default false. */
    enabled?: boolean;
    /** The Ollama embedding model. Default "bge-m3". */
    model?: string;
    /** Its vector size; needed for a model swarm doesn't know. bge-m3 is 1024. */
    dimension?: number;
    /** Where Ollama listens. Default "http://127.0.0.1:11434". */
    ollamaUrl?: string;
    /** The most ranked sections added per task, 1 to 40; the rest stay index lines. Default 5. */
    maxSections?: number;
    /** How long one embed may take, 1000 to 120000 ms. A failed embed leaves its row for the next backfill pass. Default 15000. */
    timeoutMs?: number;
  };
}

/** `fnl` in a project's config.json. */
export interface FnlConfig {
  /** Turn the integration on. Default false. */
  enabled?: boolean;
  /** The fnl to run. Default: the first `fnl` on PATH. */
  bin?: string;
  /**
   * Commands fnl should wrap in addition to the ones its adapters recognise,
   * as fnl wrap patterns, e.g. ["make build", "./gradlew *"].
   */
  wrap?: string[];
}

/**
 * When a task may be split into sub-tasks (one level deep; sub-tasks are
 * never split again).
 *
 * - "auto": complex tasks are split before they run, and moderate tasks get a
 *   standby sub-plan that is used if they escalate. A task that escalates or
 *   times out is split, when autonomy.escalation.decompose_on_failure is on.
 * - "on_failure": nothing is split before it runs. A task that escalates or
 *   times out is split, when autonomy.escalation.decompose_on_failure is on.
 * - "never": no task is split. Failures fail or escalate as usual.
 */
export type SubDecomposeMode = "never" | "on_failure" | "auto";

/** `decomposition` in a project's config.json. */
export interface DecompositionConfig {
  /**
   * Most tasks the planner may make of one goal (an integer, at least 1).
   * The planner is asked for at most this many; if it returns more, every
   * task after the (N-1)th is folded into task N. Unset: no cap.
   */
  max_tasks?: number;
  /** When a task may be split into sub-tasks. Default "auto". */
  sub_decompose?: SubDecomposeMode;
}

/**
 * Isolation configuration for concurrent worker environments.
 *
 * All fields are shell command strings. ${TASK_ID} is interpolated at dispatch time
 * with the worker's unique task identifier. The orchestrator doesn't know what
 * platform these commands target — the project config defines them.
 */
export interface IsolationConfig {
  /** Shell command to create the isolated environment. Runs before the worker starts. */
  setup: string;
  /** Shell command to verify the environment is ready. Must exit 0 when ready. */
  verify: string;
  /** Shell command to destroy the environment. Runs after the worker finishes (success or failure). */
  teardown: string;
  /** Environment variables injected into the worker process. ${TASK_ID} interpolated. */
  env?: Record<string, string>;
}

/**
 * @deprecated Use `AUTONOMY_PRESETS` from `src/autonomy/presets.ts` instead.
 * This constant is kept for backward compatibility with code that hasn't
 * migrated to the autonomy matrix. Values here match the presets.
 */
export const DEFAULT_CONCURRENCY: Record<TrustLevel, ConcurrencyConfig> = {
  low: { max_workers: 1, max_tokens_per_session: 20_000_000, max_tokens_per_goal: 12_000_000, max_tokens_per_task: 3_000_000 },
  medium: { max_workers: 3, max_tokens_per_session: 60_000_000, max_tokens_per_goal: 20_000_000, max_tokens_per_task: 6_000_000 },
  high: { max_workers: 5, max_tokens_per_session: 120_000_000, max_tokens_per_goal: 40_000_000, max_tokens_per_task: 12_000_000 },
};

// ---------------------------------------------------------------------------
// Autonomy configuration types
// ---------------------------------------------------------------------------

export type ConflictAnticipation = "none" | "static" | "learned";

export interface AutonomyExecution {
  parallel_workers: boolean;
  max_workers: number;
  allow_shell_commands: boolean;
  allow_dependency_install: boolean;
  /** Token limits; see ConcurrencyConfig for what they count. */
  max_tokens_per_task: number;
  max_tokens_per_goal: number;
  max_tokens_per_session: number;
  task_timeout_seconds: number;
}

export interface AutonomyReview {
  require_review: boolean;
  separate_reviewer_context: boolean;
  auto_retry_on_rejection: boolean;
  max_retries: number;
  arbiter_can_resolve: boolean;
}

export interface AutonomyMerge {
  auto_merge_worktrees: boolean;
  auto_resolve_conflicts: boolean;
  push_to_remote: boolean;
  open_pull_requests: boolean;
  conflict_anticipation: ConflictAnticipation;
}

export interface AutonomyEscalation {
  decompose_on_failure: boolean;
  max_remediation_iterations: number;
  escalate_after_retries: number;
}

export interface AutonomyContext {
  skill_tiers: SkillTier[];
  allow_runtime_skill_fetch: boolean;
}

export interface AutonomyConfig {
  execution: AutonomyExecution;
  review: AutonomyReview;
  merge: AutonomyMerge;
  escalation: AutonomyEscalation;
  context: AutonomyContext;
}

// ---------------------------------------------------------------------------
// Task source types
// ---------------------------------------------------------------------------

export interface TaskSource {
  type: "local" | "github";
  /** URL to the source (e.g., GitHub issue URL). */
  url?: string;
  /** External ID (e.g., issue number). */
  externalId?: string;
}

// ---------------------------------------------------------------------------
// Goal and task types
// ---------------------------------------------------------------------------

export type GoalStatus = "pending" | "in_progress" | "completed" | "completed_with_notes" | "completed_with_deferrals" | "blocked" | "escalated";
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "interrupted" | "token_exceeded" | "skipped_tokens" | "completed_with_notes" | "completed_with_deferrals";

/**
 * Task statuses renamed when budgets moved from dollars to tokens. Task state
 * saved before the rename (tasks.json, issue metadata) still carries the old
 * names; backends read it through `currentTaskStatus`.
 */
export const LEGACY_TASK_STATUSES: ReadonlyMap<string, TaskStatus> = new Map<string, TaskStatus>([
  ["cost_exceeded", "token_exceeded"],
  ["skipped_cost", "skipped_tokens"],
]);

/** A persisted task status under its current name. */
export function currentTaskStatus(status: string): TaskStatus {
  return LEGACY_TASK_STATUSES.get(status) ?? (status as TaskStatus);
}

/** TaskStatus values that represent successful task completion (verdicts that unblock dependsOn tasks). */
export const SUCCESS_TASK_STATUSES = new Set<TaskStatus>(["completed", "completed_with_notes", "completed_with_deferrals"]);

/**
 * GoalStatus values that represent a terminal-done state — a goal in any of
 * these statuses is treated as completed by the orchestrator (dependency
 * resolver, pending-goals filter, preflight display). Mirrors
 * SUCCESS_TASK_STATUSES at the goal level: a literal `status === "completed"`
 * check would miss "completed_with_notes" / "completed_with_deferrals" and let
 * those goals leak back into the runnable set.
 */
export const SUCCESS_GOAL_STATUSES = new Set<GoalStatus>(["completed", "completed_with_notes", "completed_with_deferrals"]);

export interface Goal {
  id: string;
  description: string;
  priority: number;
  status: GoalStatus;
  constraints: string[];
  acceptance_criteria: string[];
  /** The source ticket's full text, when the goal came from one. Given to the
   *  planner alongside the acceptance criteria. */
  context?: string;
  /** Link to the source ticket, when the goal came from one. Named in the
   *  goal's pull request so the PR links back to its ticket. */
  url?: string;
  /** A short name for the goal's badges on the live dashboard, as written in
   *  goals.json: one line of at most 32 characters. Swarm names other goals
   *  itself (the ticket's id from its URL, or a model's pick) without storing
   *  the name here; see goal-label.ts. */
  label?: string;
  /** Design files to reference during task decomposition and execution.
   *  Paths relative to the swarm root (e.g., "designs/list-view.png"). */
  designs?: string[];
  /** Goal IDs that must complete before this goal starts. */
  dependsOn?: string[];
  /**
   * Per-goal override of the project's decomposition policy, from the source
   * ticket's `swarm_split: true` / `swarm_split: false` label (or set directly
   * in goals.json). false: the planner makes one task and nothing is split.
   * true: no task cap and sub_decompose "auto". Unset: the project's policy.
   */
  split?: boolean;
  /** True when the source ticket carried both swarm_split labels; `split` is
   *  then false, and swarm run warns. */
  splitConflict?: boolean;
  /** The source ticket's labels, when the goal came from one. Read by
   *  `source_control.merge_prs.skip_labels`. */
  labels?: string[];
}

export interface GoalsManifest {
  project: string;
  created: string;
  goals: Goal[];
}

export interface Task {
  id: string;
  goal_id: string;
  title?: string;
  description: string;
  intent: string;
  status: TaskStatus;
  order: number;
  result?: TaskResult;
  complexity?: ComplexityEstimate;
  subTaskIds?: string[];
  parentTaskId?: string;
  /** Task IDs that must complete before this task can start. Used by the orchestrator DAG. */
  dependsOn?: string[];
  /** Origin of the task (local creation vs. GitHub issue, etc.) */
  source?: TaskSource;
  /** File paths this task expects to modify. Used by the orchestrator to detect
   *  serialization constraints — tasks touching the same conflict-prone file
   *  are serialized rather than run in parallel. */
  serializedFiles?: string[];
  /** File paths this task expects to create. Tasks that modify these files
   *  will be ordered after this task via the create -> modify DAG constraint. */
  createsFiles?: string[];
  /** When false, task runs on main working directory instead of an isolated worktree.
   *  Default: true (isolated worktree). Used for integration and validation tasks. */
  isolated?: boolean;
}

export interface FunctionalCheck {
  description: string;
  command: string;
  timeout_seconds?: number;
}

export interface TaskResult {
  output: string;
  latency_ms: number;
  oversight_verdict?: string;
  retry_count: number;
  /** The task's tokens (fresh input, cache reads, cache writes, output), so
   *  the dashboard can recover them from the task record. Absent on records
   *  written before this field existed, and on a task that failed before its
   *  worker reported any. */
  tokens?: TokenBreakdown;
}

// ---------------------------------------------------------------------------
// Dispatch directive types
// ---------------------------------------------------------------------------

export interface DispatchDirective {
  task_id: string;
  goal_id: string;
  intent: string;
  description: string;
  directive: {
    trust_level: TrustLevel;
    context_depth: ContextDepth;
    skills_allowed: SkillTier[];
    review_required: boolean;
    acceptance_criteria: string[];
    constraints: string[];
    escalation_triggers: string[];
    /** Isolation environment for this worker. Created before work, destroyed after. */
    isolation?: {
      setup: string;
      verify: string;
      teardown: string;
      env?: Record<string, string>;
    };
  };
}

// ---------------------------------------------------------------------------
// Task backend interface
// ---------------------------------------------------------------------------

export interface TaskUpdate {
  status?: TaskStatus;
  result?: TaskResult;
  description?: string;
}

export interface TaskBackend {
  getGoals(): Promise<Goal[]>;
  createGoal(goal: Goal): Promise<string>;
  getTasks(goalId: string): Promise<Task[]>;
  getAllTasks(): Promise<Task[]>;
  getTaskById(taskId: string): Promise<Task | null>;
  createTask(task: Task): Promise<string>;
  updateTask(taskId: string, update: TaskUpdate): Promise<void>;
  addComment(taskId: string, comment: string): Promise<void>;
  escalate(taskId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// External task source interface
// ---------------------------------------------------------------------------

/**
 * Represents a raw item fetched from an external system (GitHub issue, Jira
 * ticket, Linear issue, etc.) before classification.
 */
export interface ExternalItem {
  /** External system ID (e.g., issue number). */
  externalId: string;
  /** Title / summary of the item. */
  title: string;
  /** Full body / description text. */
  body: string;
  /** Open / closed state in the external system. */
  state: "open" | "closed";
  /** Labels attached to the item. */
  labels: string[];
  /** URL to the item in the external system. */
  url: string;
}

/** Classification result for an external item. */
export type ExternalItemClassification = "goal" | "bug" | "skip";

/**
 * Abstraction for syncing goals/tasks with an external system.
 *
 * Separates the sync/classify/reconcile protocol from CRUD persistence
 * (which TaskBackend handles). Implementing this interface for a new
 * external system (Jira, Linear, etc.) is all that's needed to add it
 * as a task source.
 */
export interface ExternalTaskSource {
  /** Name of the external system (e.g., "github", "jira", "linear"). */
  name: string;

  /** Fetch all open items from the external system. */
  fetchItems(): Promise<ExternalItem[]>;

  /**
   * Parse an external item that has been classified as a goal into
   * the swarm Goal format. Extracts acceptance criteria, constraints,
   * designs, and dependencies from the item's body.
   */
  parseGoal(item: ExternalItem): Goal;

  /** Create a goal in the external system. Returns the external ID. */
  pushGoal(goal: Goal): Promise<string>;

  /** Create a task issue under a parent goal. Returns the external ID. */
  pushTask(task: Task, parentGoalExternalId: string): Promise<string>;

  /** Update the status of an item in the external system. */
  updateStatus(externalId: string, status: ExternalItemStatus): Promise<void>;

  /** Post a comment on an item in the external system. */
  postComment(externalId: string, comment: string): Promise<void>;

  /**
   * Put an item swarm started back where swarm took it from, as if swarm had
   * never picked it up. Used when a run stops for a reason that is not the
   * item's (an expired login), so a re-run picks it up again. Sources whose
   * items stay open while swarm works them need not implement it.
   */
  returnToQueue?(externalId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scanner types
// ---------------------------------------------------------------------------

export interface ScanResult {
  project_name: string;
  languages: { name: string; percentage: number }[];
  package_managers: string[];
  frameworks: string[];
  project_structure: { path: string; type: "directory" | "file"; description?: string }[];
  has_tests: boolean;
  test_frameworks: string[];
  has_ci: boolean;
  ci_platforms: string[];
  existing_docs: string[];
  entry_points: string[];
}

// ---------------------------------------------------------------------------
// Claim Registry types
// ---------------------------------------------------------------------------

export interface FileClaim {
  taskId: string;
  creates: string[];
  modifies: string[];
}

export interface ClaimConflict {
  file: string;
  claimants: string[];
  resolution: "serialize";
}

export interface ClaimValidationResult {
  valid: boolean;
  missingFiles: string[];
  duplicateCreates: string[];
  conflicts: ClaimConflict[];
}

// ---------------------------------------------------------------------------
// Worktree types
// ---------------------------------------------------------------------------

export type WorktreeStatus = "creating" | "active" | "merging" | "merged" | "conflict" | "failed" | "destroyed";
export type WorktreeCleanupStrategy = "auto-merge" | "leave-for-review" | "discard";

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  taskId: string;
  status: WorktreeStatus;
  filesChanged: string[];
  createdAt: number;
  lastCheckedAt: number;
}

export interface WorktreeConfig {
  baseDir?: string;
  cleanupStrategy?: WorktreeCleanupStrategy;
  branchPrefix?: string;
  /** Path to conflict_history.json for automatic merge conflict learning. */
  conflictHistoryPath?: string;
  /** Author and committer for worktree task commits and merge commits. */
  gitIdentity?: GitIdentity;
  /** "conventional" gives merge commits a Conventional Commit subject. */
  commitStyle?: CommitStyle;
}

export interface PruneResult {
  /** Number of stale worktree entries cleaned by git worktree prune. */
  prunedWorktrees: number;
  /** Branch names that were deleted because they had no active worktree. */
  deletedBranches: string[];
}

// ---------------------------------------------------------------------------
// Parallel dispatch types
// ---------------------------------------------------------------------------

export interface ParallelDispatchOptions {
  maxWorkers: number;
  maxTokensPerTask: number;
  maxTokensPerGoal: number;
  maxTokensPerSession: number;
  taskTimeoutSeconds: number;
}

export interface ParallelDispatchResult {
  completedTasks: string[];
  failedTasks: string[];
  /** Tokens the dispatched tasks used: all input plus output. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Skill definition types
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  name: string;
  description: string;
  tier: SkillTier;
  path: string;
  estimatedTokens: number;
}

export interface SkillLockEntry {
  url: string;
  sha256: string;
  fetchedAt: string;
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Goal summary types (SDK-23: per-goal context reset)
// ---------------------------------------------------------------------------

export interface GoalSummary {
  goalId: string;
  description: string;
  status: GoalStatus;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  /** Tokens the goal used: all input (cache included) plus output. */
  tokens: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

export interface Checkpoint {
  session_id: string;
  swarm_version: string;
  last_updated: string;
  project: string;
  trust_level: TrustLevel;
  current_goal: string | null;
  current_task: string | null;
  completed_tasks: string[];
  pending_tasks: string[];
  skipped_tasks?: string[];
  blocked: boolean;
  /** The session's tokens when the checkpoint was saved. Absent in
   *  checkpoints written before budgets moved to tokens. */
  cumulative_tokens?: number;
  elapsed_ms: number;
  /** Every finished goal whose work swarm publishes (stack_prs or merge_prs),
   *  and how far publishing got. A later run publishes what an earlier one
   *  could not, and repeats nothing already done. Absent in checkpoints
   *  written before this was recorded. */
  goal_publications?: GoalPublication[];
}

/**
 * A finished goal and how far swarm got publishing its work: pushing its
 * branch, opening its pull request and, under source_control.merge_prs,
 * merging it. Carries everything a later run needs to finish the job without
 * the goal being in that run's goal list.
 */
export interface GoalPublication {
  goal_id: string;
  description: string;
  /** Link to the source item the goal came from. */
  url?: string;
  /** "stack": source_control.stack_prs. "merge": source_control.merge_prs. */
  mode: "stack" | "merge";
  /** The goal's branch, holding its commits. */
  branch: string;
  /** stack: the branch the goal was built on, which its pull request targets. */
  base?: string;
  /** merge: the final review verdict of each of the goal's tasks. */
  verdicts?: string[];
  /** merge: the source item's labels, for merge_prs.skip_labels. */
  labels?: string[];
  /** What reviewers left for a person, listed in the pull request. */
  left_for_person?: LeftForPersonGroup[];
  /** The branch is on the remote. */
  pushed: boolean;
  /** The goal's pull request. */
  pr_url?: string;
  /** merge: the pull request was merged. */
  merged: boolean;
  /** merge: why swarm left the pull request open. Set once swarm decided, so
   *  a goal with a pull request and a reason is finished. */
  left_open_reason?: string;
  /** merge: what kind of reason `left_open_reason` is. Absent in records
   *  written before kinds existed, which stay finished. */
  left_open_kind?: LeftOpenKind;
  /** merge: how many attempts left the pull request open. Runs stop retrying
   *  on their own at MERGE_PRS_MAX_ATTEMPTS; absent counts as one. */
  merge_attempts?: number;
}

// ---------------------------------------------------------------------------
// Sub-decomposition result type
// ---------------------------------------------------------------------------

export interface SubDecompositionResult {
  subTasks: Task[];
  reasoning: string;
  /** Tokens the decomposition call spent (`input` includes the cache parts),
   *  so the session counts them toward its budgets. Absent when no call
   *  was made. */
  tokensUsed?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

// ---------------------------------------------------------------------------
// Run-summary section types (honest run report — plan Phase 6.5)
// ---------------------------------------------------------------------------

/**
 * Per-goal record of the ship-readiness gate for the run report.
 *
 * `status` distinguishes a real gate outcome from a non-firing gate:
 *  - "passed" / "failed": the gate fired on this goal and returned a verdict.
 *  - "skipped": the gate did not fire on this goal — the ship-readiness
 *    contract was absent, the gate's `goalIds` did not include this goal, or
 *    the goal did not complete. A skip is not a failure; it means there was
 *    nothing to evaluate.
 */
export interface ShipReadinessSummary {
  goalId: string;
  /** Whether the gate was applied (fired) against this goal. */
  applied: boolean;
  status: "passed" | "failed" | "skipped";
  /** Human-readable explanation of the outcome (gate reason or skip cause). */
  detail?: string;
}

/**
 * One declined suggestion offer, copied verbatim from `.suggestions-log.json`
 * into the run report's suggestions-deferred section.
 */
export interface SuggestionDeferredSummary {
  /** Catalog entry the offer was drawn from. */
  catalogEntryId: string;
  /** Axis the suggestion targeted (the catalog's grouping dimension). */
  axis: string;
  /** Why the offer was declined, when recorded. */
  reason?: string;
  /** ISO timestamp the offer was made. */
  offeredAt: string;
}

/**
 * Post-run human-PR section of the run report. Starts empty at write time and
 * is back-filled later by learn-from-pr (goal-6c) once human PRs land and are
 * categorized — `backfilled` flips true and `categorizations` is populated.
 * Consumers derive the count from `categorizations.length` at render time, so
 * a stale count field cannot drift from the array.
 */
export interface PostRunHumanPrSummary {
  /** True once learn-from-pr has filled this section. */
  backfilled: boolean;
  categorizations: Array<{ prNumber: number; category: string; confidence: number }>;
}
