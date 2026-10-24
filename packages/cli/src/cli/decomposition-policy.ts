/**
 * swarm run's side of the decomposition policy: validating the project's
 * `decomposition` block at startup, asking the planner to keep to the task
 * cap, and enforcing the cap on what the planner returns. The policy itself
 * (effectiveDecomposition and friends) lives in @mnmal-ai/swarm-orchestrator.
 */

import { effectiveDecomposition, foldTasksToCap, validateDecompositionConfig } from "@mnmal-ai/swarm-orchestrator";
import type { AutonomyConfig, DecompositionConfig, Goal, ProjectConfig, Task } from "@mnmal-ai/swarm-types";

/**
 * Fail fast on a malformed `decomposition` block, before any work starts,
 * with every problem and the config file named.
 */
export function assertValidDecompositionConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateDecompositionConfig(projectConfig.decomposition);
  if (errors.length === 0) return;
  throw new Error(`Invalid decomposition in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

/**
 * Warnings swarm run prints before it starts, one per goal whose ticket
 * carried both swarm_split labels (the goal runs as swarm_split: false).
 */
export function goalDecompositionWarnings(
  goals: Goal[],
  projectPolicy: DecompositionConfig | undefined,
  autonomy: Pick<AutonomyConfig, "escalation">,
): string[] {
  return goals.flatMap((g) => effectiveDecomposition(projectPolicy, g, autonomy).warnings);
}

/** The planner prompt's line about the task cap; undefined when there is none. */
export function plannerTaskCapInstruction(maxTasks: number | undefined): string | undefined {
  if (maxTasks === undefined) return undefined;
  if (maxTasks === 1) return "Plan exactly one task that does the whole goal.";
  return `Plan at most ${maxTasks} tasks. Combine small steps into the task they belong to rather than listing them separately.`;
}

/**
 * Enforce the task cap on a plan (tasks plus the files each task says it
 * creates), folding the excess into task N — see foldTasksToCap. Returns the
 * line to print when anything was folded, else null.
 */
export function applyPlannerCap(
  tasks: Task[],
  createsMap: Map<string, string[]>,
  maxTasks: number | undefined,
): { tasks: Task[]; createsMap: Map<string, string[]>; message: string | null } {
  if (maxTasks === undefined || tasks.length <= maxTasks) return { tasks, createsMap, message: null };

  const withCreates = tasks.map((t) => {
    const creates = createsMap.get(t.id);
    return creates && creates.length > 0 ? { ...t, createsFiles: creates } : t;
  });
  const { tasks: folded, folded: count } = foldTasksToCap(withCreates, maxTasks);

  // Creates stay in the map, as decomposeGoal returns them; the dispatch path
  // puts them back on the task when it builds the DAG.
  const cappedMap = new Map<string, string[]>();
  const capped = folded.map(({ createsFiles, ...t }) => {
    if (createsFiles && createsFiles.length > 0) cappedMap.set(t.id, createsFiles);
    return t as Task;
  });

  const message = `Folded ${count} of ${tasks.length} planned tasks into task ${maxTasks} (max ${maxTasks} task${maxTasks === 1 ? "" : "s"})`;
  return { tasks: capped, createsMap: cappedMap, message };
}
