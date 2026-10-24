/**
 * Every model session a run makes counts toward its tokens exactly once.
 *
 * A session inside a task (each worker attempt, the review, the arbiter) adds
 * to that task, and the task's result carries the sum. A session outside any
 * task (planning a goal, revising the plan, splitting a task) is charged
 * straight to the run. A task that fails, or that the run gives up waiting
 * for, still has its sessions charged to the run.
 */

import { describe, it, expect } from "vitest";
import { SessionLedger, type Spent } from "../src/cli/session-ledger.js";

const WORKER_1: Spent = { input: 40_000, output: 1_000, cacheRead: 36_000, cacheWrite: 2_000 };
const REVIEW: Spent = { input: 20_000, output: 500, cacheRead: 18_000, cacheWrite: 1_000 };
const WORKER_2: Spent = { input: 50_000, output: 1_500, cacheRead: 46_000, cacheWrite: 2_500 };
const ARBITER: Spent = { input: 10_000, output: 300, cacheRead: 9_000, cacheWrite: 500 };
const PLAN: Spent = { input: 900_000, output: 4_000 };

function ledgerWithSink() {
  const charged: Spent[] = [];
  const ledger = new SessionLedger();
  ledger.setRunSink((t) => charged.push(t));
  return { ledger, charged };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("SessionLedger: a task's sessions", () => {
  it("gives a task's result every session it made: each worker attempt, the review and the arbiter", async () => {
    const { ledger, charged } = ledgerWithSink();

    const result = await ledger.startTask(async () => {
      ledger.charge(WORKER_1);
      ledger.charge(REVIEW);
      ledger.charge(WORKER_2);
      ledger.charge(ARBITER);
      // What the worker returns: its latest attempt only.
      return { output: "done", tokensUsed: WORKER_2 };
    }).result;

    expect(result.output).toBe("done");
    expect(result.tokensUsed).toEqual({ input: 120_000, output: 3_300, cacheRead: 109_000, cacheWrite: 6_000 });
    // Counted once: through the result, not also straight to the run.
    expect(charged).toEqual([]);
  });

  it("keeps concurrent tasks' sessions apart", async () => {
    const { ledger } = ledgerWithSink();
    const tick = () => new Promise((r) => setTimeout(r, 1));

    const [a, b] = await Promise.all([
      ledger.startTask(async () => { ledger.charge(WORKER_1); await tick(); ledger.charge(REVIEW); return { tokensUsed: WORKER_1 }; }).result,
      ledger.startTask(async () => { await tick(); ledger.charge(WORKER_2); await tick(); return { tokensUsed: WORKER_2 }; }).result,
    ]);

    expect(a.tokensUsed.input).toBe(WORKER_1.input + REVIEW.input);
    expect(b.tokensUsed.input).toBe(WORKER_2.input);
  });

  it("leaves the cache split out when no session reported one", async () => {
    const { ledger } = ledgerWithSink();
    const result = await ledger.startTask(async () => {
      ledger.charge({ input: 10, output: 2 });
      return { tokensUsed: { input: 10, output: 2 } };
    }).result;

    expect(result.tokensUsed).toEqual({ input: 10, output: 2 });
  });

  it("charges a failed task's sessions to the run", async () => {
    const { ledger, charged } = ledgerWithSink();

    await expect(ledger.startTask(async () => {
      ledger.charge(WORKER_1);
      throw new Error("worker crashed");
    }).result).rejects.toThrow("worker crashed");

    expect(charged).toEqual([WORKER_1]);
  });

  it("charges an abandoned task's sessions to the run, including those that finish after it was abandoned", async () => {
    const { ledger, charged } = ledgerWithSink();
    const gate = deferred();

    const run = ledger.startTask(async () => {
      ledger.charge(WORKER_1);
      await gate.promise;
      ledger.charge(REVIEW);
      return { tokensUsed: WORKER_1 };
    });
    await Promise.resolve();
    run.abandon();
    expect(charged).toEqual([WORKER_1]);

    gate.resolve();
    await run.result;
    expect(charged).toEqual([WORKER_1, REVIEW]);
  });

  it("keeps a result's own count when its sessions never reached the ledger", async () => {
    const { ledger } = ledgerWithSink();
    // A backend not wrapped with withModelReporting reports nothing here.
    const result = await ledger.startTask(async () => ({ tokensUsed: WORKER_2 })).result;

    expect(result.tokensUsed).toEqual(WORKER_2);
  });

  it("charges a session that finishes after its task succeeded to the run", async () => {
    const { ledger, charged } = ledgerWithSink();
    const gate = deferred();
    let late: Promise<void> | undefined;

    await ledger.startTask(async () => {
      ledger.charge(WORKER_1);
      // Started inside the task, finishing after the task has returned.
      late = gate.promise.then(() => ledger.charge(REVIEW));
      return { tokensUsed: WORKER_1 };
    }).result;
    gate.resolve();
    await late;

    expect(charged).toEqual([REVIEW]);
  });

  it("counts a failed task's sessions in the run's overhead", async () => {
    const { ledger } = ledgerWithSink();
    await ledger.startTask(async () => { ledger.charge(WORKER_1); throw new Error("x"); }).result.catch(() => {});

    expect(ledger.runOverhead()).toBe(WORKER_1.input + WORKER_1.output);
  });

  it("does nothing when a task that already finished is abandoned", async () => {
    const { ledger, charged } = ledgerWithSink();
    const run = ledger.startTask(async () => { ledger.charge(WORKER_1); return { tokensUsed: WORKER_1 }; });
    await run.result;

    run.abandon();

    expect(charged).toEqual([]);
  });
});

describe("SessionLedger: sessions outside any task", () => {
  it("charges a session outside any task straight to the run", () => {
    const { ledger, charged } = ledgerWithSink();

    ledger.charge(PLAN);

    expect(charged).toEqual([PLAN]);
    expect(ledger.runOverhead()).toBe(904_000);
  });

  it("charges work started beside a task, not inside it, to the run", async () => {
    const { ledger, charged } = ledgerWithSink();
    const gate = deferred();

    const task = ledger.startTask(async () => { await gate.promise; return { tokensUsed: WORKER_1 }; });
    // Started by the run itself while the task is running (a split prepared in parallel).
    const beside = (async () => { await Promise.resolve(); ledger.charge(PLAN); })();
    await beside;
    gate.resolve();
    const result = await task.result;

    expect(charged).toEqual([PLAN]);
    // The split is not the task's: the task keeps only its own count.
    expect(result.tokensUsed).toEqual(WORKER_1);
  });

  it("never fails the session it is counting when the run's sink throws", () => {
    const ledger = new SessionLedger();
    ledger.setRunSink(() => { throw new Error("dashboard down"); });

    expect(() => ledger.charge(PLAN)).not.toThrow();
    expect(ledger.runOverhead()).toBe(904_000);
  });

  it("holds sessions reported before the run's sink is set, and charges them once it is", () => {
    const ledger = new SessionLedger();
    ledger.charge(PLAN);

    const charged: Spent[] = [];
    ledger.setRunSink((t) => charged.push(t));

    expect(charged).toEqual([PLAN]);
  });

  it("measures a goal's overhead from a mark", () => {
    const { ledger } = ledgerWithSink();
    ledger.charge({ input: 100, output: 10 });
    const mark = ledger.runOverhead();

    ledger.charge(PLAN);

    expect(ledger.runOverhead() - mark).toBe(904_000);
  });
});
