/**
 * How swarm run words a session's fnl coverage, adds sessions up into the
 * run's total, and passes each session's coverage on from the backend, for
 * every role.
 */

import { describe, expect, it } from "vitest";
import type { FnlCoverage, FnlSavings, IWorkerBackend, WorkerTaskOutput } from "@mnmal-ai/swarm-types";
import { FnlTotals, describeFnlCoverage } from "../src/cli/fnl-coverage.js";
import { withModelReporting } from "../src/cli/role-models.js";
import { sessionSummaryLines } from "../src/cli/token-budget-display.js";

const cov = (over: Partial<FnlCoverage> = {}): FnlCoverage => ({ buildCommands: 0, wrapped: 0, leftAlone: {}, byTool: {}, unanswered: 0, ...over });
const saved = (over: Partial<FnlSavings> = {}): FnlSavings => ({ calls: 0, rawTokens: 0, sentTokens: 0, withoutFnlTokens: 0, savedTokens: 0, unmeasured: 0, oversized: 0, ...over });

describe("describeFnlCoverage", () => {
  it("says how many build commands fnl wrapped", () => {
    expect(describeFnlCoverage(cov({ buildCommands: 2, wrapped: 2, byTool: { xcodebuild: { wrapped: 2, leftAlone: 0 } } }))).toBe(
      "wrapped 2 of 2 build/test commands",
    );
  });

  it("names why the others were left alone, most common first", () => {
    expect(describeFnlCoverage(cov({ buildCommands: 3, wrapped: 0, leftAlone: { structure: 3 } }))).toBe(
      "wrapped 0 of 3 build/test commands (3 left alone: structure)",
    );
    expect(describeFnlCoverage(cov({ buildCommands: 5, wrapped: 1, leftAlone: { "deny-rule": 1, structure: 3 } }))).toBe(
      "wrapped 1 of 5 build/test commands (4 left alone: structure 3, deny-rule 1)",
    );
  });

  it("says when fnl didn't answer", () => {
    expect(describeFnlCoverage(cov({ buildCommands: 1, wrapped: 1, unanswered: 2 }))).toBe(
      "wrapped 1 of 1 build/test commands; fnl didn't answer for 2 commands",
    );
    expect(describeFnlCoverage(cov({ unanswered: 1 }))).toBe("no build/test commands; fnl didn't answer for 1 command");
  });

  it("says nothing for a session with no build commands and no failures", () => {
    expect(describeFnlCoverage(cov())).toBeNull();
  });

  it("adds the tokens the digests saved, as the run log formats tokens", () => {
    const c = cov({ buildCommands: 7, wrapped: 5, leftAlone: { structure: 2 }, savings: saved({ calls: 5, rawTokens: 900_000, sentTokens: 2_000, withoutFnlTokens: 414_000, savedTokens: 412_000 }) });
    expect(describeFnlCoverage(c)).toBe("wrapped 5 of 7 build/test commands (2 left alone: structure) · saved ~412k tokens");
  });

  it("adds how many large logs the agents got as digests", () => {
    const c = cov({ buildCommands: 7, wrapped: 5, leftAlone: { structure: 2 }, savings: saved({ calls: 5, savedTokens: 12_000, oversized: 3 }) });
    expect(describeFnlCoverage(c)).toBe("wrapped 5 of 7 build/test commands (2 left alone: structure) · saved ~12k tokens · 3 large logs digested");
    expect(describeFnlCoverage(cov({ buildCommands: 1, wrapped: 1, savings: saved({ calls: 1, savedTokens: 500, oversized: 1 }) }))).toBe(
      "wrapped 1 of 1 build/test commands · saved ~500 tokens · 1 large log digested",
    );
  });

  it("adds no saving when no wrapped call could be measured", () => {
    expect(describeFnlCoverage(cov({ buildCommands: 1, wrapped: 1, savings: saved({ unmeasured: 1 }) }))).toBe("wrapped 1 of 1 build/test commands");
  });
});

