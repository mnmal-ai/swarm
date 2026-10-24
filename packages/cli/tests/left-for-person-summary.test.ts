import { describe, it, expect } from "vitest";
import type { OversightResult } from "@mnmal-ai/swarm-types";
import { formatLeftForPersonSummary, verdictDetail } from "../src/cli/run.js";

const base: OversightResult = { verdict: "approved", retryCount: 0, arbiterInvolved: false, humanEscalation: false, rejectionReasons: [], totalResolutionTimeMs: 1 };

describe("verdictDetail", () => {
  it("carries the reviewer's lists only when there are any", () => {
    expect(verdictDetail(base)).toEqual({});
    expect(verdictDetail({ ...base, deferred: [], notes: [] })).toEqual({});
    expect(verdictDetail({ ...base, deferred: ["Check it on a phone"], notes: ["Kept the old icon"] }))
      .toEqual({ deferred: ["Check it on a phone"], notes: ["Kept the old icon"] });
  });
});

describe("formatLeftForPersonSummary", () => {
  it("counts the items per goal, by label when the goal has one", () => {
    const byGoal = new Map([
      ["goal-a", [{ task: "One", items: ["x", "y"] }, { task: "Two", items: ["z"] }]],
      ["goal-b", []],
      ["goal-c", [{ task: "Three", items: ["w"] }]],
    ]);
    expect(formatLeftForPersonSummary(byGoal, new Map([["goal-a", "#12"]]))).toEqual([
      "Left for a person: 4 items in 2 goals (listed on each goal's pull request)",
      "  #12: 3 items",
      "  goal-c: 1 item",
    ]);
  });

  it("says nothing when nothing was left", () => {
    expect(formatLeftForPersonSummary(new Map())).toEqual([]);
    expect(formatLeftForPersonSummary(new Map([["goal-a", []]]))).toEqual([]);
  });
});
