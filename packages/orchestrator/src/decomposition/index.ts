/**
 * Decomposition policy: how much swarm splits work.
 *
 * Swarm splits at two levels. The planner turns a goal into tasks; then a
 * task may be split into sub-tasks (one level deep), either before it runs
 * (proactive: complex tasks, plus a speculative standby sub-plan for moderate
 * ones) or when it fails (reactive: a timeout, or an escalation watcher
 * firing). The project's `decomposition` config, a goal's `split` (from its
 * swarm_split label) and `autonomy.escalation.decompose_on_failure` together
 * decide what is allowed. effectiveDecomposition() is the one place that
 * resolves them; everything else reads its result.
 */

import type {
  AutonomyConfig,
  ComplexityBand,
  ComplexityEstimate,
  ComplexityThresholds,
  DecompositionConfig,
  Goal,
  SubDecomposeMode,
  Task,
} from "@mnmal-ai/swarm-types";
import { estimateComplexity } from "../complexity/index.js";

export const SUB_DECOMPOSE_MODES: readonly SubDecomposeMode[] = ["never", "on_failure", "auto"];
const DECOMPOSITION_KEYS = ["max_tasks", "sub_decompose"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a project's `decomposition` block. Returns one message per
 * problem (empty when valid), each naming the key.
 */
export function validateDecompositionConfig(decomposition: unknown): string[] {
  if (decomposition === undefined) return [];
  if (decomposition === null || typeof decomposition !== "object" || Array.isArray(decomposition)) {
    return [`decomposition must be an object like { "max_tasks": 3, "sub_decompose": "on_failure" } (got ${JSON.stringify(decomposition)})`];
  }
  const d = decomposition as Record<string, unknown>;
  const errors: string[] = [];

  if (d.max_tasks !== undefined && !(Number.isInteger(d.max_tasks) && (d.max_tasks as number) >= 1)) {
    errors.push(`decomposition.max_tasks must be a whole number of at least 1 (got ${JSON.stringify(d.max_tasks)})`);
  }
  if (d.sub_decompose !== undefined && !SUB_DECOMPOSE_MODES.includes(d.sub_decompose as SubDecomposeMode)) {
    errors.push(`decomposition.sub_decompose must be "never", "on_failure" or "auto" (got ${JSON.stringify(d.sub_decompose)})`);
  }
  for (const key of Object.keys(d)) {
    if (!DECOMPOSITION_KEYS.includes(key)) {
      errors.push(`decomposition.${key} is not a setting (known: ${DECOMPOSITION_KEYS.join(", ")})`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface EffectiveDecomposition {
  /** Most tasks the planner may make of the goal; undefined = no cap. */
  maxTasks: number | undefined;
  /** The sub_decompose mode in force. */
  subDecompose: SubDecomposeMode;
  /** Complex top-level tasks are split before they run. */
  proactive: boolean;
  /** Moderate top-level tasks get a standby sub-plan, started alongside them. */
  speculative: boolean;
  /** A task that times out or escalates is split. */
  reactive: boolean;
  /** Where the policy came from. */
  source: "project" | "swarm_split: true" | "swarm_split: false";
  /** Things swarm run should tell the operator (e.g. conflicting labels). */
  warnings: string[];
}

/**
 * Resolve the decomposition policy for a goal (or, with no goal, the
 * project).
 *
 * - The project's `decomposition` applies, defaulting to no cap and "auto".
 * - A goal's `split` overrides it: false is one task and "never"; true is no
 *   cap and "auto".
 * - Proactive splitting (complex tasks split first; speculative sub-plans for
 *   moderate ones) happens only under "auto".
 * - Reactive splitting (timeout / escalation) happens under "auto" or
 *   "on_failure", and only when autonomy.escalation.decompose_on_failure is on.
 * - A speculative sub-plan is only ever used by an escalation-triggered split,
 *   so it is made only when reactive splitting is allowed too.
 */
export function effectiveDecomposition(
  projectPolicy: DecompositionConfig | undefined,
  goal: Pick<Goal, "id" | "description" | "split" | "splitConflict"> | undefined,
  autonomy: Pick<AutonomyConfig, "escalation">,
): EffectiveDecomposition {
  let maxTasks = projectPolicy?.max_tasks;
  let subDecompose: SubDecomposeMode = projectPolicy?.sub_decompose ?? "auto";
  let source: EffectiveDecomposition["source"] = "project";
  const warnings: string[] = [];

  if (goal?.split === false) {
    maxTasks = 1;
    subDecompose = "never";
    source = "swarm_split: false";
  } else if (goal?.split === true) {
    maxTasks = undefined;
    subDecompose = "auto";
    source = "swarm_split: true";
  }
  if (goal?.splitConflict) {
    warnings.push(
      `Goal "${goal.description}" [${goal.id}] has both swarm_split: true and swarm_split: false; using swarm_split: false.`,
    );
  }

  const proactive = subDecompose === "auto";
  const reactive = subDecompose !== "never" && autonomy.escalation.decompose_on_failure === true;
  return {
    maxTasks,
    subDecompose,
    proactive,
    speculative: proactive && reactive,
    reactive,
    source,
    warnings,
  };
}

/**
 * The banner's Decompose row: what will actually happen, and the task cap.
 * e.g. `on failure · max 3 tasks`, `auto · no cap`, `never · max 1 task (swarm_split: false)`.
 */
export function describeDecomposition(eff: EffectiveDecomposition): string {
  let mode: string;
  if (eff.subDecompose === "never") {
    mode = "never";
  } else if (eff.subDecompose === "on_failure") {
    mode = eff.reactive ? "on failure" : "never (on_failure, but decompose_on_failure is off)";
  } else {
    mode = eff.reactive ? "auto" : "auto, not on failure (decompose_on_failure is off)";
  }
  const cap = eff.maxTasks === undefined ? "no cap" : `max ${eff.maxTasks} task${eff.maxTasks === 1 ? "" : "s"}`;
  const source = eff.source === "project" ? "" : ` (${eff.source})`;
  return `${mode} · ${cap}${source}`;
}

// ---------------------------------------------------------------------------
// Planner cap
// ---------------------------------------------------------------------------

/**
 * Enforce a task cap on a plan without dropping work. When there are more
 * than `maxTasks` tasks, every task after the (N-1)th is folded into task N:
 *
 * - task N keeps its id, title and order; its description becomes each
 *   merged task's title and description, as numbered steps in plan order;
 * - serializedFiles and createsFiles are the union of the merged tasks';
 * - dependsOn edges to a folded task point at task N instead, and edges
 *   between merged tasks are dropped;
 * - the intent is task N's, unless a folded task is "implementation", which
 *   then wins (the merged task must be able to change code).
 *
 * Returns new task objects; the input is not changed.
 */
export function foldTasksToCap(tasks: Task[], maxTasks: number): { tasks: Task[]; folded: number } {
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new Error(`Task cap must be a whole number of at least 1 (got ${maxTasks})`);
  }
  if (tasks.length <= maxTasks) return { tasks, folded: 0 };

  const kept = tasks.slice(0, maxTasks - 1);
  const merged = tasks.slice(maxTasks - 1);
  const host = merged[0];
  const folded = merged.slice(1);
  const mergedIds = new Set(merged.map((t) => t.id));

  const remap = (deps: string[] | undefined): string[] | undefined => {
    if (!deps) return undefined;
    return unique(deps.map((d) => (mergedIds.has(d) ? host.id : d)));
  };

  const keptOut = kept.map((t) =>
    t.dependsOn?.some((d) => mergedIds.has(d)) ? { ...t, dependsOn: remap(t.dependsOn) } : t,
  );

  const steps = merged.map((t, i) => {
    const heading = `Step ${i + 1} of ${merged.length}${t.title ? `: ${t.title}` : ""}`;
    return `${heading}\n${t.description}`;
  });
  const description = [`This task does ${merged.length} planned steps, in order:`, "", steps.join("\n\n")].join("\n");

  const serializedFiles = unique(merged.flatMap((t) => t.serializedFiles ?? []));
  const createsFiles = unique(merged.flatMap((t) => t.createsFiles ?? []));
  const dependsOn = unique(merged.flatMap((t) => t.dependsOn ?? []).filter((d) => !mergedIds.has(d)));
  const intent = folded.some((t) => t.intent === "implementation") ? "implementation" : host.intent;

  const hostOut: Task = {
    ...host,
    description,
    intent,
    serializedFiles: serializedFiles.length > 0 ? serializedFiles : undefined,
    createsFiles: createsFiles.length > 0 ? createsFiles : undefined,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
  };

  return { tasks: [...keptOut, hostOut], folded: folded.length };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Per-task gating (the run path)
// ---------------------------------------------------------------------------

export interface TaskSplitPlan {
  /** What to do before the task runs: split it, start a standby sub-plan, or nothing. */
  proactive: "pre_split" | "speculative" | "none";
  /** Run the escalation watcher, whose only recovery is splitting the task. */
  armEscalationWatcher: boolean;
}

/**
 * What the run path may do to one task, from its complexity band and the
 * goal's effective policy. Subtasks are never split again.
 */
export function planTaskSplit(band: ComplexityBand, isSubtask: boolean, eff: EffectiveDecomposition): TaskSplitPlan {
  let proactive: TaskSplitPlan["proactive"] = "none";
  if (!isSubtask && band === "complex" && eff.proactive) proactive = "pre_split";
  if (!isSubtask && band === "moderate" && eff.speculative) proactive = "speculative";
  return { proactive, armEscalationWatcher: band === "moderate" && eff.reactive };
}

/**
 * Score a task against the run's complexity thresholds and plan its split.
 * Both dispatch paths in swarm run call this.
 */
export function classifyTaskForDispatch(
  task: Pick<Task, "description" | "parentTaskId">,
  thresholds: ComplexityThresholds,
  eff: EffectiveDecomposition,
): { complexity: ComplexityEstimate; split: TaskSplitPlan } {
  const complexity = estimateComplexity(task.description, thresholds);
  return { complexity, split: planTaskSplit(complexity.band, Boolean(task.parentTaskId), eff) };
}
