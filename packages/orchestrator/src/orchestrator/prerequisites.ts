/**
 * Prerequisite validation — checks that required environment variables (and
 * eventually services) are available before the orchestrator wastes budget
 * on tasks that are doomed to fail.
 *
 * Hard-blocked prerequisites are intended to cause immediate human escalation
 * by the caller (e.g., the Orchestrator).
 * Soft-blocked prerequisites (optional or mockable) are intended to result in
 * warnings, which should be emitted by the caller.
 */

import type {
  PrerequisiteCheck,
  PrerequisiteResult,
  PrerequisiteValidation,
} from "@mnmal-ai/swarm-types";

/**
 * Validate that required prerequisites are available.
 * Currently checks environment variables only.
 */
export function validatePrerequisites(checks: PrerequisiteCheck[]): PrerequisiteValidation {
  const results: PrerequisiteResult[] = [];

  for (const check of checks) {
    if (check.type === "env_var") {
      const value = process.env[check.name];
      const available = !!value && value.trim().length > 0;
      results.push({
        check,
        available,
        detail: available ? "Set" : "Missing or empty",
      });
    } else {
      // Service checks are not yet implemented — treat as unavailable so
      // callers cannot accidentally rely on a false-positive pass.
      results.push({
        check,
        available: false,
        detail: "Service checks not yet implemented",
      });
    }
  }

  const hardBlocked = results.filter(
    (r) => !r.available && r.check.required && !r.check.mockable,
  );
  const softBlocked = results.filter(
    (r) => !r.available && (!r.check.required || r.check.mockable),
  );

  return {
    passed: hardBlocked.length === 0,
    results,
    hardBlocked,
    softBlocked,
  };
}
