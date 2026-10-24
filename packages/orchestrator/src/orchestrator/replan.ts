/**
 * Post-goal failure analysis and replanning for the orchestrator.
 *
 * After all tasks in a goal complete (or fail), this module analyzes the
 * results and decides what to do about failures: retry with decomposed
 * subtasks, escalate to a human, or fold into the next goal.
 *
 * Pure functions with no side effects — easy to test, easy to integrate.
 */

import type { Task } from "@mnmal-ai/swarm-types";
import { matchesGlob } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Categorical classification of why a task failed.
 * Used to detect systemic issues (all failures same category) vs.
 * diverse failures that benefit from targeted decomposition.
 */
export type FailureCategory =
  | "build_error"
  | "test_failure"
  | "merge_conflict"
  | "tool_failure"
  | "timeout"
  | "empty_output"
  | "reviewer_rejected"
  | "unknown";

/**
 * Result of a single task within a goal, used for post-goal analysis.
 *
 * Named ReplanTaskResult to avoid collision with the existing TaskResult
 * in types/index.ts which tracks different fields (output, tokens, latency).
 */
export interface ReplanTaskResult {
  taskId: string;
  status: "completed" | "failed";
  failureReason?: string;
  failureCategory?: FailureCategory;
  retryCount: number;
  output?: string;
}

/**
 * A subtask created by the replanning module when decomposing a failed task.
 */
export interface ReplanSubtask {
  description: string;
  dependsOn?: string[];
}

/**
 * Decision produced by analyzeGoalResults after examining all task outcomes.
 */
export interface ReplanDecision {
  /** What action the orchestrator should take. */
  action: "no_action" | "retry_decomposed" | "escalate_human" | "fold_into_next_goal" | "reorder_with_edges";
  /** Human-readable explanation of why this action was chosen. */
  reason: string;
  /** New tasks to create when action is retry_decomposed. */
  newTasks?: ReplanSubtask[];
  /** Dynamic edges to inject when action is reorder_with_edges. */
  newEdges?: Array<{ from: string; to: string }>;
  /** Message for human when action is escalate_human. */
  escalationMessage?: string;
  /** IDs of the tasks that failed. */
  failedTaskIds?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate untrusted text before embedding in task descriptions.
 * Prevents prompt injection from adversarially crafted build/test output.
 */
function sanitizeForDescription(text: string, maxLength = 500): string {
  if (!text) return "";
  return text.slice(0, maxLength) + (text.length > maxLength ? "...[truncated]" : "");
}

// ---------------------------------------------------------------------------
// Failure categorization
// ---------------------------------------------------------------------------

/**
 * Regex patterns for failure categorization. Order matters — more specific
 * categories are checked before more general ones. Each regex uses the `i`
 * flag for case-insensitive matching.
 *
 * Build error patterns are deliberately distinct from test failure patterns:
 * - "build failed" / "failed to compile" / "compilation error" → build
 * - "test failed" / "assertion" / "FAIL <path>" → test
 */
const CATEGORY_PATTERNS: Array<{ category: FailureCategory; patterns: RegExp[] }> = [
  {
    category: "merge_conflict",
    patterns: [
      /\bmerge conflict(s)?\b/i,
      /CONFLICT\s*\([^)]*\):/i,
      /<<<<<<</i,
    ],
  },
  {
    category: "tool_failure",
    patterns: [
      /mcp.*error/i,
      /MCP server.*(?:error|fail|crash|unavailable|refused)/i,
      /tool.*not found/i,
      /command failed.*mcp/i,
      /xcodebuild.*error/i,
      /automation.*not.*enabled/i,
      /simulator.*not.*booted/i,
      /scheme.*not found/i,
      /no such.*mcp/i,
    ],
  },
  {
    category: "timeout",
    patterns: [
      /time\s*out/i,
      /timed\s+out/i,
      /(?:token|context)\s+limit\s+exceeded/i,
    ],
  },
  {
    category: "test_failure",
    patterns: [
      /test\s+fail/i,
      /assertion/i,
      /expected.+but.+(got|received)/i,
      /\bExpected:/i,
      /\bReceived:/i,
      /\bFAIL\s+\S/i,   // "FAIL src/foo.test.ts" — vitest/jest output
    ],
  },
  {
    category: "build_error",
    patterns: [
      /\berror:/i,
      /failed to compile/i,
      /build\s+failed/i,
      /compilation\s+error/i,
    ],
  },
];

