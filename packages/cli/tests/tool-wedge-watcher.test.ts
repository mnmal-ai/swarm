import type { ProgressEvent } from "@mnmal-ai/swarm-types";
import { describe, expect, it } from "vitest";
import {
  ToolWedgeForceRejectError,
  ToolWedgeWatcher,
} from "../src/cli/tool-wedge-watcher.js";

// Manual scheduler so force-rejection timers can be flushed
// synchronously in tests without waiting on real wall-clock.
function makeManualScheduler(): {
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  type Pending = { fn: () => void; due: number; cancelled: boolean };
  let now = 0;
  const pending = new Set<Pending>();
  return {
    setTimeoutFn: (fn, ms) => {
      const p: Pending = { fn, due: now + ms, cancelled: false };
      pending.add(p);
      return p;
    },
    clearTimeoutFn: (handle) => {
      const p = handle as Pending;
      p.cancelled = true;
      pending.delete(p);
    },
    advance: (ms) => {
      now += ms;
      const due: Pending[] = [];
      for (const p of pending) if (!p.cancelled && p.due <= now) due.push(p);
      due.sort((a, b) => a.due - b.due);
      for (const p of due) {
        pending.delete(p);
        p.fn();
      }
    },
    pendingCount: () => pending.size,
  };
}

// Time is driven by a manual clock so the watchdog logic can be
// exercised deterministically. Production code uses a setInterval —
// these tests call `tick()` directly to skip the timer entirely.
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (next: number) => {
      t = next;
    },
  };
}

function toolCall(meta: Record<string, unknown> = {}): ProgressEvent {
  return { type: "tool_call", detail: "Calling: Bash", timestamp: 0, meta };
}

function toolSummary(): ProgressEvent {
  return { type: "tool_summary", detail: "done", timestamp: 0 };
}

function modelResponse(): ProgressEvent {
  return { type: "model_response", detail: "thinking…", timestamp: 0 };
}

