// ---------------------------------------------------------------------------
// Shared label constants for GitHub task backends
// ---------------------------------------------------------------------------

export const GOAL_LABEL = "swarm:goal";
export const TASK_LABEL = "swarm:task";
export const ESCALATED_LABEL = "swarm:escalated";
export const STATUS_IN_PROGRESS = "status:in-progress";
export const STATUS_COMPLETED = "status:completed";
export const STATUS_FAILED = "status:failed";
export const STATUS_COLORS: Record<string, string> = {
  [STATUS_IN_PROGRESS]: "0E8A16",
  [STATUS_COMPLETED]: "1D76DB",
  [STATUS_FAILED]: "D93F0B",
};

// ---------------------------------------------------------------------------
// Per-goal decomposition override: `swarm_split: true` / `swarm_split: false`
// ---------------------------------------------------------------------------

/** A swarm_split label: case-insensitive, optional whitespace around the colon. */
const SPLIT_LABEL = /^\s*swarm_split\s*:\s*(true|false)\s*$/i;

/**
 * Read a ticket's swarm_split labels (Trello card or GitHub issue).
 * `swarm_split: false`: one task, never split. `swarm_split: true`: no task
 * cap, sub-decompose "auto". Neither: undefined (the project's policy). Both:
 * false, with `conflict` set so swarm run can warn.
 */
export function splitFromLabels(labels: readonly string[]): { split: boolean | undefined; conflict: boolean } {
  let sawTrue = false;
  let sawFalse = false;
  for (const label of labels) {
    const value = SPLIT_LABEL.exec(label)?.[1]?.toLowerCase();
    if (value === "true") sawTrue = true;
    if (value === "false") sawFalse = true;
  }
  return { split: sawFalse ? false : sawTrue ? true : undefined, conflict: sawTrue && sawFalse };
}

/** Goal fields for a ticket's swarm_split labels; empty when it has none. */
export function splitGoalFields(labels: readonly string[]): { split?: boolean; splitConflict?: true } {
  const { split, conflict } = splitFromLabels(labels);
  return {
    ...(split !== undefined ? { split } : {}),
    ...(conflict ? { splitConflict: true as const } : {}),
  };
}
