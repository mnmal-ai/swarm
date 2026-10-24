/**
 * AI-powered acceptance criteria verification for goals.
 *
 * NOTE: These functions are tested and ready but not yet wired into the
 * orchestrator dispatch path (run.ts). Wiring requires creating tasks via
 * TaskBackend and dispatching through the Swarm instance at goal completion.
 * This is planned as a follow-on PR to keep the current change reviewable.
 */

import type { Task, Goal } from "@mnmal-ai/swarm-types";

/** Sanitize user-supplied text before interpolating into LLM prompts. */
function sanitizeForPrompt(text: string): string {
  // Strip control characters and limit length to prevent prompt injection
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, 2000);
}

/**
 * Build the prompt for an AI verification task that checks whether
 * each acceptance criterion was met.
 */
export function buildVerificationPrompt(
  goalDescription: string,
  acceptanceCriteria: string[],
): string {
  if (acceptanceCriteria.length === 0) return "";

  const safeDescription = sanitizeForPrompt(goalDescription);
  const numberedCriteria = acceptanceCriteria
    .map((c, i) => `${i + 1}. ${sanitizeForPrompt(c)}`)
    .join("\n");

  return `Verify acceptance criteria for goal "${safeDescription}". For each criterion below, read the relevant source files and confirm it is met. Report PASS or FAIL for each with evidence. Do not modify any files.

Criteria:
${numberedCriteria}

For each criterion, respond with:
- [PASS] or [FAIL]: criterion text
- Evidence: what you found that confirms or denies it`;
}

/**
 * Create a verification task for a goal. Returns null if the goal has
 * no acceptance criteria to verify.
 */
export function createVerificationTask(
  goal: Goal,
  integrationTaskId: string,
): Task | null {
  const prompt = buildVerificationPrompt(
    goal.description,
    goal.acceptance_criteria,
  );
  if (!prompt) return null;

  return {
    id: `${goal.id}-verification`,
    goal_id: goal.id,
    title: `Verify: ${goal.description}`,
    description: prompt,
    intent: "investigation",
    status: "pending",
    order: 9999,
    dependsOn: [integrationTaskId],
    isolated: false,
  };
}

/**
 * Create an integration task for a goal. Dispatched after all implementation
 * tasks complete and before validation.
 */
export function createIntegrationTask(
  goal: Goal,
  completedTaskIds: string[],
): Task {
  return {
    id: `${goal.id}-integration`,
    goal_id: goal.id,
    title: `Integration: ${goal.description}`,
    description: `Integration: verify that all completed tasks for goal "${goal.description}" work together. Check that components are wired into the application, routes are connected, and imports resolve. Do not create new functionality — only connect what was built.`,
    intent: "implementation",
    status: "pending",
    order: 9998,
    dependsOn: completedTaskIds,
    isolated: false,
  };
}

/**
 * Parse the verification output for PASS/FAIL verdicts.
 * Returns the criteria that failed.
 */
export function parseVerificationOutput(
  output: string,
  criteriaCount: number,
): { passed: boolean; failedCriteria: string[] } {
  const failedCriteria: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const failMatch = line.match(/\[FAIL\]\s*:?\s*(.*)/i);
    if (failMatch) {
      failedCriteria.push(failMatch[1].trim());
    }
  }

  // If we didn't get enough verdicts, treat missing ones as failures
  const passCount = (output.match(/\[PASS\]/gi) ?? []).length;
  if (passCount + failedCriteria.length < criteriaCount) {
    failedCriteria.push(
      `${criteriaCount - passCount - failedCriteria.length} criterion(a) received no verdict`,
    );
  }

  return {
    passed: failedCriteria.length === 0,
    failedCriteria,
  };
}
