/**
 * The session budget guard is tokens only: it warns once at 80% of the
 * session token limit and aborts once the limit is exceeded.
 */

import { describe, it, expect } from "vitest";
import { evaluateSessionBudget } from "../src/cli/budget-guard.js";

const guard = (limit: number) => ({
  shouldWarnTokens: (t: number) => t >= limit * 0.8,
  isSessionTokenExceeded: (t: number) => t > limit,
});

describe("evaluateSessionBudget", () => {
  it("does nothing below 80% of the limit", () => {
    expect(evaluateSessionBudget(guard(1000), 799, { tokenWarningIssued: false })).toEqual({ warnTokens: false, abort: false });
  });

  it("warns at 80%, once", () => {
    expect(evaluateSessionBudget(guard(1000), 800, { tokenWarningIssued: false })).toEqual({ warnTokens: true, abort: false });
    expect(evaluateSessionBudget(guard(1000), 900, { tokenWarningIssued: true })).toEqual({ warnTokens: false, abort: false });
  });

  it("aborts once the limit is exceeded", () => {
    expect(evaluateSessionBudget(guard(1000), 1001, { tokenWarningIssued: true })).toEqual({ warnTokens: false, abort: true });
  });
});
