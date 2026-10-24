/**
 * Complexity estimation and sub-decomposition module.
 *
 * Provides:
 * - estimateComplexity(): Pure heuristic scoring of task descriptions (no LLM, <1ms)
 * - subDecompose(): LLM-driven sub-decomposition of complex tasks
 * - createEscalationWatcher(): Event-driven monitor that fires when a task should be aborted
 */

import type {
  ComplexityEstimate,
  ComplexityBand,
  ComplexitySignal,
  ComplexityThresholds,
  ComplexityConfig,
  SubDecompositionResult,
  EscalationReason,
  Task,
  Goal,
  ISwarmEventBus,
} from "@mnmal-ai/swarm-types";
import { formatTokens } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Default thresholds (used when swarm.json lacks a complexity section)
// ---------------------------------------------------------------------------

export const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  simpleMax: 30,
  complexMin: 61,
  tokenEscalationFraction: 0.5,
  turnEscalationFraction: 0.7,
  timeoutEscalationFraction: 0.6,
};

/**
 * Convert a ComplexityConfig from swarm.json into SDK-internal ComplexityThresholds.
 */
export function configToThresholds(config?: ComplexityConfig): ComplexityThresholds {
  if (!config) return { ...DEFAULT_COMPLEXITY_THRESHOLDS };
  if (config.simple_max >= config.complex_min) {
    throw new Error(
      `Invalid complexity config: simple_max (${config.simple_max}) must be less than complex_min (${config.complex_min})`,
    );
  }
  return {
    simpleMax: config.simple_max,
    complexMin: config.complex_min,
    tokenEscalationFraction: config.escalation.token_fraction,
    turnEscalationFraction: config.escalation.turn_fraction,
    timeoutEscalationFraction: config.escalation.timeout_fraction,
  };
}

// ---------------------------------------------------------------------------
// Heuristic scoring
// ---------------------------------------------------------------------------

/** Imperative verbs that indicate distinct actions in a task description. */
const ACTION_VERBS = new Set([
  "convert", "add", "migrate", "refactor", "update", "remove", "replace",
  "implement", "create", "fix", "build", "change", "move", "rename",
  "extract", "merge", "split", "delete", "introduce", "configure",
  "rewrite", "transform", "restructure", "reorganize", "optimize",
]);

/** Scope markers that indicate breadth of change. */
const SCOPE_MARKERS = [
  "all", "every", "each", "entire", "across", "throughout", "whole",
];

/** Patterns that indicate migration-style changes. */
const MIGRATION_PATTERNS = [
  /migrate\s+from\s+\S+\s+to\s+\S+/i,
  /convert\s+\S+\s+to\s+\S+/i,
  /replace\s+\S+\s+with\s+\S+/i,
  /switch\s+from\s+\S+\s+to\s+\S+/i,
  /move\s+from\s+\S+\s+to\s+\S+/i,
];

/**
 * Estimate the complexity of a task description using pure heuristics.
 *
 * Returns a score from 0-100 with band classification and detailed signals.
 * No LLM call, no I/O — runs in <1ms.
 */
export function estimateComplexity(
  description: string,
  thresholds?: ComplexityThresholds,
): ComplexityEstimate {
  const t = thresholds ?? DEFAULT_COMPLEXITY_THRESHOLDS;
  const signals: ComplexitySignal[] = [];

  // Signal 1: Conjunction count (0-25)
  const conjunctionScore = scoreConjunctions(description);
  signals.push(conjunctionScore);

  // Signal 2: Verb count (0-20)
  const verbScore = scoreVerbs(description);
  signals.push(verbScore);

  // Signal 3: Scope markers (0-15)
  const scopeScore = scoreScopeMarkers(description);
  signals.push(scopeScore);

  // Signal 4: File breadth (0-15)
  const fileBreadthScore = scoreFileBreadth(description);
  signals.push(fileBreadthScore);

  // Signal 5: Migration language (0-10)
  const migrationScore = scoreMigrationLanguage(description);
  signals.push(migrationScore);

  // Signal 6: Description length (0-15)
  const lengthScore = scoreLength(description);
  signals.push(lengthScore);

  const totalScore = Math.min(100, signals.reduce((sum, s) => sum + s.score, 0));

  const band: ComplexityBand =
    totalScore <= t.simpleMax ? "simple" :
    totalScore >= t.complexMin ? "complex" :
    "moderate";

  const reasoning = signals
    .filter(s => s.score > 0)
    .map(s => `${s.name}=${s.score}/${s.maxScore} (${s.detail})`)
    .join(", ");

  return {
    score: totalScore,
    band,
    signals,
    reasoning: `Score ${totalScore}: ${reasoning}`,
  };
}

