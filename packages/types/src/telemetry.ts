/**
 * Telemetry event types.
 *
 * Mirrors the schemas defined in the swarm repo at telemetry/schema/*.schema.json.
 */

import type { ReviewVerdict, ArbiterVerdict, DocumentReads, FnlCoverage } from "./config.js";
import type {
  ShipReadinessSummary,
  SuggestionDeferredSummary,
  PostRunHumanPrSummary,
} from "./orchestration.js";

// ---------------------------------------------------------------------------
// Telemetry types (mirrors telemetry/schema/*.schema.json)
// ---------------------------------------------------------------------------

export interface SwarmEvent {
  id: string;
  timestamp: string;
  session_id: string;
  role: "worker" | "reviewer" | "arbiter";
  model: { provider: string; model_id: string; api_version?: string };
  swarm_version: { commit_sha: string; tag?: string };
  intent: string;
  swarm_files_loaded: string[];
  context_tokens_used: number;
  tokens: { input: number; output: number };
  latency_ms: number;
  input_summary?: string;
  output_summary?: string;
  // Taxonomy-only (per-engineer reporting); enforcement deferred to a later phase.
  authorId?: string;
  /** What swarm context this session loaded and what the budget left out. */
  context_detail?: ContextRecord;
  /** How the session's Bash commands fared with fnl, when it counted them. */
  fnl_coverage?: FnlCoverage;
}

/**
 * One session's swarm context: the budget it was given, each file that loaded
 * and each optional file the budget left out, with token estimates.
 */
export interface ContextRecord {
  budgetTokens: number;
  loaded: Array<{ path: string; tier: string; tokens: number }>;
  omitted: Array<{ path: string; tier: string; tokens: number }>;
  /** The document index appended to the context (context.pull): what it listed and its size. */
  index?: { documents: number; expanded: number; folded: number; dropped: number; tokens: number };
  /** How the session read its indexed documents, when its backend counted. */
  reads?: DocumentReads;
  /**
   * The project's rules when they were delivered by index (context.rules, over
   * budget): sections in full and as index lines, the block's size, and what
   * the same rules would have cost in full.
   */
  rules?: { sections: number; full: number; indexed: number; tokens: number; tokensIfFull: number };
  /** What ranking did (context.ranking): ranked, or why not, and what it added. */
  ranking?: { status: "ranked" | "unavailable" | "no-embeddings"; candidates: number; loaded: number; tokens: number; model?: string };
}

export interface OversightEvent {
  session_id: string;
  worker_event_id: string;
  reviewer_event_id?: string;
  reviewer_verdict: ReviewVerdict;
  rejection_reasons?: string[];
  retry_count: number;
  arbiter_involved: boolean;
  arbiter_event_id?: string;
  arbiter_verdict?: ArbiterVerdict;
  human_escalation: boolean;
  human_decision?: string;
  human_response_time_minutes?: number;
  total_resolution_time_ms: number;
  review_skipped_reason?: string;
}

// ---------------------------------------------------------------------------
// Benchmark types
// ---------------------------------------------------------------------------

export interface BehavioralTest {
  scenario: {
    id: string;
    submitted_by: string;
    date: string;
    category: string;
    plain_english: {
      situation: string;
      input: string;
      expected_behavior: string;
      failure_this_prevents: string;
    };
  };
  setup: {
    swarm_files: string[];
    prompt: string;
  };
  assertions: TestAssertion[];
  run_config: {
    runs: number;
    pass_threshold: string;
    timeout_ms: number;
  };
}

export interface TestAssertion {
  type: "contains" | "contains_any" | "excludes" | "structural" | "semantic";
  value?: string;
  values?: string[];
  case_sensitive?: boolean;
  check?: string;
  judge_prompt?: string;
  min_score?: number;
  required: boolean;
}

export interface AssertionResult {
  assertion: TestAssertion;
  passed: boolean;
  detail?: string;
}

export interface TestRunResult {
  testId: string;
  run: number;
  passed: boolean;
  assertions: AssertionResult[];
  output: string;
  latencyMs: number;
  /** Input plus output tokens this run spent. */
  tokens: number;
}

export interface TestSuiteResult {
  testId: string;
  category: string;
  runs: TestRunResult[];
  passCount: number;
  failCount: number;
  passRate: number;
  threshold: number;
  passed: boolean;
}

export interface BenchmarkReport {
  id: string;
  timestamp: string;
  model: { provider: string; model_id: string };
  swarm_version: { commit_sha: string; tag?: string };
  suite: string;
  results: TestSuiteResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    overallPassRate: number;
  };
  usage: {
    totalTokens: number;
    avgLatencyMs: number;
  };
}

// ---------------------------------------------------------------------------
// Run report types (grade-data output)
// ---------------------------------------------------------------------------

export interface RunReportMeta {
  generated_at: string;
  run_id?: string;
  date_range: { start: string; end: string };
  project: string;
  swarm_version?: string;
  total_events: number;
}

export interface RunReportGoal {
  id: string;
  completed_tasks: number;
  total_tasks: number;
  /** All input tokens (cache included) plus output. */
  tokens: number;
  completion_rate: number;
}