/**
 * Categorize a failure from the task output and reviewer feedback.
 * Looks at the combined text of output and failureReason for patterns
 * indicating the type of failure. Case-insensitive matching.
 */
export function categorizeFailure(
  output: string | undefined,
  failureReason?: string,
): FailureCategory {
  // Check for empty output first — if there's literally nothing to analyze
  if (!output || output.trim().length === 0) {
    // If there's a failure reason but no output, still check the reason
    if (!failureReason || failureReason.trim().length === 0) {
      return "empty_output";
    }
  }

  // Combine both sources for pattern matching
  const combined = `${output ?? ""} ${failureReason ?? ""}`;

  // Reviewer rejection — check combined text (output + failureReason)
  if (/reject/i.test(combined)) {
    return "reviewer_rejected";
  }

  // Walk through category patterns in priority order
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((re) => re.test(combined))) {
      return category;
    }
  }

  // Empty output check — very short output with no clear error pattern
  if (output !== undefined && output.trim().length < 5) {
    return "empty_output";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Goal result analysis
// ---------------------------------------------------------------------------

/** Default maximum number of remediation rounds before escalating. */
const DEFAULT_MAX_REMEDIATION_ROUNDS = 2;

/**
 * Given all task results for a goal, decide what to do about failures.
 *
 * Decision logic:
 * 1. All succeeded -> no_action
 * 2. Already at max remediation rounds -> escalate_human
 * 3. Categorize all failures
 * 4. Failures are merge_conflict -> fold_into_next_goal
 * 5. Check for prerequisite issues (empty_output with missing files) -> reorder_with_edges
 * 6. All failures are tool_failure -> retry_decomposed (fixable, not systemic)
 * 7. All failures same category -> likely systemic -> escalate_human
 * 8. Otherwise -> retry_decomposed with new tasks per failed task
 */
export function analyzeGoalResults(
  results: ReplanTaskResult[],
  currentRemediationRound: number = 0,
  maxRemediationRounds: number = DEFAULT_MAX_REMEDIATION_ROUNDS,
  allTasks?: Task[],
): ReplanDecision {
  // 1. If all tasks succeeded, nothing to do
  const failedResults = results.filter((r) => r.status === "failed");

  if (failedResults.length === 0) {
    return {
      action: "no_action",
      reason: "All tasks completed successfully",
    };
  }

  const failedTaskIds = failedResults.map((r) => r.taskId);

  // 2. If we've hit the remediation cap, escalate
  if (currentRemediationRound >= maxRemediationRounds) {
    return {
      action: "escalate_human",
      reason: `Remediation round ${currentRemediationRound} reached maximum of ${maxRemediationRounds}. ${failedResults.length} task(s) still failing.`,
      escalationMessage: `After ${maxRemediationRounds} remediation round(s), ${failedResults.length} task(s) are still failing. `
        + `Failed tasks: ${failedTaskIds.join(", ")}. `
        + `Manual intervention is needed to diagnose the root cause.`,
      failedTaskIds,
    };
  }

  // 3. Categorize all failures
  const categorized = failedResults.map((r) => ({
    ...r,
    failureCategory: r.failureCategory ?? categorizeFailure(r.output, r.failureReason),
  }));

  const categories = new Set(categorized.map((r) => r.failureCategory));

  // 4. Check for merge conflicts first — these need sequencing, not retrying
  if (categories.size === 1 && categories.has("merge_conflict")) {
    return {
      action: "fold_into_next_goal",
      reason: `All ${failedResults.length} failure(s) are merge conflicts. These need sequencing rather than retrying.`,
      failedTaskIds,
    };
  }

  // Also fold if merge conflicts are present among mixed failures
  if (categories.has("merge_conflict")) {
    const mergeConflictTasks = categorized.filter((r) => r.failureCategory === "merge_conflict");
    const nonMergeFailures = categorized.filter((r) => r.failureCategory !== "merge_conflict");

    // If there are non-merge failures too, decompose those and fold merge conflicts
    if (nonMergeFailures.length > 0) {
      const newTasks = nonMergeFailures.map((r) => ({
        description: `Retry: ${r.taskId} — failed with ${r.failureCategory}: ${sanitizeForDescription(r.failureReason ?? r.output ?? "no details")}`,
      }));

      return {
        action: "retry_decomposed",
        reason: `${nonMergeFailures.length} non-merge failure(s) will be retried as decomposed tasks. `
          + `${mergeConflictTasks.length} merge conflict(s) should be sequenced in the next goal.`,
        newTasks,
        failedTaskIds,
      };
    }
  }

  // 5. Check for prerequisite issues — empty_output tasks that depend on uncompleted work
  if (allTasks && categories.has("empty_output")) {
    const emptyOutputTasks = categorized.filter((r) => r.failureCategory === "empty_output");
    const newEdges: Array<{ from: string; to: string }> = [];

    for (const failedResult of emptyOutputTasks) {
      const task = allTasks.find((t) => t.id === failedResult.taskId);
      if (!task) continue;
      const diagnosis = diagnoseEmptyOutput(task, allTasks);
      if (diagnosis.diagnosis === "blocked_prerequisite") {
        for (const blockerId of diagnosis.blockedBy) {
          newEdges.push({ from: blockerId, to: task.id });
        }
      }
    }

    if (newEdges.length > 0) {
      return {
        action: "reorder_with_edges",
        reason: `${emptyOutputTasks.length} task(s) failed with empty_output due to prerequisite issues. Injecting ${newEdges.length} dependency edge(s) and re-sorting.`,
        newEdges,
        failedTaskIds,
      };
    }
  }

  // 6. Tool failures are fixable — retry with fix instructions instead of escalating
  if (categories.size === 1 && categories.has("tool_failure")) {
    const newTasks = categorized.map((r) => ({
      description: `Previous attempt failed due to tool misconfiguration: ${sanitizeForDescription(r.failureReason ?? r.output ?? "no details")}. Research how to configure the tool correctly, fix the configuration, then retry: ${sanitizeForDescription(r.taskId)}`,
    }));

    return {
      action: "retry_decomposed",
      reason: `All ${failedResults.length} failure(s) are tool configuration issues. Tool failures are fixable — retrying with fix instructions.`,
      newTasks,
      failedTaskIds,
    };
  }

  // 6. If all failures are the same category AND there are more than 2, it's likely systemic -> escalate
  // Require N > 2 to avoid false-positive escalation from a single task or coincidental pair.
  if (categories.size === 1 && failedResults.length > 2) {
    const category = [...categories][0];
    return {
      action: "escalate_human",
      reason: `All ${failedResults.length} failure(s) share the same category: ${category}. This suggests a systemic issue.`,
      escalationMessage: `Systemic failure detected: all ${failedResults.length} failed task(s) have the same failure category "${category}". `
        + `This likely indicates an environment or configuration issue rather than individual task problems. `
        + `Failed tasks: ${failedTaskIds.join(", ")}.`,
      failedTaskIds,
    };
  }

  // 7. Mixed failures -> decompose into smaller retry tasks
  const newTasks = categorized.map((r) => ({
    description: `Retry: ${r.taskId} — failed with ${r.failureCategory}: ${sanitizeForDescription(r.failureReason ?? r.output ?? "no details")}`,
  }));

  return {
    action: "retry_decomposed",
    reason: `${failedResults.length} task(s) failed with ${categories.size} different failure categories. Retrying with focused subtasks.`,
    newTasks,
    failedTaskIds,
  };
}

// ---------------------------------------------------------------------------
// Empty output prerequisite diagnosis
// ---------------------------------------------------------------------------

export interface EmptyOutputDiagnosis {
  diagnosis: "blocked_prerequisite" | "unknown";
  /** Task IDs that should complete before this task can succeed. */
  blockedBy: string[];
}

/**
 * When a task fails with empty_output, check whether its target files
 * (serializedFiles) are expected to be created by another task (createsFiles).
 * If so, this is a prerequisite issue, not a worker issue.
 */
export function diagnoseEmptyOutput(
  failedTask: Task,
  allTasks: Task[],
): EmptyOutputDiagnosis {
  const blockedBy: string[] = [];

  const targetFiles = failedTask.serializedFiles ?? [];
  if (targetFiles.length === 0) {
    return { diagnosis: "unknown", blockedBy: [] };
  }

  for (const task of allTasks) {
    if (task.id === failedTask.id) continue;
    if (task.status === "completed") continue;
    const creates = task.createsFiles ?? [];
    for (const file of targetFiles) {
      if (creates.some((c) => c === file || matchesGlob(file, c))) {
        blockedBy.push(task.id);
        break;
      }
    }
  }

  if (blockedBy.length > 0) {
    return { diagnosis: "blocked_prerequisite", blockedBy };
  }
  return { diagnosis: "unknown", blockedBy: [] };
}