function scoreConjunctions(description: string): ComplexitySignal {
  const MAX = 25;
  // Count "and" that separates independent clauses (not inside quoted strings)
  // Also count commas that separate independent verb phrases
  const lower = description.toLowerCase();

  // Count "and" as conjunction
  const andCount = (lower.match(/\band\b/g) ?? []).length;

  // Count commas separating what appear to be independent clauses
  const commaCount = (description.match(/,\s*(?=[a-z])/gi) ?? []).length;

  const count = andCount + Math.floor(commaCount * 0.5);
  const score = Math.min(MAX, count * 5);

  return {
    name: "conjunctions",
    score,
    maxScore: MAX,
    detail: `${andCount} "and" + ${commaCount} clause-separating commas`,
  };
}

function scoreVerbs(description: string): ComplexitySignal {
  const MAX = 20;
  const words = description.toLowerCase().split(/\s+/);
  const foundVerbs = new Set<string>();

  for (const word of words) {
    // Strip trailing punctuation
    const clean = word.replace(/[^a-z]/g, "");
    if (ACTION_VERBS.has(clean)) {
      foundVerbs.add(clean);
    }
  }

  // 1 verb = 0 (expected), 2 verbs = 8, 3+ = 15-20
  const count = foundVerbs.size;
  const score = count <= 1 ? 0 : Math.min(MAX, (count - 1) * 8);

  return {
    name: "verb_count",
    score,
    maxScore: MAX,
    detail: `${count} distinct action verb(s): ${[...foundVerbs].join(", ") || "none"}`,
  };
}

function scoreScopeMarkers(description: string): ComplexitySignal {
  const MAX = 15;
  const lower = description.toLowerCase();
  const found: string[] = [];

  for (const marker of SCOPE_MARKERS) {
    const regex = new RegExp(`\\b${marker}\\b`, "g");
    if (regex.test(lower)) {
      found.push(marker);
    }
  }

  const score = Math.min(MAX, found.length * 10);

  return {
    name: "scope_markers",
    score,
    maxScore: MAX,
    detail: found.length > 0 ? `found: ${found.join(", ")}` : "none",
  };
}

function scoreFileBreadth(description: string): ComplexitySignal {
  const MAX = 15;
  // Look for file-like references: extensions, paths, type names suggesting multiple files
  const filePatterns = description.match(/\b[\w.-]+\.(swift|ts|tsx|js|jsx|py|go|rs|java|kt|json|md)\b/gi) ?? [];
  const modulePatterns = description.match(/\b(?:model|view|controller|service|handler|manager|provider|component|module)s?\b/gi) ?? [];

  const uniqueFiles = new Set(filePatterns.map(f => f.toLowerCase()));
  const uniqueModules = new Set(modulePatterns.map(m => m.toLowerCase()));

  const count = uniqueFiles.size + Math.floor(uniqueModules.size * 0.5);
  const score = Math.min(MAX, count * 5);

  return {
    name: "file_breadth",
    score,
    maxScore: MAX,
    detail: `${uniqueFiles.size} file ref(s), ${uniqueModules.size} module ref(s)`,
  };
}

function scoreMigrationLanguage(description: string): ComplexitySignal {
  const MAX = 10;
  let matchCount = 0;

  for (const pattern of MIGRATION_PATTERNS) {
    if (pattern.test(description)) {
      matchCount++;
    }
  }

  const score = Math.min(MAX, matchCount * 10);

  return {
    name: "migration_language",
    score,
    maxScore: MAX,
    detail: matchCount > 0 ? `${matchCount} migration pattern(s)` : "none",
  };
}

function scoreLength(description: string): ComplexitySignal {
  const MAX = 15;
  const len = description.length;

  // Short descriptions (<80 chars) = 0, medium (80-200) = 5-8, long (200+) = 10-15
  let score = 0;
  if (len > 200) {
    score = Math.min(MAX, 10 + Math.floor((len - 200) / 100));
  } else if (len > 80) {
    score = Math.min(8, Math.floor((len - 80) / 15));
  }

  return {
    name: "description_length",
    score,
    maxScore: MAX,
    detail: `${len} characters`,
  };
}

// ---------------------------------------------------------------------------
// Complexity-based timeout (SDK-25)
// ---------------------------------------------------------------------------

