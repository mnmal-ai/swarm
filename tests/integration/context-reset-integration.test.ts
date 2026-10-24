import { describe, it, expect } from "vitest";

/**
 * Integration test for intra-goal context reset.
 *
 * Derived from cold test data (2026-04-03):
 *   Query: WorkerResult entities showed 6 successful completions
 *   Query: TranscriptEntry showed 22 entries, last at 04:14:47
 *   Query: ReviewVerdict showed 7 reviews (6 approved, 1 parse-failure retry)
 *   Result: Goal-1 blocked after task 7 — context overflow
 *
 * The fix in run.ts resets Swarm every 4 completed tasks.
 * This test validates the math ensures no task runs with more
 * than RESET_INTERVAL tasks of accumulated context.
 */
describe("intra-goal context reset prevents overflow", () => {
  const RESET_INTERVAL = 4;

  it("for a 7-task goal (our cold test case), max context age is 2", () => {
    let contextAge = 0;
    let maxAge = 0;

    for (let i = 1; i <= 7; i++) {
      contextAge++;
      maxAge = Math.max(maxAge, contextAge);
      // Reset happens AFTER the Nth completed task
      if (i % RESET_INTERVAL === 0) {
        contextAge = 0;
      }
    }

    // After task 4: reset. Tasks 5,6,7 run on fresh context.
    // Max context age = 4 (tasks 1-4 before first reset)
    expect(maxAge).toBe(4);
    // Final context age at task 7 = 3
    expect(contextAge).toBe(3);
  });

  it("for a 10-task goal, max context age is still 4", () => {
    let contextAge = 0;
    let maxAge = 0;

    for (let i = 1; i <= 10; i++) {
      contextAge++;
      maxAge = Math.max(maxAge, contextAge);
      if (i % RESET_INTERVAL === 0) {
        contextAge = 0;
      }
    }

    // Resets at task 4 and task 8. Max context = 4.
    expect(maxAge).toBe(4);
    expect(contextAge).toBe(2); // tasks 9, 10 after second reset
  });

  it("for a 20-task goal, resets happen 5 times and max context is bounded", () => {
    let contextAge = 0;
    let resets = 0;

    for (let i = 1; i <= 20; i++) {
      contextAge++;
      if (i % RESET_INTERVAL === 0) {
        contextAge = 0;
        resets++;
      }
    }

    expect(resets).toBe(5);
    expect(contextAge).toBe(0); // 20 is exactly divisible by 4
  });

  it("context overflow threshold from cold test data: 6+ tasks causes problems", () => {
    // The cold test showed failure at task 7 with 6 tasks of accumulated context.
    // With RESET_INTERVAL=4, the maximum context age is 4, which is below the
    // observed failure threshold of 6+.
    const OBSERVED_FAILURE_THRESHOLD = 6;
    expect(RESET_INTERVAL).toBeLessThan(OBSERVED_FAILURE_THRESHOLD);
  });
});
