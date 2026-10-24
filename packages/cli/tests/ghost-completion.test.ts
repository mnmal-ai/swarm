/**
 * Tests for the ghost-completion predicate that drives the CLI's
 * `goal_completed_no_commits` warning + event emission. The 2026-05-30
 * swarm-on-swarm run had goal-3 and goal-4 hit this case silently
 * because the predicate didn't exist yet.
 */

import { describe, it, expect } from "vitest";
import { isGhostCompletion } from "../src/cli/ghost-completion.js";

describe("isGhostCompletion", () => {
  it("returns true when every task succeeded but produced 0 commits — the symptom", () => {
    // The exact case the 2026-05-30 run silently fell into.
    expect(isGhostCompletion(3, 3, 0)).toBe(true);
  });

  it("returns false when at least one commit landed (real work happened)", () => {
    expect(isGhostCompletion(3, 3, 1)).toBe(false);
  });

  it("returns false on partial completion (the partial-goal warning handles it)", () => {
    // 2 of 3 tasks completed; the existing `Goal partially completed` log
    // already covers this case, so we don't double-warn.
    expect(isGhostCompletion(3, 2, 0)).toBe(false);
  });

  it("returns false when there are no tasks (empty goal isn't ghost completion)", () => {
    // A goal with no decomposed tasks is a degenerate case — calling it a
    // ghost completion would be noise. Empty plans get other diagnostics.
    expect(isGhostCompletion(0, 0, 0)).toBe(false);
  });

  it("returns false when goalCompletedCount exceeds totalTaskCount (defensive)", () => {
    // Strict equality so a future bug that double-counts completions
    // doesn't accidentally trigger the ghost signal.
    expect(isGhostCompletion(2, 3, 0)).toBe(false);
  });
});