/** Default timeouts in milliseconds by complexity band. */
const DEFAULT_TIMEOUTS_MS: Record<ComplexityBand, number> = {
  simple: 300_000,   // 5 minutes
  moderate: 600_000,  // 10 minutes
  complex: 900_000,   // 15 minutes
};

/**
 * Return a timeout in milliseconds scaled by complexity band.
 *
 * Simple tasks get shorter timeouts (3m) — if they're not done fast, something
 * is wrong. Complex tasks get longer timeouts (10m) — they legitimately need
 * more time for multi-file changes and test runs.
 *
 * Custom overrides can be provided per-band; missing bands fall back to defaults.
 */
export function getTimeoutForComplexity(
  band: ComplexityBand,
  overrides?: Partial<Record<ComplexityBand, number>>,
): number {
  return overrides?.[band] ?? DEFAULT_TIMEOUTS_MS[band];
}

// ---------------------------------------------------------------------------
// Escalation watcher
// ---------------------------------------------------------------------------

export interface EscalationWatcher {
  /** Check if escalation has been triggered. */
  isTriggered(): boolean;
  /** Get the reason for escalation, if triggered. */
  getReason(): EscalationReason | null;
  /** Get detail message about the escalation. */
  getDetail(): string;
  /** Stop watching and clean up event subscriptions. */
  dispose(): void;
}

/**
 * Create an EscalationWatcher that monitors event bus events for a specific task.
 * Fires when token, turn count, timeout, or reviewer rejection thresholds are exceeded.
 *
 * Tokens are counted from the turn:end events seen since the watcher started
 * (input plus output per turn), against `tokenLimit` × the token escalation
 * fraction.
 */