describe("FnlTotals", () => {
  it("adds sessions up, reasons and tools included", () => {
    const totals = new FnlTotals();
    expect(totals.total()).toBeNull();
    totals.add(cov({ buildCommands: 2, wrapped: 1, leftAlone: { structure: 1 }, byTool: { gradlew: { wrapped: 1, leftAlone: 1 } } }));
    totals.add(cov({ buildCommands: 3, wrapped: 3, byTool: { gradlew: { wrapped: 1, leftAlone: 0 }, xcodebuild: { wrapped: 2, leftAlone: 0 } }, unanswered: 1 }));
    expect(totals.sessions).toBe(2);
    expect(totals.total()).toEqual({
      buildCommands: 5,
      wrapped: 4,
      leftAlone: { structure: 1 },
      byTool: { gradlew: { wrapped: 2, leftAlone: 1 }, xcodebuild: { wrapped: 2, leftAlone: 0 } },
      unanswered: 1,
    });
  });

  it("adds up the sessions' savings, when any session had them", () => {
    const totals = new FnlTotals();
    totals.add(cov({ buildCommands: 1, wrapped: 1, savings: saved({ calls: 1, rawTokens: 10, sentTokens: 1, withoutFnlTokens: 8, savedTokens: 7, oversized: 1 }) }));
    totals.add(cov({ buildCommands: 1 }));
    totals.add(cov({ buildCommands: 2, wrapped: 2, savings: saved({ calls: 1, rawTokens: 20, sentTokens: 2, withoutFnlTokens: 12, savedTokens: 10, unmeasured: 1 }) }));
    expect(totals.total()?.savings).toEqual({ calls: 2, rawTokens: 30, sentTokens: 3, withoutFnlTokens: 20, savedTokens: 17, unmeasured: 1, oversized: 1 });
  });

  it("has no savings when no session had any", () => {
    const totals = new FnlTotals();
    totals.add(cov({ buildCommands: 1, wrapped: 1 }));
    expect(totals.total()).not.toHaveProperty("savings");
  });
});

describe("sessionSummaryLines: fnl", () => {
  const base = { project: "app", tasksCompleted: 1, tasksRun: 1, tokens: { freshInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, duration: "1m" };

  it("adds the run's fnl coverage when sessions counted it", () => {
    const lines = sessionSummaryLines({ ...base, fnl: cov({ buildCommands: 4, wrapped: 3, leftAlone: { structure: 1 } }) });
    expect(lines).toContain("fnl coverage:    wrapped 3 of 4 build/test commands (1 left alone: structure)");
  });

  it("adds what the digests saved, as first-read savings, and the large logs digested", () => {
    const lines = sessionSummaryLines({ ...base, fnl: cov({ buildCommands: 49, wrapped: 41, leftAlone: { structure: 8 }, savings: saved({ calls: 41, savedTokens: 1_200_000, oversized: 6 }) }) });
    expect(lines).toContain(
      "fnl coverage:    wrapped 41 of 49 build/test commands (8 left alone: structure) · saved ~1.2M tokens of output (first read) · 6 large logs digested",
    );
  });

  it("says so when sessions counted coverage but ran no build commands", () => {
    expect(sessionSummaryLines({ ...base, fnl: cov() })).toContain("fnl coverage:    no build/test commands ran");
  });

  it("leaves the line out when nothing was counted", () => {
    expect(sessionSummaryLines(base).some((l) => l.startsWith("fnl"))).toBe(false);
  });
});

describe("withModelReporting: fnl coverage", () => {
  const backend = (out: Partial<WorkerTaskOutput>): IWorkerBackend => ({
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: async () => ({ output: "ok", latencyMs: 1, tokensUsed: { input: 1, output: 1 }, filesChanged: [], backendUsed: "claude-code", ...out }),
  });

  it("passes each session's coverage on, tagged with the role", async () => {
    const seen: Array<{ role: string; coverage: FnlCoverage }> = [];
    const coverage = cov({ buildCommands: 1, wrapped: 1 });
    await withModelReporting(backend({ fnlCoverage: coverage }), "reviewer", () => {}, undefined, (r) => seen.push(r)).execute({
      task: "t",
      workingDirectory: "/tmp",
      swarmContext: "",
      maxTurns: 1,
    });
    expect(seen).toEqual([{ role: "reviewer", coverage, timestamp: expect.any(Number) }]);
  });

  it("passes nothing on for a session without coverage", async () => {
    const seen: unknown[] = [];
    await withModelReporting(backend({}), "worker", () => {}, undefined, (r) => seen.push(r)).execute({ task: "t", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 });
    expect(seen).toEqual([]);
  });
});