describe("ToolWedgeWatcher", () => {
  it("does not fire when no tool calls have started", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 100, now: clock.now },
      () => {
        fired = true;
      },
    );
    clock.advance(10_000);
    w.tick();
    expect(fired).toBe(false);
    expect(w.hasFired()).toBe(false);
  });

  it("does not fire when a tool starts and ends within the timeout", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      () => {
        fired = true;
      },
    );
    w.onProgress(toolCall());
    clock.advance(500);
    w.tick();
    expect(fired).toBe(false);
    w.onProgress(toolSummary());
    clock.advance(10_000);
    w.tick();
    expect(fired).toBe(false);
  });

  it("fires when a single tool call exceeds the timeout (the verify:vercel wedge)", () => {
    const clock = makeClock();
    const wedges: Array<{ activeCount: number; elapsedMs: number }> = [];
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      (info) => {
        wedges.push(info);
      },
    );
    w.onProgress(toolCall());
    clock.advance(1_001);
    w.tick();
    expect(wedges).toHaveLength(1);
    expect(wedges[0]?.activeCount).toBe(1);
    expect(wedges[0]?.elapsedMs).toBeGreaterThanOrEqual(1_001);
    expect(w.hasFired()).toBe(true);
  });

  it("fires exactly once even if tick() is called repeatedly after the timeout", () => {
    const clock = makeClock();
    const wedges: unknown[] = [];
    const w = new ToolWedgeWatcher(
      { timeoutMs: 100, now: clock.now },
      (info) => {
        wedges.push(info);
      },
    );
    w.onProgress(toolCall());
    clock.advance(1_000);
    w.tick();
    w.tick();
    w.tick();
    expect(wedges).toHaveLength(1);
  });

  it("treats meta.count > 1 as multiple concurrent tools — needs N summaries to clear", () => {
    const clock = makeClock();
    let firedAt: number | null = null;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      ({ elapsedMs }) => {
        firedAt = elapsedMs;
      },
    );
    // tool_call with count=3 — three tools start concurrently.
    w.onProgress(toolCall({ count: 3 }));
    expect(w.getActiveCount()).toBe(3);
    // Two complete; one still in flight.
    w.onProgress(toolSummary());
    w.onProgress(toolSummary());
    expect(w.getActiveCount()).toBe(1);
    clock.advance(1_001);
    w.tick();
    // The remaining tool wedged the session.
    expect(firedAt).not.toBeNull();
    expect(w.hasFired()).toBe(true);
  });

  it("starts a fresh session timer after activeCount returns to 0 between tools", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    // First tool: 800ms (under timeout)
    w.onProgress(toolCall());
    clock.advance(800);
    w.onProgress(toolSummary());
    expect(w.getActiveCount()).toBe(0);
    expect(w.getSessionStart()).toBe(0);

    // Gap with no tools — clock keeps advancing but no session is active
    clock.advance(5_000);
    w.tick();
    expect(fired).toBe(false);

    // Second tool — gets its OWN 1_000ms budget, not "remaining time
    // since the first tool started." Without the session-reset, this
    // would fire immediately.
    w.onProgress(toolCall());
    clock.advance(800);
    w.tick();
    expect(fired).toBe(false);

    // Push the second tool past its budget.
    clock.advance(300);
    w.tick();
    expect(fired).toBe(true);
  });

  it("ignores non-tool events (model_response, status_change, etc.)", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      () => {
        fired = true;
      },
    );
    w.onProgress(modelResponse());
    w.onProgress(modelResponse());
    expect(w.getActiveCount()).toBe(0);
    clock.advance(10_000);
    w.tick();
    expect(fired).toBe(false);
  });

  it("treats invalid meta.count as 1 (defensive — Agent SDK schema drift)", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      () => {
        fired = true;
      },
    );
    w.onProgress(toolCall({ count: "three" })); // wrong type
    expect(w.getActiveCount()).toBe(1);
    w.onProgress(toolCall({ count: -5 })); // negative
    expect(w.getActiveCount()).toBe(2);
    w.onProgress(toolCall({ count: 0 })); // zero
    expect(w.getActiveCount()).toBe(3);
    w.onProgress(toolCall()); // missing
    expect(w.getActiveCount()).toBe(4);
    clock.advance(1_001);
    w.tick();
    expect(fired).toBe(true);
  });

  it("does not crash if onWedge throws (must not propagate out of tick)", () => {
    const clock = makeClock();
    const w = new ToolWedgeWatcher(
      { timeoutMs: 100, now: clock.now },
      () => {
        throw new Error("synthetic onWedge failure");
      },
    );
    w.onProgress(toolCall());
    clock.advance(200);
    expect(() => w.tick()).not.toThrow();
    expect(w.hasFired()).toBe(true);
  });

  it("stop() clears the timer and prevents subsequent ticks from firing", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 100, now: clock.now },
      () => {
        fired = true;
      },
    );
    w.onProgress(toolCall());
    w.stop();
    clock.advance(10_000);
    // Even if a tick somehow ran post-stop, fired should still be false
    // because hasFired hasn't been set. (start() is the only thing that
    // schedules ticks; stop() clears it. But we test the explicit path
    // for safety.)
    expect(fired).toBe(false);
  });

  it("start() is idempotent (multiple calls do not stack timers)", () => {
    const clock = makeClock();
    const w = new ToolWedgeWatcher({ timeoutMs: 60_000, now: clock.now }, () => {});
    w.start();
    w.start();
    w.start();
    // No way to externally count timers, but stop() should clean up
    // without throwing.
    expect(() => w.stop()).not.toThrow();
  });

  it("after firing once, further onProgress events are no-ops (active count frozen)", () => {
    const clock = makeClock();
    let wedgeCount = 0;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 100, now: clock.now },
      () => {
        wedgeCount++;
      },
    );
    w.onProgress(toolCall());
    clock.advance(200);
    w.tick();
    expect(wedgeCount).toBe(1);
    const frozenCount = w.getActiveCount();
    // Subsequent events shouldn't change state
    w.onProgress(toolSummary());
    w.onProgress(toolCall({ count: 5 }));
    expect(w.getActiveCount()).toBe(frozenCount);
    clock.advance(10_000);
    w.tick();
    expect(wedgeCount).toBe(1); // Still only fired once
  });

  it("real-timer smoke: setInterval fires at least once within 1 second when start() is called", async () => {
    // Sanity check that the production setInterval path actually runs.
    // Uses a real timer with timeoutMs=10 to force a fast wedge.
    const wedges: unknown[] = [];
    const w = new ToolWedgeWatcher(
      { timeoutMs: 10, pollIntervalMs: 50 },
      (info) => {
        wedges.push(info);
      },
    );
    w.onProgress(toolCall());
    w.start();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(wedges.length).toBeGreaterThanOrEqual(1);
      expect(w.hasFired()).toBe(true);
    } finally {
      w.stop();
    }
  });
});

