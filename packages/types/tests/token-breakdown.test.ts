/**
 * Token breakdown helpers — the split the live dashboard shows.
 *
 * A worker result's `tokensUsed.input` counts every input token, prompt-cache
 * reads and writes included (cost and the session token budget count it that
 * way). The dashboard shows fresh input apart from cached input, because cache
 * reads are most of a Claude Code session's input and one number misleads.
 */

import { describe, it, expect } from "vitest";
import { addTokenBreakdown, emptyTokenBreakdown, formatTokens, tokenBreakdown, tokenBreakdownTotal } from "../src/util.js";

describe("tokenBreakdown", () => {
  it("takes cache reads and writes out of the input total", () => {
    expect(tokenBreakdown({ input: 1_000, output: 50, cacheRead: 900, cacheWrite: 60 })).toEqual({
      freshInput: 40,
      cacheRead: 900,
      cacheWrite: 60,
      output: 50,
    });
  });

  it("treats input as all fresh when the backend reports no cache split", () => {
    expect(tokenBreakdown({ input: 300, output: 20 })).toEqual({
      freshInput: 300,
      cacheRead: 0,
      cacheWrite: 0,
      output: 20,
    });
  });

  it("never reports negative fresh input", () => {
    expect(tokenBreakdown({ input: 10, output: 0, cacheRead: 20 }).freshInput).toBe(0);
  });
});

describe("addTokenBreakdown", () => {
  it("sums each part without changing its inputs", () => {
    const a = { freshInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 };
    const b = { freshInput: 10, cacheRead: 20, cacheWrite: 30, output: 40 };

    expect(addTokenBreakdown(a, b)).toEqual({ freshInput: 11, cacheRead: 22, cacheWrite: 33, output: 44 });
    expect(a).toEqual({ freshInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
  });

  it("starts from an all-zero breakdown", () => {
    expect(emptyTokenBreakdown()).toEqual({ freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });
});

describe("tokenBreakdownTotal", () => {
  it("equals input plus output, the count the session token budget uses", () => {
    const tokensUsed = { input: 1_000, output: 50, cacheRead: 900, cacheWrite: 60 };

    expect(tokenBreakdownTotal(tokenBreakdown(tokensUsed))).toBe(tokensUsed.input + tokensUsed.output);
  });
});

describe("formatTokens", () => {
  it("shows small counts as they are", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
  });

  it("shows thousands with k and millions with M, dropping trailing zeros", () => {
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(6_000)).toBe("6k");
    expect(formatTokens(1_140_000)).toBe("1.14M");
    expect(formatTokens(60_000_000)).toBe("60M");
    expect(formatTokens(10_550_000)).toBe("10.55M");
  });

  it("moves to M rather than printing 1000k", () => {
    expect(formatTokens(999_960)).toBe("1M");
  });

  it("treats a missing or negative count as 0", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});
