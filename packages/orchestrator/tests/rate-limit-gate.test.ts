import { describe, it, expect, vi } from "vitest";
import { RateLimitGate } from "../src/rate-limit-gate.js";

describe("RateLimitGate", () => {
  it("is not limited initially", () => {
    const gate = new RateLimitGate();
    expect(gate.isLimited()).toBe(false);
  });

  it("becomes limited after trigger", () => {
    const gate = new RateLimitGate();
    gate.trigger(Date.now() + 5000, 5000);
    expect(gate.isLimited()).toBe(true);
  });

  it("wait resolves immediately when not limited", async () => {
    const gate = new RateLimitGate();
    await gate.wait(); // should not hang
  });

  it("wait resolves after reset time", async () => {
    const gate = new RateLimitGate();
    gate.trigger(Date.now() + 100, 100);
    expect(gate.isLimited()).toBe(true);
    await gate.wait();
    expect(gate.isLimited()).toBe(false);
  });

  it("reset opens the gate immediately", async () => {
    const gate = new RateLimitGate();
    gate.trigger(Date.now() + 60000, 60000);
    expect(gate.isLimited()).toBe(true);
    gate.reset();
    expect(gate.isLimited()).toBe(false);
  });

  it("remainingMs returns correct value", () => {
    const gate = new RateLimitGate();
    gate.trigger(Date.now() + 5000, 5000);
    expect(gate.remainingMs()).toBeGreaterThan(4000);
    expect(gate.remainingMs()).toBeLessThanOrEqual(5000);
  });

  // Regression: `setTimeout(fn, N)` uses libuv's monotonic clock, while
  // `isLimited()` checks `Date.now()` (wall clock). The two can disagree by
  // a millisecond or two — long enough for `wait()` to resolve while
  // `isLimited()` still returns `true`. Under load (busy CI runner), the
  // single-shot version of this test would fail intermittently. Iterating
  // with a tight trigger window deterministically reproduces it.
  it("wait never resolves before isLimited returns false (50 iterations)", async () => {
    for (let i = 0; i < 50; i++) {
      const gate = new RateLimitGate();
      gate.trigger(Date.now() + 2, 2);
      await gate.wait();
      expect(gate.isLimited()).toBe(false);
    }
  });
});