describe("ToolWedgeWatcher.forceRejectionPromise", () => {
  it("rejects with ToolWedgeForceRejectError after wedge + grace period", async () => {
    // The whole reason this exists: when the cooperative
    // `taskAbortController.abort()` doesn't reach the worker subprocess,
    // the dispatch loop must NOT hang waiting for a promise that will
    // never settle. The force-rejection promise rejects N ms after the
    // wedge fires, giving Promise.race something to win against.
    const clock = makeClock();
    const sched = makeManualScheduler();
    const w = new ToolWedgeWatcher(
      {
        timeoutMs: 1_000,
        forceRejectionGraceMs: 5_000,
        now: clock.now,
        setTimeoutFn: sched.setTimeoutFn,
        clearTimeoutFn: sched.clearTimeoutFn,
      },
      () => {},
    );
    const rejection = w.forceRejectionPromise();

    w.onProgress(toolCall());
    clock.advance(1_001);
    w.tick(); // wedge fires; force-rejection scheduled
    expect(w.hasFired()).toBe(true);
    expect(sched.pendingCount()).toBe(1);

    // Grace not yet elapsed — promise still pending. Race it against an
    // immediate sentinel so we can verify no rejection has fired.
    const earlyRace = await Promise.race([
      rejection.catch((err) => ({ status: "rejected", err })),
      new Promise<{ status: string }>((r) => queueMicrotask(() => r({ status: "still-pending" }))),
    ]);
    expect(earlyRace.status).toBe("still-pending");

    // Advance through the grace window — force-rejection should fire.
    sched.advance(5_000);
    await expect(rejection).rejects.toBeInstanceOf(ToolWedgeForceRejectError);
    await expect(rejection).rejects.toMatchObject({
      activeCount: 1,
      thresholdMs: 1_000,
      graceMs: 5_000,
    });
  });

  it("does not reject when stop() is called before wedge fires (clean task completion)", async () => {
    const clock = makeClock();
    const sched = makeManualScheduler();
    const w = new ToolWedgeWatcher(
      {
        timeoutMs: 1_000,
        forceRejectionGraceMs: 5_000,
        now: clock.now,
        setTimeoutFn: sched.setTimeoutFn,
        clearTimeoutFn: sched.clearTimeoutFn,
      },
      () => {},
    );
    const rejection = w.forceRejectionPromise();

    w.onProgress(toolCall());
    clock.advance(500); // under threshold
    w.tick();
    expect(w.hasFired()).toBe(false);

    // Task completed normally — caller calls stop(). Force-rejection
    // promise must NOT reject (it stays unresolved forever, which is
    // fine because Promise.race against the now-resolved task promise
    // already settled).
    w.stop();
    sched.advance(60_000); // way past any grace window

    const racing = await Promise.race([
      rejection.catch((err) => ({ status: "rejected", err })),
      new Promise<{ status: string }>((r) => setTimeout(() => r({ status: "still-pending" }), 30)),
    ]);
    expect(racing.status).toBe("still-pending");
    expect(sched.pendingCount()).toBe(0); // no leaked timers
  });

  it("does not reject when stop() is called AFTER wedge but BEFORE grace elapses", async () => {
    // Edge case: wedge fires, force-rejection timer is scheduled, but
    // then the task somehow completes (e.g., the cooperative abort DID
    // work, just slower than expected). stop() must cancel the pending
    // force-rejection timer so it doesn't fire against an already-
    // resolved task promise.
    const clock = makeClock();
    const sched = makeManualScheduler();
    const w = new ToolWedgeWatcher(
      {
        timeoutMs: 1_000,
        forceRejectionGraceMs: 5_000,
        now: clock.now,
        setTimeoutFn: sched.setTimeoutFn,
        clearTimeoutFn: sched.clearTimeoutFn,
      },
      () => {},
    );
    const rejection = w.forceRejectionPromise();

    w.onProgress(toolCall());
    clock.advance(1_001);
    w.tick(); // wedge fires; force-rejection scheduled
    expect(sched.pendingCount()).toBe(1);

    // Caller's task promise resolves before grace elapses; finally
    // block calls stop().
    w.stop();
    expect(sched.pendingCount()).toBe(0); // timer cancelled

    sched.advance(60_000);
    const racing = await Promise.race([
      rejection.catch((err) => ({ status: "rejected", err })),
      new Promise<{ status: string }>((r) => setTimeout(() => r({ status: "still-pending" }), 30)),
    ]);
    expect(racing.status).toBe("still-pending");
  });

  it("integrates with Promise.race as the dispatch-unblock pattern", async () => {
    // Simulates the run.ts call site:
    //   await Promise.race([swarm.runWithOversight(...), wedgeForceRejectPromise]);
    // When the worker hangs (simulated by a never-resolving promise) and
    // the wedge fires, the race must settle (with rejection) so the
    // dispatch loop unblocks instead of waiting forever.
    const clock = makeClock();
    const sched = makeManualScheduler();
    const w = new ToolWedgeWatcher(
      {
        timeoutMs: 100,
        forceRejectionGraceMs: 50,
        now: clock.now,
        setTimeoutFn: sched.setTimeoutFn,
        clearTimeoutFn: sched.clearTimeoutFn,
      },
      () => {},
    );

    const taskPromise = new Promise<string>(() => {}); // hangs forever
    const wedgePromise = w.forceRejectionPromise();

    w.onProgress(toolCall());
    clock.advance(200);
    w.tick();
    sched.advance(50);

    await expect(Promise.race([taskPromise, wedgePromise])).rejects.toBeInstanceOf(
      ToolWedgeForceRejectError,
    );
  });

  it("ToolWedgeForceRejectError carries diagnostic fields for telemetry", () => {
    const err = new ToolWedgeForceRejectError({
      activeCount: 13,
      elapsedMs: 305_000,
      thresholdMs: 300_000,
      graceMs: 10_000,
    });
    expect(err.name).toBe("ToolWedgeForceRejectError");
    expect(err.activeCount).toBe(13);
    expect(err.elapsedMs).toBe(305_000);
    expect(err.thresholdMs).toBe(300_000);
    expect(err.graceMs).toBe(10_000);
    expect(err.message).toContain("13 tool(s) active");
    expect(err.message).toContain("305s");
    expect(err.message).toContain("threshold 300s");
    expect(err.message).toContain("10000ms grace");
  });
});

