/**
 * Every piece of work the run charges to the session — a task's run, or the
 * decomposition call that splits a task into subtasks — adds its tokens to
 * the orchestrator (which the session budget checks) and to the dashboard's
 * running split, through one helper, so the two always count the same work.
 */

import { describe, it, expect } from "vitest";
import { chargeSession, spendTokens } from "../src/cli/session-charge.js";

function counters() {
  const calls = { tokens: [] as number[] };
  return {
    calls,
    addTokens: (n: number) => { calls.tokens.push(n); },
  };
}

const EMPTY = { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const TASK = { tokensUsed: { input: 50_000, output: 2_000, cacheRead: 45_000, cacheWrite: 3_000 } };
const DECOMPOSITION = { tokensUsed: { input: 9_000, output: 400, cacheRead: 8_000, cacheWrite: 500 } };

describe("chargeSession", () => {
  it("charges a task and the decomposition that split it", () => {
    const c = counters();

    const charged = chargeSession(c, EMPTY, TASK, DECOMPOSITION);

    expect(c.calls.tokens).toEqual([50_000 + 2_000 + 9_000 + 400]);
    expect(charged.tokens).toEqual({ freshInput: 2_000 + 500, cacheRead: 53_000, cacheWrite: 3_500, output: 2_400 });
  });

  it("charges a split made before any run: the decomposition's tokens count", () => {
    const c = counters();

    const charged = chargeSession(c, EMPTY, DECOMPOSITION);

    expect(c.calls.tokens).toEqual([9_400]);
    expect(charged.sessionTokens).toEqual({ freshInput: 500, cacheRead: 8_000, cacheWrite: 500, output: 400 });
  });

  it("adds the work to the session's running split", () => {
    const before = { freshInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 };

    const charged = chargeSession(counters(), before, DECOMPOSITION);

    expect(charged.sessionTokens).toEqual({ freshInput: 501, cacheRead: 8_002, cacheWrite: 503, output: 404 });
    expect(before).toEqual({ freshInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
  });

  it("gives the token budget the same count the dashboard shows", () => {
    const c = counters();

    const charged = chargeSession(c, EMPTY, TASK, DECOMPOSITION);

    const shown = charged.tokens.freshInput + charged.tokens.cacheRead + charged.tokens.cacheWrite + charged.tokens.output;
    expect(c.calls.tokens[0]).toBe(shown);
  });

  it("charges nothing for a decomposition that made no call", () => {
    const c = counters();

    const charged = chargeSession(c, EMPTY, {});

    expect(c.calls.tokens).toEqual([0]);
    expect(charged.tokens).toEqual(EMPTY);
  });

  it("has no dollar side: the counters it needs are tokens only", () => {
    // A counter with only addTokens is enough.
    expect(() => chargeSession({ addTokens: () => {} }, EMPTY, TASK)).not.toThrow();
  });
});

describe("spendTokens", () => {
  it("combines the split of several pieces of work", () => {
    expect(spendTokens(TASK, DECOMPOSITION)).toEqual({ freshInput: 2_500, cacheRead: 53_000, cacheWrite: 3_500, output: 2_400 });
  });
});
