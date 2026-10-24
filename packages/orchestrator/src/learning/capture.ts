/**
 * Swarm Learning — Phase 1: Capture
 *
 * Extracts structured observations from a completed swarm run.
 * No LLM calls — deterministic extraction from run state.
 *
 * Outputs:
 * - learned/runs/<runId>.md — per-run observation file (frontmatter + sections)
 * - learned/patterns.jsonl — append-only convention/tool/contention patterns
 * - learned/failures.jsonl — append-only rejection/retry/error log
 */

import { join } from "node:path";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import type {
  RunObservation,
  PatternEntry,
  FailureEntry,
  TaskOutcomeSummary,
  GoalOutcomeSummary,
  ShipReadinessSummary,
  SuggestionDeferredSummary,
} from "@mnmal-ai/swarm-types";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { formatTokens } from "@mnmal-ai/swarm-types";

/** A goal needs at least this many tokens before it is flagged as unusually
 *  heavy, so small runs don't record noise. */
const TOKEN_PATTERN_FLOOR = 1_000_000;

/** Tokens a set of tasks used: all input (cache included) plus output. */
function sumTaskTokens(tasks: TaskOutcomeSummary[]): number {
  let total = 0;
  for (const t of tasks) {
    total += (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
  }
  return total;
}

/** The token line shared by per-task and per-goal summaries:
 *  `Total tokens: 1,243,500`. */
function formatTokenLine(tasks: TaskOutcomeSummary[]): string {
  return `Total tokens: ${sumTaskTokens(tasks).toLocaleString("en-US")}`;
}

/**
 * Sanitize a project name into a filesystem-safe slug for the learned/ path.
 *
 * The learned directory is `<swarmPath>/domains/<project>/learned`, so the
 * project segment must never contain a path-traversal sequence. Unsafe runs of
 * characters collapse to a single "-", leading/trailing separators are trimmed,
 * and a fixed default is returned when nothing safe remains. The result always
 * matches /^[A-Za-z0-9_-]+$/, so it cannot escape the domains directory.
 */
function sanitizeProjectSlug(project: string): string {
  const slug = project.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unknown-project";
}

/**
 * Minimal, frontmatter-only fallback rendered when {@link formatObservationMd}
 * throws. Guarantees the run .md is always written (goal-6d honest-run-summary)
 * even if full formatting fails, and records the formatting error inline so the
 * failure is discoverable in the artifact, not only on the console.
 */
function formatFallbackMd(obs: RunObservation, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return [
    "---",
    `run_id: ${JSON.stringify(obs.runId)}`,
    `date: ${JSON.stringify(obs.date)}`,
    `project: ${JSON.stringify(obs.project)}`,
    `paused: ${obs.paused}`,
    "---",
    "",
    "> **Note:** Full run-summary formatting failed; this is a minimal fallback.",
    `> Error: ${msg}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CaptureInput {
  runId: string;
  project: string;
  swarmVersion: string;
  workerModel: string;
  reviewerModel: string;
  startTime: number;
  endTime: number;
  goals: Array<{
    id: string;
    description: string;
    status: string;
    designs?: string[];
  }>;
  taskOutcomes: TaskOutcomeSummary[];
  /**
   * Authoritative task counts sourced from the Substrate TaskExecution mirror
   * (goal-9). When present, these drive the totalTasks / tasksApproved /
   * tasksRejected axis instead of the taskOutcomes-derived computation. When
   * absent (offline / no-Substrate runs), the taskOutcomes-derived fallback is used
   * unchanged, so capture works identically without a Substrate sidecar.
   */
  taskExecutionCounts?: { total: number; completed: number; failed: number; blocked: number; running: number };
  /** All files changed during the run (created + modified). */
  filesChanged: string[];
  mergeConflicts: string[];
  /** All input tokens (cache included) plus output across the run. */
  totalTokens: number;
  /** Whether the run was paused via SIGINT (incomplete data). */
  paused?: boolean;
  /**
   * Ship-readiness gate outcome for the run, passed in by the orchestrator.
   * `contractLoaded` records whether a ship-readiness contract was present;
   * `goals` carries one entry per evaluated goal. Optional — runs without a
   * contract omit it. Shape matches `RunObservation.shipReadiness`.
   */
  shipReadiness?: { contractLoaded: boolean; goals: ShipReadinessSummary[] };
}

/**
 * Fire-and-forget Substrate mutation helper for learning capture.
 * Logs warnings on failure but never blocks the capture path.
 */
function substrateMutateSafe(
  substrateClient: SubstrateClient,
  mutationName: string,
  params: Record<string, unknown>,
): void {
  substrateClient.mutate(mutationName, params, { id: true }).catch(err => {
    console.warn(
      `[swarm] Substrate ${mutationName} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Capture run observations to the learned/ directory and (optionally) to Substrate.
 * Call this at the end of every swarm run.
 *
 * @param swarmPath - Path to the .swarm directory
 * @param input - Structured run data
 * @param substrateClient - Optional Substrate client for LearningEntry entity creation
 */
export function captureRunObservation(swarmPath: string, input: CaptureInput, substrateClient?: SubstrateClient): void {
  // Sanitize the project name for the filesystem path. The learned dir segment
  // must never carry a path-traversal sequence, but a malformed name must NOT
  // abort the capture: previously this guard threw, and run.ts swallows the
  // throw into a dim log line, so the goal-6d run summary was silently lost
  // (run-id 3dcd7f). Fall back to a sanitized slug, warn so the mismatch is
  // visible, and always continue to the write.
  const projectSlug = sanitizeProjectSlug(input.project);
  if (projectSlug !== input.project) {
    console.warn(
      `[swarm] Learning capture: project name ${JSON.stringify(input.project)} is not a ` +
        `filesystem-safe slug; writing the run summary under ${JSON.stringify(projectSlug)} instead.`,
    );
  }
  const learnedDir = join(swarmPath, "domains", projectSlug, "learned");
  const runsDir = join(learnedDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  const observation = buildObservation(input, swarmPath);

  // 1. Write per-run observation file. A formatting error must never skip the
  //    write — surface it as a visible warning and fall back to a minimal,
  //    frontmatter-only summary so learned/runs/<runId>.md always exists.
  const runFilePath = join(runsDir, `${input.runId}.md`);
  let md: string;
  try {
    md = formatObservationMd(observation);
  } catch (err) {
    console.warn(
      `[swarm] Learning capture: failed to format run summary for ${input.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}. Writing minimal fallback.`,
    );
    md = formatFallbackMd(observation, err);
  }
  writeFileSync(runFilePath, md);

  // 2. Append patterns
  const patterns = extractPatterns(input);
  if (patterns.length > 0) {
    const patternsPath = join(learnedDir, "patterns.jsonl");
    const lines = patterns.map(p => JSON.stringify(p)).join("\n") + "\n";
    appendFileSync(patternsPath, lines);
  }

  // 3. Append failures
  const failures = extractFailures(input);
  if (failures.length > 0) {
    const failuresPath = join(learnedDir, "failures.jsonl");
    const lines = failures.map(f => JSON.stringify(f)).join("\n") + "\n";
    appendFileSync(failuresPath, lines);
  }

  // 4. Create LearningEntry entities in Substrate (fire-and-forget)
  if (substrateClient) {
    const ts = new Date(input.endTime).toISOString();
    const primaryGoalId = input.goals[0]?.id ?? "unknown";

    // Success pattern — if all goals completed and no failures
    const allGoalsCompleted = input.goals.every(g => g.status === "completed");
    const noFailures = failures.length === 0;
    if (allGoalsCompleted && noFailures) {
      substrateMutateSafe(substrateClient, "createLearningEntry", {
        projectId: input.project,
        goalId: primaryGoalId,
        category: "success_pattern",
        content: `Run ${input.runId}: all ${input.goals.length} goal(s) completed successfully. ${input.taskOutcomes.length} task(s), ${formatTokens(input.totalTokens)} tokens in total.`,
        timestamp: ts,
      });
    }

    // Failure patterns — one entry per distinct failure
    for (const failure of failures) {
      substrateMutateSafe(substrateClient, "createLearningEntry", {
        projectId: input.project,
        goalId: failure.goal_id,
        category: "failure_pattern",
        content: `Task ${failure.task_id}: rejected — "${failure.reason}" (retry ${failure.retry_number}, resolved: ${failure.eventually_resolved})`,
        timestamp: ts,
      });
    }

    // Constraint patterns — file contention and other patterns
    for (const pattern of patterns) {
      substrateMutateSafe(substrateClient, "createLearningEntry", {
        projectId: input.project,
        goalId: primaryGoalId,
        category: "constraint_discovered",
        content: `${pattern.type}: ${pattern.observation}`,
        timestamp: ts,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Observation builder
// ---------------------------------------------------------------------------

function buildObservation(input: CaptureInput, swarmPath: string): RunObservation {
  const goalsAttempted = input.goals.map(g => g.id);
  const goalsCompleted = input.goals.filter(g => g.status === "completed").map(g => g.id);
  const goalsFailed = input.goals.filter(g => g.status === "failed").map(g => g.id);

  const isCompleted = (v: string) => v === "approved" || v === "skipped";
  // Prefer the authoritative Substrate TaskExecution counts when supplied (goal-9);
  // otherwise derive the axis from taskOutcomes so offline/no-Substrate runs are
  // unaffected. Either source renders into the same frontmatter fields.
  const counts = input.taskExecutionCounts;
  const totalTasks = counts ? counts.total : input.taskOutcomes.length;
  const tasksApproved = counts
    ? counts.completed
    : input.taskOutcomes.filter(t => isCompleted(t.verdict)).length;
  // Only count tasks whose final verdict is "rejected" (not tasks that were rejected then approved on retry)
  const tasksRejected = counts
    ? counts.failed
    : input.taskOutcomes.filter(t => t.verdict === "rejected").length;
  const totalRetries = input.taskOutcomes.reduce((sum, t) => sum + t.retryCount, 0);
  const arbiterInvocations = input.taskOutcomes.filter(t => t.arbiterInvolved).length;
  const humanEscalations = input.taskOutcomes.filter(t => t.humanEscalation).length;

  const goalOutcomes: GoalOutcomeSummary[] = input.goals.map(g => {
    const goalTasks = input.taskOutcomes.filter(t => t.goalId === g.id);
    const completed = goalTasks.filter(t => isCompleted(t.verdict)).length;
    const status: GoalOutcomeSummary["status"] =
      completed === goalTasks.length && goalTasks.length > 0 ? "completed" :
        completed > 0 ? "partial" : "failed";
    return {
      goalId: g.id,
      description: g.description,
      status,
      tasksAttempted: goalTasks.length,
      tasksCompleted: completed,
      designsReferenced: g.designs ?? [],
    };
  });

  return {
    runId: input.runId,
    date: new Date(input.endTime).toISOString().split("T")[0],
    swarmVersion: input.swarmVersion,
    project: input.project,
    workerModel: input.workerModel,
    reviewerModel: input.reviewerModel,
    goalsAttempted,
    goalsCompleted,
    goalsFailed,
    totalTasks,
    tasksApproved,
    tasksRejected,
    totalRetries,
    arbiterInvocations,
    humanEscalations,
    totalTokens: input.totalTokens,
    durationMs: input.endTime - input.startTime,
    filesChanged: input.filesChanged,
    mergeConflicts: input.mergeConflicts,
    taskOutcomes: input.taskOutcomes,
    goalOutcomes,
    paused: input.paused ?? false,
    // Honest-run-summary sections. Population is deterministic: ship-readiness
    // comes straight from the orchestrator (default when no contract was
    // loaded), deferred suggestions are read from `.suggestions-log.json`, and
    // the human-PR section starts empty — learn-from-pr (goal-6c) back-fills it.
    shipReadiness: input.shipReadiness ?? { contractLoaded: false, goals: [] },
    suggestionsDeferred: readDeferredSuggestions(swarmPath),
    postRunHumanPrs: { backfilled: false, categorizations: [] },
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatObservationMd(obs: RunObservation): string {
  const lines: string[] = [];

  // Frontmatter — use JSON.stringify for string values to ensure valid YAML
  lines.push("---");
  lines.push(`run_id: ${JSON.stringify(obs.runId)}`);
  lines.push(`date: ${JSON.stringify(obs.date)}`);
  lines.push(`swarm_version: ${JSON.stringify(obs.swarmVersion)}`);
  lines.push(`project: ${JSON.stringify(obs.project)}`);
  lines.push(`worker_model: ${JSON.stringify(obs.workerModel)}`);
  lines.push(`reviewer_model: ${JSON.stringify(obs.reviewerModel)}`);
  lines.push(`goals_attempted: ${JSON.stringify(obs.goalsAttempted)}`);
  lines.push(`goals_completed: ${JSON.stringify(obs.goalsCompleted)}`);
  lines.push(`goals_failed: ${JSON.stringify(obs.goalsFailed)}`);
  lines.push(`total_tasks: ${obs.totalTasks}`);
  lines.push(`tasks_approved: ${obs.tasksApproved}`);
  lines.push(`tasks_rejected: ${obs.tasksRejected}`);
  lines.push(`total_retries: ${obs.totalRetries}`);
  lines.push(`arbiter_invocations: ${obs.arbiterInvocations}`);
  lines.push(`human_escalations: ${obs.humanEscalations}`);
  lines.push(`total_tokens: ${obs.totalTokens}`);
  lines.push(`duration_ms: ${obs.durationMs}`);
  lines.push(`paused: ${obs.paused}`);
  lines.push("---");
  lines.push("");

  // Paused indicator
  if (obs.paused) {
    lines.push("> **Note:** This run was paused (SIGINT). Data below is incomplete.");
    lines.push("");
  }

  // Files Changed
  if (obs.filesChanged.length > 0) {
    lines.push("## Files Changed");
    for (const f of obs.filesChanged) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  // Reviewer Feedback
  const tasksWithFeedback = obs.taskOutcomes.filter(t => t.rejectionReasons.length > 0);
  if (tasksWithFeedback.length > 0) {
    lines.push("## Reviewer Feedback");
    for (const t of tasksWithFeedback) {
      for (let i = 0; i < t.rejectionReasons.length; i++) {
        lines.push(`- ${t.taskId}: rejected — "${t.rejectionReasons[i]}"`);
      }
      if (t.verdict === "approved") {
        lines.push(`- ${t.taskId} (final): approved`);
      }
    }
    lines.push("");
  }

  // Merge Conflicts
  if (obs.mergeConflicts.length > 0) {
    lines.push("## Merge Conflicts");
    for (const f of obs.mergeConflicts) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  // Design References Used
  const designsUsed = obs.goalOutcomes.flatMap(g => g.designsReferenced);
  if (designsUsed.length > 0) {
    lines.push("## Design References Used");
    for (const d of designsUsed) {
      const goal = obs.goalOutcomes.find(g => g.designsReferenced.includes(d));
      lines.push(`- ${d} (${goal?.goalId ?? "unknown"})`);
    }
    lines.push("");
  }

  // Goal Summary — each goal's tokens.
  lines.push("## Goal Summary");
  for (const g of obs.goalOutcomes) {
    const goalTasks = obs.taskOutcomes.filter(t => t.goalId === g.goalId);
    lines.push(
      `- ${g.goalId}: ${g.status} (${g.tasksCompleted}/${g.tasksAttempted} tasks) — ${formatTokenLine(goalTasks)}`,
    );
  }
  lines.push("");

  // Task Details — each task's tokens.
  lines.push("## Task Details");
  for (const t of obs.taskOutcomes) {
    lines.push(`- ${t.taskId} [${t.intent}]: ${t.verdict} — ${formatTokenLine([t])}, ${t.retryCount} retries`);
  }
  lines.push("");

  // ---- Honest run summary (plan Phase 6.5) ------------------------------
  // Rendered in a fixed position (after Task Details) with deterministic
  // ordering so the markdown snapshot is stable across runs.

  // Ship Readiness — did the gate fire, on which goals, with what status.
  lines.push("## Ship Readiness");
  if (obs.shipReadiness?.contractLoaded) {
    if (obs.shipReadiness.goals.length === 0) {
      // Contract loaded but no goal reached the execution block (e.g. all
      // goals were dependency-skipped, or the run paused before any goal
      // completed). Surface this explicitly instead of rendering a blank
      // section under the heading.
      lines.push("Ship-readiness contract loaded but no goal outcomes were recorded.");
    } else {
      for (const g of obs.shipReadiness.goals) {
        lines.push(g.detail ? `- ${g.goalId}: ${g.status} — ${g.detail}` : `- ${g.goalId}: ${g.status}`);
      }
    }
  } else {
    lines.push("No ship-readiness contract — gate did not run.");
  }
  lines.push("");

  // Suggestions Deferred — declined offers from `.suggestions-log.json`.
  lines.push("## Suggestions Deferred");
  const deferred = obs.suggestionsDeferred ?? [];
  if (deferred.length > 0) {
    for (const d of deferred) {
      lines.push(d.reason ? `- ${d.axis}: ${d.reason}` : `- ${d.axis}`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");

  // Post-run Human PRs — empty at write time; learn-from-pr (goal-6c)
  // back-fills it later. Always rendered so the placeholder is discoverable.
  lines.push("## Post-run Human PRs");
  const humanPrs = obs.postRunHumanPrs;
  if (humanPrs?.backfilled) {
    for (const c of humanPrs.categorizations) {
      lines.push(`- PR #${c.prNumber}: ${c.category} (confidence ${c.confidence})`);
    }
  } else {
    lines.push("_None yet — back-filled by `swarm learn-from-pr`._");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pattern extraction
// ---------------------------------------------------------------------------

export function extractPatterns(input: CaptureInput): PatternEntry[] {
  const patterns: PatternEntry[] = [];
  const ts = new Date(input.endTime).toISOString();

  // File contention patterns — files involved in merge conflicts
  for (const file of input.mergeConflicts) {
    patterns.push({
      run_id: input.runId,
      timestamp: ts,
      type: "file_contention",
      observation: `Merge conflict on ${file}`,
      files: [file],
      source: "worktree_merge",
    });
  }

  // Reviewer patterns — rejection reasons that appear 2+ times (across tasks or within retries)
  const rejectionCounts = new Map<string, number>();
  for (const task of input.taskOutcomes) {
    for (const reason of task.rejectionReasons) {
      const normalized = reason.toLowerCase().trim();
      rejectionCounts.set(normalized, (rejectionCounts.get(normalized) ?? 0) + 1);
    }
  }
  for (const [reason, count] of rejectionCounts) {
    if (count >= 2) {
      patterns.push({
        run_id: input.runId,
        timestamp: ts,
        type: "reviewer_pattern",
        observation: `Reviewer rejected ${count} times for: ${reason}`,
        files: [],
        source: "oversight_verdicts",
      });
    }
  }

  // Token patterns — goals that used unusually many tokens
  const goalTokens = new Map<string, number>();
  for (const task of input.taskOutcomes) {
    goalTokens.set(task.goalId, (goalTokens.get(task.goalId) ?? 0) + sumTaskTokens([task]));
  }
  const avgGoalTokens = input.totalTokens / (input.goals.length || 1);
  for (const [goalId, tokens] of goalTokens) {
    if (tokens > avgGoalTokens * 2 && tokens > TOKEN_PATTERN_FLOOR) {
      patterns.push({
        run_id: input.runId,
        timestamp: ts,
        type: "token_pattern",
        observation: `Goal ${goalId} used ${formatTokens(tokens)} tokens, ${(tokens / avgGoalTokens).toFixed(1)}x average`,
        files: [],
        source: "token_tracking",
      });
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Failure extraction
// ---------------------------------------------------------------------------

export function extractFailures(input: CaptureInput): FailureEntry[] {
  const failures: FailureEntry[] = [];
  const ts = new Date(input.endTime).toISOString();

  for (const task of input.taskOutcomes) {
    if (task.rejectionReasons.length === 0) continue;

    for (let i = 0; i < task.rejectionReasons.length; i++) {
      const isLast = i === task.rejectionReasons.length - 1;
      const eventuallyResolved = isLast && task.verdict === "approved";

      failures.push({
        run_id: input.runId,
        timestamp: ts,
        task_id: task.taskId,
        goal_id: task.goalId,
        verdict: "rejected",
        reason: task.rejectionReasons[i],
        retry_number: i + 1,
        eventually_resolved: eventuallyResolved,
        ...(eventuallyResolved ? { resolution: "Approved after retry" } : {}),
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Deferred-suggestions reader
// ---------------------------------------------------------------------------

/**
 * Shape of a single entry in `<swarmPath>/.suggestions-log.json`, as consumed
 * here. Defined locally — the canonical writer lives in swarm-cli, and the
 * orchestrator must not import from cli (cli depends on orchestrator; the
 * reverse edge would be a cycle). Only the fields this reader needs are typed;
 * unknown extra fields are ignored.
 */
interface SuggestionsLogEntry {
  catalogEntryId: string;
  axis: string;
  response: string;
  reason?: string;
  offeredAt: string;
}

/**
 * Read declined suggestion offers from `<swarmPath>/.suggestions-log.json`.
 *
 * Pure and deterministic: reads the file, maps entries whose `response` is
 * "no" into `SuggestionDeferredSummary` objects, and preserves their order.
 * A missing or malformed file yields `[]` rather than throwing, so the run
 * report can always be written.
 *
 * @param swarmPath - Path to the .swarm directory
 */
export function readDeferredSuggestions(swarmPath: string): SuggestionDeferredSummary[] {
  let entries: SuggestionsLogEntry[];
  try {
    const raw = readFileSync(join(swarmPath, ".suggestions-log.json"), "utf8");
    const parsed = JSON.parse(raw);
    // Canonical format is a SuggestionsLog object — { schemaVersion, generatedAt,
    // detection, entries }. Legacy/test fixtures sometimes wrote a bare array.
    // Unwrap the entries field if present; otherwise accept a top-level array.
    const candidate = Array.isArray(parsed?.entries) ? parsed.entries : parsed;
    if (!Array.isArray(candidate)) return [];
    entries = candidate as SuggestionsLogEntry[];
  } catch {
    return [];
  }

  return entries
    .filter(e => e.response === "no")
    .map(e => ({
      catalogEntryId: e.catalogEntryId,
      axis: e.axis,
      reason: e.reason,
      offeredAt: e.offeredAt,
    }));
}