// ---------------------------------------------------------------------------
// Progress-window detection — the false-positive fix
//
// 4-quadrant test matrix:
//
//  activeTools | progress in window | expected verdict
//  ------------|-------------------|------------------
//  0           | (any)             | NOT a wedge (idle)
//  > 0         | yes               | NOT a wedge  ← the reported false positive
//  > 0         | no                | wedge        ← the case the detector must still catch
//  > 0         | gap > window      | wedge        ← batch drained but then stalled
//
// Q1 (idle) is already covered by the existing "does not fire when no tool
// calls have started" and "does not fire when a tool starts and ends within
// the timeout" tests above.
// ---------------------------------------------------------------------------
describe("progress-window detection — false-positive fix", () => {
  // Q2: active tools with completions arriving inside the window → NOT a wedge
  // Uses timeoutMs (current option) so the test is RED with old code:
  // old code fires when sessionElapsed > timeoutMs (310s > 300s at iteration 31);
  // new code must NOT fire because a completion happened 0ms ago.
  it("Q2 — active tools with completions through the window: NOT a wedge (the false-positive class)", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 300_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    // 54 concurrent tools dispatched (the goal-23-task-8 batch size)
    w.onProgress(toolCall({ count: 54 }));

    // Completions arrive every 10 seconds for 310 seconds (31 completions).
    // After 310s the old detector fires (sessionElapsed = 310s > threshold 300s).
    // The new detector must NOT fire because a completion happened 0ms ago.
    for (let i = 0; i < 31; i++) {
      clock.advance(10_000);
      w.onProgress(toolSummary()); // a tool completes
      w.tick();
      expect(fired).toBe(false); // progress is visible — never a wedge
    }
    // 23 tools still in flight; total session elapsed 310s — old code fires here
    expect(w.getActiveCount()).toBe(23);
    expect(fired).toBe(false);
  });

  // Q2b: model response during an active session resets the progress clock.
  // Uses timeoutMs so the test is RED with old code:
  // old code: model_response ignored, elapsedMs = 1600 > 1000 → fires.
  // new code: model_response resets clock, progressWindowSilence = 800 → no fire.
  it("Q2b — model response during active tools resets the progress clock: NOT a wedge", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 1_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    w.onProgress(toolCall()); // session starts
    clock.advance(800); // 800ms of silence
    w.tick(); // 800 < 1000 → not yet a wedge (same under old + new)

    // A model response arrives — this is progress
    w.onProgress(modelResponse()); // lastModelResponseAt updated
    clock.advance(800); // 800ms since the model response
    w.tick();
    // New detector: progressWindowSilence = 800 < 1000 → no wedge
    // Old detector: elapsedMs = 1600 > 1000 → WOULD fire
    expect(fired).toBe(false);
  });

  // Q3: active tools with no completions or model responses for the full window → wedge
  it("Q3 — active tools with zero progress for the full window: IS a wedge", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { progressWindowMs: 300_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    w.onProgress(toolCall({ count: 5 })); // 5 tools in flight, no completions follow
    clock.advance(300_001); // progress window exceeded with no completion or model response
    w.tick();
    expect(fired).toBe(true);
    expect(w.hasFired()).toBe(true);
  });

  // Q4: completions happen but the last one was more than the window ago → wedge
  it("Q4 — completions stopped and gap exceeds the progress window: IS a wedge", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { progressWindowMs: 300_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    w.onProgress(toolCall({ count: 5 }));

    // Some activity early in the session
    clock.advance(60_000);
    w.onProgress(toolSummary()); // 4 remain
    clock.advance(60_000);
    w.onProgress(toolSummary()); // 3 remain — last completion at T0+120s

    // Then silence for more than the progress window
    clock.advance(300_001); // now = T0+420s; last progress = T0+120s; silence = 300001ms
    w.tick();
    expect(fired).toBe(true);
  });

  // The false-positive report's goal-23-task-8 exact fixture:
  // 54 concurrent tools, oldest ageMs ~300000, but recentToolCalls shows
  // completions every ~10 seconds throughout the window. Uses timeoutMs so
  // the test is RED with old code (sessionElapsed reaches 300s at i=30).
  it("goal-23-task-8 fixture: 54 concurrent tools with completions every ~10s — NOT a wedge", () => {
    const clock = makeClock();
    let fired = false;
    const w = new ToolWedgeWatcher(
      { timeoutMs: 300_000, now: clock.now },
      () => {
        fired = true;
      },
    );

    // All 54 tools dispatched at once (the real pattern: a big batch)
    w.onProgress(toolCall({ count: 54 }));

    // 31 completions over 310 seconds — one every 10s.
    // At i=30 the old detector fires (sessionElapsed=310s > threshold=300s).
    for (let i = 0; i < 31; i++) {
      clock.advance(10_000);
      w.onProgress(toolSummary());
      w.tick();
      expect(fired).toBe(false); // new detector: last completion 0ms ago → no wedge
    }

    // 23 tools still in flight; 310s total elapsed; last completion was just now.
    // Old detector fired at i=30. New detector must NOT.
    expect(w.getActiveCount()).toBe(23);
    expect(fired).toBe(false);
  });

  // Verify getLastProgressAt() accessor returns the max of the two timestamps
  it("getLastProgressAt() reflects tool completions and model responses", () => {
    const clock = makeClock(1_000_000);
    const w = new ToolWedgeWatcher(
      { progressWindowMs: 300_000, now: clock.now },
      () => {},
    );

    // Before any activity: 0
    expect(w.getLastProgressAt()).toBe(0);

    // Session starts → timestamps initialized to now
    w.onProgress(toolCall());
    expect(w.getLastProgressAt()).toBe(1_000_000);

    // Tool completes → lastToolCompletionAt updates
    clock.advance(5_000);
    w.onProgress(toolSummary());
    // session ends (activeCount→0), timestamps reset to 0
    expect(w.getLastProgressAt()).toBe(0);

    // New session: tool_call → both timestamps set to now
    clock.advance(1_000);
    w.onProgress(toolCall({ count: 2 }));
    expect(w.getLastProgressAt()).toBe(1_006_000);

    // Model response → lastModelResponseAt updates
    clock.advance(500);
    w.onProgress(modelResponse());
    expect(w.getLastProgressAt()).toBe(1_006_500);

    // Another tool completes (1 still in flight)
    clock.advance(500);
    w.onProgress(toolSummary());
    expect(w.getLastProgressAt()).toBe(1_007_000);
  });
});
