/**
 * Ship-readiness follow-up task builder.
 *
 * When the presence-triggered ship-readiness gate fails, the orchestrator must
 * NOT mark the goal complete. Instead it dispatches a remediation task that
 * carries the failure evidence and re-runs after the fix lands. This module
 * builds that task, mirroring acceptance-verifier.createVerificationTask: the
 * follow-up `dependsOn` the already-completed tasks so the orchestrator DAG
 * re-verifies once the remediation merges — reusing the existing edge type, not
 * a new one.
 */

import type { Task, Goal } from "@mnmal-ai/swarm-types";
import type {
  FailedEndpoint,
  ShipReadinessGateResult,
} from "./types.js";

/** Cap on raw stderr bytes embedded in the follow-up task body. */
const STDERR_TRUNCATION_LIMIT = 2048;

/**
 * Truncate captured stderr before it's embedded in a task description and
 * persisted to the Substrate store. Deploy errors routinely contain credentials
 * (AWS STS tokens, API keys echoed by auth-failure bodies, signed URLs in
 * upload retry chatter); a length cap limits the blast radius without
 * losing triage value — the first ~2 KB almost always carries the actual
 * failure signal.
 */
function truncateStderr(raw: string): string {
  if (raw.length <= STDERR_TRUNCATION_LIMIT) return raw;
  const dropped = raw.length - STDERR_TRUNCATION_LIMIT;
  return raw.slice(0, STDERR_TRUNCATION_LIMIT) + `\n…[truncated ${dropped} bytes]`;
}

/**
 * Build the remediation task description from the gate result. The two failure
 * modes are kept distinct so the reviewer can act on each: a deploy-step failure
 * means the deploy command itself broke (the smoke endpoints never ran), while a
 * smoke failure means the deploy succeeded but endpoints returned the wrong
 * shape — a real bug that must not be masked as an environment failure.
 */
function buildFollowUpDescription(
  goal: Goal,
  result: ShipReadinessGateResult,
): string {
  if (result.outcome === "deploy-failed") {
    return `Ship-readiness gate FAILED at the deploy step for goal "${goal.description}".

The deploy command exited ${result.deployExitCode}; smoke endpoints were never reached. This is a deploy-step failure, not a smoke-test failure — fix the deploy before reasoning about endpoint behavior.

Deploy stderr:
${truncateStderr(result.deployStderr)}

Diagnose and fix the deploy failure, then commit (feat:). Once this task completes, the ship-readiness gate re-runs against the same endpoints.`;
  }

  if (result.outcome === "smoke-failed") {
    const endpointEvidence = result.failedEndpoints
      .map((e: FailedEndpoint) => {
        const actual = e.actualStatus === null ? "no response" : e.actualStatus;
        return `- ${e.url}: expected ${e.expectedStatus}, got ${actual} — ${e.reason}`;
      })
      .join("\n");

    return `Ship-readiness gate FAILED at the smoke-test step for goal "${goal.description}".

The deploy command succeeded but ${result.failedEndpoints.length} smoke endpoint(s) did not pass. This is a smoke-test failure, not a deploy failure — the deployment is live but behaving incorrectly. Treat each failing endpoint as a real bug; do not dismiss it as an environment issue.

Failing endpoints:
${endpointEvidence}

Diagnose and fix each failing endpoint, then commit (feat:). Once this task completes, the ship-readiness gate re-runs against the same endpoints.`;
  }

  // Defensive: a passed result should never reach the follow-up builder.
  return `Ship-readiness gate reported no failure for goal "${goal.description}", yet a follow-up task was requested. Investigate the gate wiring.`;
}

/**
 * Build a remediation task for a failed ship-readiness gate.
 *
 * The returned task `dependsOn` every completed task for the goal, so the
 * orchestrator DAG schedules it after the original work and re-verifies once the
 * fix lands. This reuses the existing `Task.dependsOn` edge the DAG already
 * understands — no new edge type is introduced.
 */
export function buildShipReadinessFollowUpTask(
  goal: Goal,
  completedTaskIds: string[],
  result: ShipReadinessGateResult,
): Task {
  return {
    id: `${goal.id}-ship-readiness-followup`,
    goal_id: goal.id,
    title: `Ship-readiness follow-up: ${goal.description}`,
    description: buildFollowUpDescription(goal, result),
    intent: "implementation",
    status: "pending",
    order: 9999,
    dependsOn: completedTaskIds,
    isolated: false,
  };
}
