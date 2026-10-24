/**
 * Pure predicate for detecting "ghost-completion" goals — goals whose
 * tasks all finished with success verdicts but produced zero commits.
 *
 * Extracted as a pure function so the CLI's emission branch in run.ts
 * has direct test coverage without needing a full orchestrator run.
 * The 2026-05-30 swarm-on-swarm run had goal-3 and goal-4 ghost-complete
 * (workers did investigative/refactor work that staged no files), which
 * made the DAG resolver look permissive when it was acting honestly on
 * a `completed` status with no work behind it.
 */
export function isGhostCompletion(
  totalTaskCount: number,
  goalCompletedCount: number,
  commitsForGoal: number,
): boolean {
  // A goal has to have had tasks to "ghost-complete" — an empty plan
  // isn't ghost completion, it's an empty goal.
  if (totalTaskCount <= 0) return false;
  // Only when every task ran to success do we consider this a ghost.
  // If any task failed/was skipped, the partial-completion path handles
  // signalling separately.
  if (goalCompletedCount !== totalTaskCount) return false;
  // The defining symptom: nothing landed on a branch.
  return commitsForGoal === 0;
}