export function createEscalationWatcher(
  eventBus: ISwarmEventBus,
  taskId: string,
  thresholds: ComplexityThresholds,
  limits: { tokenLimit: number; maxTurns: number; timeoutMs: number },
): EscalationWatcher {
  let triggered = false;
  let reason: EscalationReason | null = null;
  let detail = "";
  let tokensSeen = 0;

  const tokenThreshold = limits.tokenLimit * thresholds.tokenEscalationFraction;
  const turnThreshold = Math.floor(limits.maxTurns * thresholds.turnEscalationFraction);
  const timeoutThreshold = limits.timeoutMs * thresholds.timeoutEscalationFraction;

  const startTime = Date.now();

  function trigger(r: EscalationReason, d: string): void {
    if (triggered) return;
    triggered = true;
    reason = r;
    detail = d;
  }

  // Monitor turn ends
  const onTurnEnd = (e: { turn: number; inputTokens: number; outputTokens: number; timestamp: number }) => {
    tokensSeen += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    if (tokenThreshold > 0 && tokensSeen >= tokenThreshold) {
      trigger("token_threshold", `Tokens ${formatTokens(tokensSeen)} >= threshold ${formatTokens(tokenThreshold)} (${(thresholds.tokenEscalationFraction * 100).toFixed(0)}% of limit)`);
    }

    if (turnThreshold > 0 && e.turn >= turnThreshold) {
      trigger("turn_threshold", `Turn ${e.turn + 1} >= threshold ${turnThreshold + 1} (${(thresholds.turnEscalationFraction * 100).toFixed(0)}% of maxTurns)`);
    }

    // Also check timeout on each turn
    const elapsed = Date.now() - startTime;
    if (timeoutThreshold > 0 && elapsed >= timeoutThreshold) {
      trigger("timeout_threshold", `Elapsed ${elapsed}ms >= threshold ${timeoutThreshold.toFixed(0)}ms (${(thresholds.timeoutEscalationFraction * 100).toFixed(0)}% of timeout)`);
    }
  };

  // Monitor reviewer rejections
  const onTaskVerdict = (e: { taskId: string; verdict: string; timestamp: number }) => {
    if (e.taskId === taskId && e.verdict === "rejected") {
      trigger("reviewer_rejection", "First reviewer rejection on broad task — sub-decomposition is better recovery");
    }
  };

  eventBus.on("turn:end", onTurnEnd);
  eventBus.on("task:verdict", onTaskVerdict);

  return {
    isTriggered: () => triggered,
    getReason: () => reason,
    getDetail: () => detail,
    dispose: () => {
      eventBus.off("turn:end", onTurnEnd);
      eventBus.off("task:verdict", onTaskVerdict);
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-decomposition (LLM-driven)
// ---------------------------------------------------------------------------

/**
 * Sub-decompose a task into smaller sub-tasks using an LLM call.
 * Reuses the Swarm's run() method with the orchestration intent.
 *
 * Hard invariant: subtasks are never further decomposed. Only top-level
 * tasks (those without a parentTaskId) can be sub-decomposed. This
 * prevents the recursive depth explosion seen in early cold tests.
 */
export async function subDecompose(
  swarm: { run: (task: string, options: { input: string; project?: string; intentOverride?: string; workingDirectory?: string }) => Promise<{ output: string; tokensUsed?: SubDecompositionResult["tokensUsed"] }> },
  task: Task,
  goal: Goal,
  projectName: string,
): Promise<SubDecompositionResult> {
  // Hard depth limit: subtasks are never further decomposed.
  if (task.parentTaskId) {
    return {
      subTasks: [],
      reasoning: `Depth limit: task "${task.id}" is already a subtask (parent: ${task.parentTaskId}) — refusing further decomposition`,
    };
  }
  const result = await swarm.run(
    "Break this task into smaller, independent sub-tasks that can each be completed in isolation.",
    {
      input: [
        `## Parent Goal: ${goal.description}`,
        "",
        `## Task to Decompose: ${task.description}`,
        "",
        `## Instructions`,
        `This task was flagged as too complex for a single agent invocation.`,
        `Break it into 2-5 smaller, independent sub-tasks.`,
        `Each sub-task should be completable by a single agent in one session.`,
        `Order them by dependency — independent tasks first.`,
        "",
        `For each sub-task, provide a short "title" (under 60 chars) and a longer "description".`,
        "",
        `For each sub-task, also declare which files it will touch:`,
        `- "creates": files this sub-task will create that do not exist yet. Use full relative paths from the project root.`,
        `- "modifies": existing files this sub-task will need to change. Use full relative paths from the project root.`,
        `When unsure, include the file in "modifies" — over-declaring is safe.`,
        "",
        `Output ONLY a JSON array in this format, no other text:`,
        "```json",
        `[`,
        `  { "title": "Short sub-task title", "description": "specific sub-task description", "intent": "implementation", "creates": ["src/new.ts"], "modifies": ["src/index.ts"] },`,
        `  { "title": "Another sub-task", "description": "another sub-task description", "intent": "implementation", "creates": [], "modifies": ["src/index.ts"] }`,
        `]`,
        "```",
      ].join("\n"),
      project: projectName,
      intentOverride: "orchestration",
      workingDirectory: process.cwd(),
    },
  );

  // Parse JSON from output
  let jsonStr: string | null = null;
  const startIdx = result.output.indexOf("[");
  if (startIdx !== -1) {
    let depth = 0;
    for (let i = startIdx; i < result.output.length; i++) {
      if (result.output[i] === "[") depth++;
      if (result.output[i] === "]") depth--;
      if (depth === 0) {
        jsonStr = result.output.slice(startIdx, i + 1);
        break;
      }
    }
  }

  if (!jsonStr) {
    return {
      subTasks: [],
      reasoning: "Could not parse sub-decomposition output",
      tokensUsed: result.tokensUsed,
    };
  }

  try {
    const parsed = JSON.parse(jsonStr) as Array<{ title?: string; description: string; intent: string; creates?: string[]; modifies?: string[] }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        subTasks: [],
        reasoning: "Sub-decomposition returned empty task list",
        tokensUsed: result.tokensUsed,
      };
    }

    const KNOWN_INTENTS = new Set([
      "code-review", "implementation", "investigation", "onboarding", "orchestration",
    ]);

    const subTasks: Task[] = parsed
      .filter(t => t.description && typeof t.description === "string")
      .map((t, i) => ({
        id: `${task.id}-sub-${i + 1}`,
        goal_id: task.goal_id,
        title: t.title,
        description: t.description,
        intent: (t.intent && KNOWN_INTENTS.has(t.intent)) ? t.intent : "implementation",
        status: "pending" as const,
        order: i + 1,
        parentTaskId: task.id,
        serializedFiles: Array.isArray(t.modifies) ? [...t.modifies] : undefined,
      }));

    return {
      subTasks,
      reasoning: `Decomposed into ${subTasks.length} sub-tasks`,
      tokensUsed: result.tokensUsed,
    };
  } catch {
    return {
      subTasks: [],
      reasoning: "Failed to parse sub-decomposition JSON",
      tokensUsed: result.tokensUsed,
    };
  }
}