export interface RunReportTaskDetail {
  id: string;
  description: string;
  tokens?: number;
  latency_ms?: number;
  reason?: string;
}

export interface RunReport {
  meta: RunReportMeta;
  session: {
    duration_ms: number;
    total_tokens: number;
    total_tasks: number;
    total_goals: number;
  };
  goals: RunReportGoal[];
  oversight: {
    first_pass_rate: number;
    retry_count: number;
    arbiter_invocations: number;
    escalations: number;
    verdicts: Record<string, number>;
  };
  tokens: {
    avg_tokens_per_task: number;
    max_tokens_task: RunReportTaskDetail | null;
    token_limit_hits: number;
    session_budget_used_pct: number;
  };
  tasks: {
    by_status: Record<string, number>;
    by_intent: Record<string, number>;
    failed: RunReportTaskDetail[];
    slowest: RunReportTaskDetail[];
    most_tokens: RunReportTaskDetail[];
  };
  worktrees: {
    created: number;
    merged: number;
    conflicts: number;
    destroyed: number;
  };
  alerts: {
    triggered: Array<{ id: string; metric: string; value: number; threshold: string }>;
    passed: string[];
  };
  context: {
    avg_tokens_loaded: number;
    budget_overflow_count: number;
    skills_fetched: number;
    skill_fetch_failures: number;
  };
}

// ---------------------------------------------------------------------------
// Alert definition types (grade-data)
// ---------------------------------------------------------------------------

export interface AlertDef {
  id: string;
  metric: string;
  condition: string;
  window?: string;
  severity?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Learning system types (capture + synthesize)
// ---------------------------------------------------------------------------

/** Verdict values that count as "task completed" for learning purposes. */
export type CompletedVerdict = "approved" | "skipped";

/** Summary of a single task's outcome within a run. */
export interface TaskOutcomeSummary {
  taskId: string;
  goalId: string;
  intent: string;
  description: string;
  verdict: ReviewVerdict | ArbiterVerdict;
  latencyMs: number;
  retryCount: number;
  arbiterInvolved: boolean;
  humanEscalation: boolean;
  rejectionReasons: string[];
  /** The task's input tokens (cache reads and writes included) and output
   *  tokens. Optional so legacy callers and tests that omit them render a
   *  clean 0-token line rather than breaking. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Summary of a single goal's outcome within a run. */
export interface GoalOutcomeSummary {
  goalId: string;
  description: string;
  status: "completed" | "partial" | "failed";
  tasksAttempted: number;
  tasksCompleted: number;
  designsReferenced: string[];
}

/** Per-run observation file data (written to learned/runs/<runId>.md). */
export interface RunObservation {
  runId: string;
  date: string;
  swarmVersion: string;
  project: string;
  workerModel: string;
  reviewerModel: string;
  goalsAttempted: string[];
  goalsCompleted: string[];
  goalsFailed: string[];
  totalTasks: number;
  tasksApproved: number;
  tasksRejected: number;
  totalRetries: number;
  arbiterInvocations: number;
  humanEscalations: number;
  /** All input tokens (cache included) plus output across the run. */
  totalTokens: number;
  durationMs: number;
  /** All files changed during the run (created + modified). */
  filesChanged: string[];
  mergeConflicts: string[];
  taskOutcomes: TaskOutcomeSummary[];
  goalOutcomes: GoalOutcomeSummary[];
  /** Whether the run was interrupted by SIGINT. */
  paused: boolean;
  /** Ship-readiness gate outcome for the run report (honest run summary —
   *  plan Phase 6.5). `contractLoaded` records whether a ship-readiness
   *  contract was loaded at all, so the renderer can distinguish "no contract"
   *  from "contract present, no gated goals". Optional so existing
   *  buildObservation callers and tests stay green. */
  shipReadiness?: { contractLoaded: boolean; goals: ShipReadinessSummary[] };
  /** Declined suggestion offers copied from `.suggestions-log.json`. Optional;
   *  absent when no suggestions log exists. */
  suggestionsDeferred?: SuggestionDeferredSummary[];
  /** Post-run human-PR section. Starts empty and is back-filled later by
   *  learn-from-pr (goal-6c). Optional; absent until populated. */
  postRunHumanPrs?: PostRunHumanPrSummary;
}

/** Pattern types observed during runs. */
export type PatternType =
  | "convention"
  | "file_contention"
  | "tool_usage"
  | "reviewer_pattern"
  | "token_pattern";

/** A single pattern observation appended to patterns.jsonl. */
export interface PatternEntry {
  run_id: string;
  timestamp: string;
  type: PatternType;
  observation: string;
  files: string[];
  source: string;
}

/** A single failure observation appended to failures.jsonl. */
export interface FailureEntry {
  run_id: string;
  timestamp: string;
  task_id: string;
  goal_id: string;
  verdict: ReviewVerdict | ArbiterVerdict;
  reason: string;
  retry_number: number;
  eventually_resolved: boolean;
  resolution?: string;
}
