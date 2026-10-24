// Counting every model session a run makes, once.
//
// Each backend session (worker, reviewer, arbiter, or one that plans a goal,
// revises the plan or splits a task) reports its tokens through
// withModelReporting, which charges them here.
//
// - A session inside a task's scope adds to that task. The task's result then
//   carries every session it made — each worker attempt, the review, the
//   arbiter — rather than only the latest worker attempt, and the run charges
//   the result to the session and goal totals as before.
// - A session outside any task is charged straight to the run through the
//   sink run.ts sets, and counts toward the goal it ran in (runOverhead).
// - A task that fails, or that the run stops waiting for (abandon), has what
//   its sessions spent charged to the run, and so does any session of it that
//   finishes later.
//
// The scope follows async context, so concurrent tasks stay apart, and work the
// run starts beside a task (a split prepared in parallel) is not part of it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerTaskOutput } from "@mnmal-ai/swarm-types";

/** One session's tokens; `input` counts all input, cache reads and writes included. */
export type Spent = WorkerTaskOutput["tokensUsed"];

const total = (t: Spent): number => t.input + t.output;

interface TaskScope {
  spent: Spent;
  /** Set when the task settles or is abandoned; later sessions go to the run. */
  closed: boolean;
}

/** A task run inside a scope, and a way to stop counting it as the task's own. */
export interface ScopedTask<T> {
  /** The task's result, its `tokensUsed` replaced by every session the task made. */
  result: Promise<T>;
  /** The run gave up waiting: charge what the task spent so far, and anything it spends later, to the run. */
  abandon(): void;
}

function add(a: Spent, b: Spent): Spent {
  const sum: Spent = { input: a.input + b.input, output: a.output + b.output };
  if (a.cacheRead !== undefined || b.cacheRead !== undefined) sum.cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  if (a.cacheWrite !== undefined || b.cacheWrite !== undefined) sum.cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  return sum;
}

export class SessionLedger {
  private readonly scopes = new AsyncLocalStorage<TaskScope>();
  private sink: ((spent: Spent) => void) | undefined;
  private readonly pending: Spent[] = [];
  private overhead = 0;

  /** Where sessions outside any task are charged. Sessions reported before it is set are charged now. */
  setRunSink(sink: (spent: Spent) => void): void {
    this.sink = sink;
    for (const spent of this.pending.splice(0)) {
      this.overhead -= total(spent); // chargeRun counts it again
      this.chargeRun(spent);
    }
  }

  /** A backend session finished: add it to the task it ran in, or charge it to the run. */
  charge(spent: Spent): void {
    const scope = this.scopes.getStore();
    if (scope && !scope.closed) scope.spent = add(scope.spent, spent);
    else this.chargeRun(spent);
  }

  /** Tokens (input + output) charged straight to the run so far; take a mark at a goal's start to get its overhead. */
  runOverhead(): number {
    return this.overhead;
  }

  /** Run one task in its own scope. */
  startTask<T extends { tokensUsed: Spent }>(run: () => Promise<T>): ScopedTask<T> {
    const scope: TaskScope = { spent: { input: 0, output: 0 }, closed: false };
    const close = (): Spent | null => {
      if (scope.closed) return null;
      scope.closed = true;
      return scope.spent;
    };
    const result = this.scopes.run(scope, run).then(
      (value) => {
        const spent = close();
        // A session that never reached the ledger (a backend not wrapped with
        // withModelReporting) still shows in the result's own count: keep the
        // larger of the two rather than report less than the task said.
        return spent && total(spent) >= total(value.tokensUsed) ? { ...value, tokensUsed: spent } : value;
      },
      (err: unknown) => {
        const spent = close();
        if (spent) this.chargeRun(spent);
        throw err;
      },
    );
    return {
      result,
      abandon: () => {
        const spent = close();
        if (spent) this.chargeRun(spent);
      },
    };
  }

  private chargeRun(spent: Spent): void {
    if (spent.input === 0 && spent.output === 0) return;
    this.overhead += total(spent);
    if (!this.sink) {
      this.pending.push(spent);
      return;
    }
    // Charging runs inside the backend call that reported the session; a
    // failure to count it must not turn into a failed session.
    try {
      this.sink(spent);
    } catch (err) {
      console.warn(`[swarm] Could not charge a session's tokens to the run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
