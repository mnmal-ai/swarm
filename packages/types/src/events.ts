/**
 * Event bus types — event payloads, event map, and the ISwarmEventBus interface.
 */

import type { WorkerBackendType, ProgressEvent, ModelReport, TokenBreakdown, FnlCoverage, DocumentReads } from "./config.js";
import type { ComplexityBand, ComplexitySignal, EscalationReason, TrustLevel, DispatchDirective, TaskSource, SourceControlConfig, PrerequisiteCheck, LeftOpenKind } from "./orchestration.js";
import type { LeftForPersonGroup } from "./left-for-person.js";

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export interface ToolStartEvent {
  turn: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Stable per-call identifier from the worker backend (Anthropic SDK's
   * `tool_use_id`, Claude Code SDK's `tool_use_id` from TPN content blocks).
   * Pair with the matching `tool:end` event by this id rather than by
   * order, which is brittle with concurrent same-named tools.
   * Optional for back-compat with pre-postmortem callers; populated by
   * both worker backends going forward.
   */
  toolUseId?: string;
  /**
   * Task this tool call belongs to, lifted from the session→task mapping
   * the orchestrator maintains. Lets postmortem reconstruction attribute
   * tool calls to tasks without walking session metadata.
   */
  taskId?: string;
  /**
   * Session this tool call belongs to. Useful for grouping when several
   * tasks share a single backend session (oversight, arbiter).
   */
  sessionId?: string;
  timestamp: number;
}

export interface ToolEndEvent {
  turn: number;
  toolName: string;
  durationMs: number;
  isError: boolean;
  /** Pair with the originating `tool:start.toolUseId`. */
  toolUseId?: string;
  /** Mirrors `ToolStartEvent.taskId` — kept for self-contained consumers. */
  taskId?: string;
  /** Mirrors `ToolStartEvent.sessionId`. */
  sessionId?: string;
  /**
   * Tool output payload — capped at 16KB on success, uncapped on
   * failure (so the postmortem captures the full error trail without
   * silently truncating the diagnostic signal). Consumers that ship
   * telemetry upstream should respect any redaction policy before
   * forwarding this field; the local postmortem writer always gets the
   * full value.
   */
  toolOutput?: string;
  /** True when `toolOutput` was capped from a larger payload. */
  toolOutputTruncated?: boolean;
  /** Truncated error head — back-compat with pre-toolOutput consumers. */
  errorPreview?: string;
  timestamp: number;
}

export interface TurnStartEvent {
  turn: number;
  messageCount: number;
  timestamp: number;
}

export interface TurnEndEvent {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  timestamp: number;
}

/**
 * Distinguishes a task that is actively editing the repo from one whose
 * worker is only generating a plan (speculative sub-decomposition). The
 * dashboard renders this as a chip alongside the existing intent badge so
 * the `In Progress` column count is honest about how many workers are
 * actually touching files. Default (unspecified) = "editing".
 */
export type TaskRole = "editing" | "planning_ahead";

export interface TaskStartEvent {
  taskId: string;
  goalId: string;
  title?: string;
  description: string;
  intent: string;
  parentTaskId?: string;
  source?: TaskSource;
  /** When omitted, consumers should treat the task as "editing". */
  role?: TaskRole;
  timestamp: number;
}

/**
 * Emitted when a task's role *transitions* mid-lifecycle — exclusively
 * for an actual change of role. The initial role of a task is carried by
 * `TaskStartEvent.role`, NOT by a synthetic `task:role_changed` event
 * with no real previous state. That keeps `previousRole` honestly
 * required: every emission of this event corresponds to a real
 * editing ↔ planning_ahead transition with both sides known.
 *
 * TODO(orchestrator): no emitter exists yet. Wire up in
 * `packages/cli/src/cli/run.ts` at the speculator → active-implementer
 * promotion site. When a speculative `planning_ahead` worker has its
 * sub-decomposition consumed and the resulting task is dispatched as
 * the active editor for the same `taskId`, emit `task:role_changed`
 * with `previousRole: "planning_ahead"` and `role: "editing"` so the
 * dashboard can flip the chip in place rather than tear down +
 * recreate the card. (The reverse transition — `editing` →
 * `planning_ahead` — does not exist in the current orchestrator;
 * speculators only ever get promoted or discarded.)
 *
 * Until this lands the dashboard renders fine — it shows the role
 * set at `task:start` time and doesn't update mid-lifecycle.
 */
export interface TaskRoleChangedEvent {
  taskId: string;
  role: TaskRole;
  previousRole: TaskRole;
  timestamp: number;
}

export interface TaskVerdictEvent {
  taskId: string;
  verdict: string;
  latencyMs: number;
  retryCount: number;
  arbiterInvolved?: boolean;
  /**
   * Short, human-readable reason a task failed. Renders on the Failed
   * column's expanded card. Should be at most ~2 lines; full diagnostics
   * remain in orchestration:event `detail`.
   */
  failureReason?: string;
  /**
   * This task's tokens: fresh input, cache reads, cache writes and output.
   * The live dashboard shows these per task and sums them per goal.
   */
  tokens: TokenBreakdown;
  /** Items the reviewer passed the task with but left for a person. */
  deferred?: string[];
  /** Deviations the reviewer accepted, one line each. */
  notes?: string[];
  timestamp: number;
}

/** A finished goal's tasks passed review with items left for a person. */
export interface GoalLeftForPersonEvent {
  goalId: string;
  /** The items, grouped by task and de-duplicated. */
  groups: LeftForPersonGroup[];
  timestamp: number;
}

/**
 * The agent runtime's login expired. The run stops dispatching, puts the
 * goal it was working on back where it came from, saves its checkpoint and
 * exits non-zero; a plain re-run resumes where it stopped.
 */
export interface RunLoginExpiredEvent {
  /** What the operator must do (LOGIN_EXPIRED_MESSAGE). */
  message: string;
  /** The runtime's own error text, secrets redacted. */
  detail: string;
  /** The goal that was in flight and has been started, if any. */
  goalId?: string;
  timestamp: number;
}

export interface GoalStartEvent {
  goalId: string;
  description: string;
  taskCount: number;
  /** Link to the goal's source ticket (a Trello card, a GitHub issue), when it came from one. */
  url?: string;
  /** The goal's short name for the dashboard's badges: the ticket's id from
   *  its URL, a model's pick, or goals.json's label. Absent: none of these. */
  label?: string;
  timestamp: number;
}

export interface GoalDecomposedEvent {
  goalId: string;
  tasks: Array<{ id: string; title?: string; description: string; intent: string; source?: TaskSource }>;
  timestamp: number;
}

export interface GoalCompletedEvent {
  goalId: string;
  completedTasks: number;
  totalTasks: number;
  /** Tokens the goal used: all input (cache included) plus output. */
  totalTokens: number;
  timestamp: number;
}

export interface OversightStartEvent {
  sessionId: string;
  role: "reviewer" | "arbiter";
  model: string;
  timestamp: number;
}

export interface OversightVerdictEvent {
  sessionId: string;
  verdict: string;
  arbiterInvolved: boolean;
  retryCount: number;
  durationMs: number;
  timestamp: number;
}

/**
 * The session's token usage, emitted after each task. The live dashboard
 * shows `tokens` (fresh input, cache reads, cache writes, output) in its
 * header and main tile, and `cumulativeTokens` against `sessionTokenLimit`
 * in its budget bar.
 */
export interface TokensUpdateEvent {
  /**
   * The session's tokens so far — all input (fresh, cache reads, cache
   * writes) plus output: the count `max_tokens_per_session` is checked
   * against. Context tokens are not included.
   */
  cumulativeTokens: number;
  /** The same tokens split into fresh input, cache reads, cache writes and
   *  output. Its parts sum to `cumulativeTokens`. */
  tokens: TokenBreakdown;
  /** `max_tokens_per_session` as the run resolved it. */
  sessionTokenLimit: number;
  /** cumulativeTokens as a percentage of sessionTokenLimit. */
  percentUsed: number;
  timestamp: number;
}

export interface ClaimRegisteredEvent {
  goalId: string;
  totalClaims: number;
  totalFilesClaimed: number;
  overlapCount: number;
  timestamp: number;
}

export interface ClaimValidatedEvent {
  goalId: string;
  valid: boolean;
  missingFiles: string[];
  duplicateCreates: string[];
  conflictsDetected: number;
  timestamp: number;
}

export interface ClaimRevisedEvent {
  goalId: string;
  filesChangedInRevision: number;
  conflictsResolved: number;
  conflictsRemaining: number;
  timestamp: number;
}

export interface SerializationAppliedEvent {
  goalId: string;
  tasksSerialized: number;
  tasksParallel: number;
  serializationPairs: [string, string][];
  timestamp: number;
}

export interface RetryEvent {
  sessionId: string;
  attempt: number;
  maxRetries: number;
  reasons: string[];
  timestamp: number;
}

export interface SessionStartEvent {
  sessionId: string;
  swarmPath: string;
  provider: string;
  model: string;
  role: "worker" | "reviewer" | "arbiter";
  swarmVersion: string;
  project?: string;
  trustLevel?: string;
  /** The session token limit, when the caller has one. */
  tokenLimit?: number;
  timestamp: number;
}

export interface SessionEndEvent {
  sessionId: string;
  role: "worker" | "reviewer" | "arbiter";
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  latencyMs: number;
  maxTurnsReached: boolean;
  tokenLimitExceeded?: boolean;
  backendType?: WorkerBackendType;
  /** How the session's Bash commands fared with fnl, when it counted them. */
  fnl?: FnlCoverage;
  /** How the session read its indexed documents (context.pull), when it counted them. */
  docs?: DocumentReads;
  timestamp: number;
}

export interface IntentClassifiedEvent {
  sessionId: string;
  intent: string;
  // `"semantic"` = embedding-recall match (engine-recall); see ClassificationResult.
  confidence: "exact" | "keyword" | "semantic" | "fallback";
  matchedKeywords: string[];
  routeDescription: string;
  timestamp: number;
}

/**
 * Section sync before a session (context.sections): how many files changed and
 * need synopses, of how many. Counts only, never paths or text, because
 * events can leave the machine and projects can be confidential.
 */
export interface ContextSyncStartEvent {
  changedFiles: number;
  totalFiles: number;
  /** The changed files' text, in bytes: what the synopses have to read. */
  changedBytes: number;
  timestamp: number;
}

/**
 * One more changed file stored, of `total`, and the text done so far. When
 * enough is measured (two files or half a minute), the throughput so far over
 * wall-clock time and the time left at that rate. Counts only.
 */
export interface ContextSyncProgressEvent {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  /** Time left at the throughput measured so far; absent until there's enough to measure. */
  etaMs?: number;
  /** Measured throughput, bytes per minute of wall-clock time; absent until there's enough to measure. */
  bytesPerMinute?: number;
  timestamp: number;
}

/** Section sync finished: files and text stored, failures (those load whole), time taken. Counts only. */
export interface ContextSyncDoneEvent {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  failures: number;
  ms: number;
  /** Sections whose synopsis fell back to their first sentence (a model call failed or gave nothing). */
  fallbacks: number;
  bytesPerMinute?: number;
  timestamp: number;
}

/** A goal's planning (decomposition into tasks) has begun; `goal:start` follows once it has tasks. */
export interface GoalPlanningEvent {
  goalId: string;
  /** The goal's short name for badges, when it has one (see GoalStartEvent.label). */
  label?: string;
  timestamp: number;
}

export interface ContextLoadedEvent {
  sessionId: string;
  files: Array<{ path: string; tier: string; estimatedTokens: number }>;
  totalTokens: number;
  budgetMax: number;
  budgetUsedPercent: number;
  truncated: string[];
  /** Optional-tier files the budget left out, with what each would have cost.
   *  Unlike `truncated`, never names an unseeded remote URL. */
  omitted?: Array<{ path: string; tier: string; estimatedTokens: number }>;
  timestamp: number;
}

/** Which models served one backend session, tagged with the role that ran it. */
export interface BackendModelReportEvent {
  role: "worker" | "reviewer" | "arbiter";
  report: ModelReport;
  timestamp: number;
}

/** One session's fnl coverage, tagged with the role that ran it (every role, every session). */
export interface BackendFnlCoverageEvent {
  role: "worker" | "reviewer" | "arbiter";
  coverage: FnlCoverage;
  timestamp: number;
}

export interface AgentRoleEvent {
  sessionId: string;
  role: "worker" | "reviewer" | "arbiter";
  model: string;
  provider: string;
  parentSessionId?: string;
  timestamp: number;
}

export interface BackendFallbackEvent {
  from: WorkerBackendType;
  to: WorkerBackendType;
  reason: string;
  timestamp: number;
}

export interface BackendRateLimitedEvent {
  backend: WorkerBackendType;
  sessionId: string;
  waitingSince: number;
  estimatedWaitMs: number;
  resetAt: string;
  timestamp: number;
}

export interface BackendRateLimitClearedEvent {
  backend: WorkerBackendType;
  sessionId: string;
  waitedMs: number;
  timestamp: number;
}

export interface ComplexityEstimatedEvent {
  taskId: string;
  score: number;
  band: ComplexityBand;
  signals: ComplexitySignal[];
  reasoning: string;
  timestamp: number;
}

export interface TaskEscalatedEvent {
  taskId: string;
  reason: EscalationReason;
  detail: string;
  /** Tokens the task had used when it escalated. */
  tokens?: number;
  turnCount?: number;
  timestamp: number;
}

export interface TaskAbortedEvent {
  taskId: string;
  reason: EscalationReason;
  subTaskCount: number;
  /** Tokens the task spent on the way to being split — its own run, if it
   *  ran, and the decomposition call — which no task:verdict reports. The
   *  dashboard adds them to the task, so goal totals include them. */
  tokens?: TokenBreakdown;
  timestamp: number;
}

export interface ActiveToolSnapshot {
  /** Stable per-call id matching the originating `tool:start.toolUseId`. */
  toolUseId: string;
  /** Tool name (Bash, Read, Edit, etc.). */
  name: string;
  /** ms-since-epoch when the tool call started. */
  startedAt: number;
  /** Wall-clock age of the in-flight call at the time of the snapshot. */
  ageMs: number;
  /** Truncated input preview (~120 chars) for at-a-glance triage. */
  inputPreview: string;
}

export interface TaskToolWedgedEvent {
  taskId: string;
  /** Number of tool calls in flight at the moment the wedge fired. */
  activeToolCount: number;
  /** Wall-clock ms since the tool-activity session started. Always > the
   *  configured tool_call_timeout_ms (with poll-interval slack). */
  elapsedMs: number;
  /** Configured threshold that was exceeded — useful for telemetry to
   *  distinguish a genuine wedge from a too-tight default. */
  thresholdMs: number;
  /**
   * Snapshot of which tools were in flight at the moment the wedge
   * fired. Populated by the orchestrator from the in-flight Map it
   * maintains via `tool:start`/`tool:end` events. Sorted oldest-first
   * so the longest-stuck calls are at the head of the list — usually
   * the offender. Optional for back-compat with pre-postmortem
   * consumers; populated by every emission going forward.
   */
  activeTools?: ActiveToolSnapshot[];
  timestamp: number;
}

/**
 * Emitted after a task fails (oversight rejection, tool wedge, arbiter
 * escalation, token limit, etc.) and the orchestrator has persisted a
 * `FailurePostmortem` Substrate entity. Consumers (the diagnosis routine
 * in Stage 2, the dashboard) can subscribe to this to surface
 * "post-mortem available" affordances without re-walking the failure
 * path; the `postmortemId` dereferences to the Substrate entity via the
 * standard `getFailurePostmortem` query.
 *
 * `postmortemId` may be an empty string when the recorder is running
 * without a Substrate client (test runs, intentionally degraded modes) —
 * the ring buffers still emit the event so consumers know a failure
 * happened, just without a queryable entity.
 */
export interface TaskPostmortemWrittenEvent {
  taskId: string;
  /** Substrate entity id of the `FailurePostmortem` row. Empty when no
   *  Substrate client was attached at recorder construction time. */
  postmortemId: string;
  /** Echo of the failure category (e.g., "tool_wedge", "oversight_rejected"). */
  failureCategory: string;
  /** Counts of what the postmortem captured. */
  toolCallsCaptured: number;
  transcriptTurnsCaptured: number;
  timestamp: number;
}

/**
 * Emitted when the presence-triggered ship-readiness gate refuses to mark a
 * goal complete because verification failed. `stage` separates a failed deploy
 * command (`"deploy"`, carries `deployExitCode`) from a failed smoke poll
 * (`"smoke"`, carries `failedEndpoints`) so the reviewer can act on each
 * differently and a real bug is never masked as an env failure. `contractPath`
 * points at the `.swarm/oversight/ship-readiness.json` whose presence armed
 * the gate.
 *
 * `timestamp` is a string here (not the `number` used by the ring-buffer
 * payload events) to match the orchestration-event surface this feeds —
 * `OrchestrationEvent`/`OrchestrationBusEvent` carry string timestamps, and
 * the orchestrator records `ship_readiness_failed` alongside this event.
 */
export interface TaskVerificationFailedEvent {
  goalId: string;
  contractPath: string;
  stage: "deploy" | "smoke";
  detail: string;
  failedEndpoints?: string[];
  deployExitCode?: number;
  timestamp: string;
}

export interface OrchestrationBusEvent {
  id: string;
  eventType: string;
  project: string;
  goalId?: string;
  taskId?: string;
  trustLevel: string;
  tokens?: number;
  cumulativeTokens?: number;
  detail: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Orchestration event types
// ---------------------------------------------------------------------------

export type OrchestrationEventType =
  | "goal_started"
  | "goal_completed"
  | "goal_completed_no_commits"
  | "goal_blocked"
  | "task_dispatched"
  | "task_completed"
  | "task_failed"
  | "task_skipped_dependency"
  | "escalation_triggered"
  | "session_started"
  | "session_completed"
  | "token_warning"
  | "token_limit_reached"
  | "token_limit_increased"
  | "task_token_exceeded"
  | "goal_remediation"
  | "remediation_exhausted"
  | "discovery_started"
  | "discovery_completed"
  | "task_timeout"
  | "task_timeout_decomposed"
  | "prerequisite_check"
  | "prerequisite_failed"
  | "claim_registered"
  | "claim_validated"
  | "claim_revised"
  | "serialization_applied"
  | "worktree_conflict"
  | "task_merge_conflict"
  | "task_committed"
  | "commit_failed"
  | "goal_blocked_dependency"
  | "task_blocked_prerequisite"
  | "replan_triggered"
  | "integration_task_created"
  | "acceptance_criteria_verified"
  | "decomposition_loop_detected"
  | "task_wedged"
  | "worker_heartbeat_missed"
  | "ship_readiness_failed";

export interface OrchestrationEvent {
  id: string;
  timestamp: string;
  session_id: string;
  event_type: OrchestrationEventType;
  project: string;
  goal_id?: string;
  task_id?: string;
  trust_level: TrustLevel;
  active_workers: number;
  /** Tokens this event concerns (a task's, a limit's), when it has a count. */
  tokens?: number;
  /** The session's tokens so far. */
  cumulative_tokens?: number;
  detail?: string;
  escalation_reason?: string;
  dispatch_directive?: DispatchDirective;
  file_claims?: {
    creates: string[];
    modifies: string[];
    conflicts_detected: number;
    serialized_with: string[];
  };
  worktree_outcome?: {
    files_actually_changed: string[];
    claim_accuracy: number;
    merge_result: "clean" | "conflict" | "skipped";
    conflict_files?: string[];
  };
}

// ---------------------------------------------------------------------------
// Worktree event types
// ---------------------------------------------------------------------------

export interface WorktreeCreatedEvent {
  worktreeId: string;
  taskId: string;
  path: string;
  branch: string;
  baseBranch: string;
  timestamp: number;
}

export interface WorktreeChangedEvent {
  worktreeId: string;
  taskId: string;
  path: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  timestamp: number;
}

export interface WorktreeMergedEvent {
  worktreeId: string;
  taskId: string;
  branch: string;
  targetBranch: string;
  filesChanged: string[];
  timestamp: number;
}

export interface WorktreeConflictEvent {
  worktreeId: string;
  taskId: string;
  branch: string;
  conflictFiles: string[];
  timestamp: number;
}

export interface WorktreeUncommittedChangesEvent {
  worktreeId: string;
  taskId: string;
  branch: string;
  uncommittedFiles: string[];
  timestamp: number;
}

export interface WorktreeDestroyedEvent {
  worktreeId: string;
  taskId: string;
  reason: "merged" | "discarded" | "failed" | "manual";
  timestamp: number;
}

export interface WorktreePrunedEvent {
  prunedWorktrees: number;
  deletedBranches: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Skill event types
// ---------------------------------------------------------------------------

export interface SkillFetchedEvent {
  url: string;
  cachePath: string;
  sizeBytes: number;
  estimatedTokens: number;
  latencyMs: number;
  timestamp: number;
}

export interface SkillFetchFailedEvent {
  url: string;
  error: string;
  statusCode?: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Prerequisite event types
// ---------------------------------------------------------------------------

export interface PrerequisiteCheckedEvent {
  project: string;
  passed: boolean;
  totalChecks: number;
  hardBlocked: number;
  softBlocked: number;
  details: Array<{ name: string; type: PrerequisiteCheck["type"]; available: boolean; detail: string }>;
  timestamp: number;
}

export interface HumanEscalationEvent {
  project: string;
  reason: string;
  blockedPrerequisites?: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Source control event types
// ---------------------------------------------------------------------------

export interface SourceControlBranchCreatedEvent {
  branch: string;
  strategy: SourceControlConfig["strategy"];
  timestamp: number;
}

export interface SourceControlBranchPushedEvent {
  branch: string;
  remote: string;
  timestamp: number;
}

export interface SourceControlPrCreatedEvent {
  branch: string;
  prUrl: string;
  goalId: string;
  timestamp: number;
}

/** source_control.merge_prs: the merge gate started on a goal's branch. */
export interface SourceControlMergeGateStartedEvent {
  goalId: string;
  branch: string;
  command: string;
  timestamp: number;
}

/** source_control.merge_prs: the merge gate finished. `tail` is the last lines
 *  of its output, for the run log only. */
export interface SourceControlMergeGateFinishedEvent {
  goalId: string;
  branch: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tail: string;
  timestamp: number;
}

/** source_control.merge_prs: a goal's PR was merged into the base branch. */
export interface SourceControlPrMergedEvent {
  goalId: string;
  branch: string;
  prUrl: string;
  mergeCommit: string;
  base: string;
  timestamp: number;
}

/** source_control.merge_prs: a goal's PR was left open. `prUrl` is absent when
 *  no PR could be opened. `reason` is swarm's own text, never tool output. */
export interface SourceControlMergeSkippedEvent {
  goalId: string;
  branch: string;
  prUrl?: string;
  reason: string;
  /** What kind of reason it is; decides whether a later run tries again. */
  kind?: LeftOpenKind;
  /** The underlying error, redacted, when a step failed. Run log only. */
  error?: string;
  timestamp: number;
}

/** merge_prs: this goal waits its turn to merge into the repository. Emitted
 *  when the wait starts and whenever who is ahead changes. */
export interface SourceControlMergeWaitingEvent {
  goalId: string;
  repoKey: string;
  /** Turns ahead of this one, the holder's included. */
  ahead: number;
  holderProject?: string;
  holderPrUrl?: string;
  timestamp: number;
}

/** merge_prs: this goal has the repository's merge turn. */
export interface SourceControlMergeTurnTakenEvent {
  goalId: string;
  repoKey: string;
  waitedMs: number;
  /** Set when the turn was taken over from a run that died or stopped answering. */
  tookOverFrom?: string;
  timestamp: number;
}

/** merge_prs: this goal gave the merge turn back. */
export interface SourceControlMergeTurnReleasedEvent {
  goalId: string;
  repoKey: string;
  heldMs: number;
  timestamp: number;
}

/** merge_prs: a merge goes round again — the base moved under the gate, or
 *  GitHub refused because it had. */
export interface SourceControlMergeRoundEvent {
  goalId: string;
  prUrl: string;
  /** The round about to start. */
  round: number;
  reason: "base_moved" | "refused";
  timestamp: number;
}

/** merge_prs: a conflict with the base went back to a worker. */
export interface SourceControlMergeConflictHandedBackEvent {
  goalId: string;
  branch: string;
  files: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Transcript entry type
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  sessionId: string;
  runId?: string;
  role: "worker" | "reviewer" | "arbiter";
  taskId?: string;
  goalId?: string;
  // Taxonomy-only (per-engineer reporting); enforcement deferred to a later phase.
  authorId?: string;
  timestamp: string;
  prompt: string;
  response: string;
  tokens?: { input: number; output: number };
  backend: string;
}

// ---------------------------------------------------------------------------
// Event map and event bus interface
// ---------------------------------------------------------------------------

export interface SwarmEventMap {
  "tool:start": ToolStartEvent;
  "tool:end": ToolEndEvent;
  "turn:start": TurnStartEvent;
  "turn:end": TurnEndEvent;
  "task:start": TaskStartEvent;
  "task:role_changed": TaskRoleChangedEvent;
  "task:verdict": TaskVerdictEvent;
  "goal:start": GoalStartEvent;
  "goal:decomposed": GoalDecomposedEvent;
  "goal:completed": GoalCompletedEvent;
  "goal:left_for_person": GoalLeftForPersonEvent;
  "run:login_expired": RunLoginExpiredEvent;
  "oversight:start": OversightStartEvent;
  "oversight:verdict": OversightVerdictEvent;
  "tokens:update": TokensUpdateEvent;
  "retry": RetryEvent;
  "session:start": SessionStartEvent;
  "session:end": SessionEndEvent;
  "intent:classified": IntentClassifiedEvent;
  "context:loaded": ContextLoadedEvent;
  "context:sync-start": ContextSyncStartEvent;
  "context:sync-progress": ContextSyncProgressEvent;
  "context:sync-done": ContextSyncDoneEvent;
  "goal:planning": GoalPlanningEvent;
  "agent:role": AgentRoleEvent;
  "backend:model_report": BackendModelReportEvent;
  "backend:fnl_coverage": BackendFnlCoverageEvent;
  "backend:fallback": BackendFallbackEvent;
  "backend:rate-limited": BackendRateLimitedEvent;
  "backend:rate-limit-cleared": BackendRateLimitClearedEvent;
  "backend:progress": ProgressEvent;
  "orchestration:event": OrchestrationBusEvent;
  "complexity:estimated": ComplexityEstimatedEvent;
  "task:escalated": TaskEscalatedEvent;
  "task:aborted": TaskAbortedEvent;
  "task:postmortem_written": TaskPostmortemWrittenEvent;
  "task:tool_wedged": TaskToolWedgedEvent;
  "task:verification-failed": TaskVerificationFailedEvent;
  "worktree:created": WorktreeCreatedEvent;
  "worktree:changed": WorktreeChangedEvent;
  "worktree:merged": WorktreeMergedEvent;
  "worktree:conflict": WorktreeConflictEvent;
  "worktree:uncommitted-changes": WorktreeUncommittedChangesEvent;
  "worktree:destroyed": WorktreeDestroyedEvent;
  "worktree:pruned": WorktreePrunedEvent;
  "skill:fetched": SkillFetchedEvent;
  "skill:fetch_failed": SkillFetchFailedEvent;
  "prerequisite:checked": PrerequisiteCheckedEvent;
  "human:escalation": HumanEscalationEvent;
  "source_control:branch_created": SourceControlBranchCreatedEvent;
  "source_control:branch_pushed": SourceControlBranchPushedEvent;
  "source_control:pr_created": SourceControlPrCreatedEvent;
  "source_control:merge_gate_started": SourceControlMergeGateStartedEvent;
  "source_control:merge_gate_finished": SourceControlMergeGateFinishedEvent;
  "source_control:pr_merged": SourceControlPrMergedEvent;
  "source_control:merge_skipped": SourceControlMergeSkippedEvent;
  "source_control:merge_waiting": SourceControlMergeWaitingEvent;
  "source_control:merge_turn_taken": SourceControlMergeTurnTakenEvent;
  "source_control:merge_turn_released": SourceControlMergeTurnReleasedEvent;
  "source_control:merge_round": SourceControlMergeRoundEvent;
  "source_control:merge_conflict_handed_back": SourceControlMergeConflictHandedBackEvent;
  "claim:registered": ClaimRegisteredEvent;
  "claim:validated": ClaimValidatedEvent;
  "claim:revised": ClaimRevisedEvent;
  "claim:serialization_applied": SerializationAppliedEvent;
  "transcript": TranscriptEntry;
}

/** Interface for the event bus — defined here to avoid circular dependency with src/. */
export interface ISwarmEventBus {
  emit<K extends keyof SwarmEventMap>(event: K, payload: SwarmEventMap[K]): void;
  on<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void;
  off<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void;
  once<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void;
  onAny(handler: (event: string, payload: unknown) => void): () => void;
  removeAllListeners(): void;
}
