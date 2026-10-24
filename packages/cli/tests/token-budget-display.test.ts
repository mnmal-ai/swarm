/**
 * What `swarm run` prints about budgets — the preflight limits, the prompt
 * when a task goes over its limit, and the end-of-run summary — is in tokens,
 * with no dollar figure anywhere.
 */

import { describe, it, expect } from "vitest";
import {
  describeTaskOverrun,
  formatTokenLimitLines,
  resolveTaskOverrun,
  sessionSummaryLines,
} from "../src/cli/token-budget-display.js";

describe("formatTokenLimitLines (preflight)", () => {
  it("lists the session, goal and task token limits", () => {
    const lines = formatTokenLimitLines({ session: 60_000_000, goal: 20_000_000, task: 6_000_000 });

    expect(lines).toEqual([
      "Session     60M tokens",
      "Per goal    20M tokens",
      "Per task    6M tokens",
    ]);
    expect(lines.join("\n")).not.toMatch(/\$/);
  });
});

describe("task over its token limit", () => {
  it("describes the overrun in tokens", () => {
    const line = describeTaskOverrun("Build the widget", 1_250_000, 1_000_000);

    expect(line).toBe('Task "Build the widget" exceeded its token limit (1.25M > 1M tokens)');
  });

  it("raises the limit to 1.5x what the task used when the user chooses increase", () => {
    const d = resolveTaskOverrun("increase", 1_250_000, 1_000_000);

    expect(d.action).toBe("increase");
    expect(d.newLimit).toBe(1_875_000);
    expect(d.message).toBe("Per-task limit increased to 1.88M tokens. Continuing...");
    expect(d.event).toEqual({
      type: "token_limit_increased",
      detail: "Per-task limit increased from 1M to 1.88M tokens",
      tokens: 1_875_000,
    });
  });

  it("skips the task, recording its tokens, when the user chooses skip", () => {
    const d = resolveTaskOverrun("skip", 1_250_000, 1_000_000);

    expect(d.action).toBe("skip");
    expect(d.newLimit).toBeUndefined();
    expect(d.event).toEqual({
      type: "task_token_exceeded",
      detail: "Task skipped: 1.25M tokens (limit: 1M tokens)",
      tokens: 1_250_000,
    });
  });

  it("aborts on anything else", () => {
    expect(resolveTaskOverrun("abort", 1_250_000, 1_000_000).action).toBe("abort");
  });

  it("never mentions dollars", () => {
    const all = [
      describeTaskOverrun("t", 5, 4),
      ...(["increase", "skip", "abort"] as const).flatMap((c) => {
        const d = resolveTaskOverrun(c, 5, 4);
        return [d.message, d.event?.detail ?? ""];
      }),
    ].join("\n");

    expect(all).not.toMatch(/\$/);
  });
});

describe("sessionSummaryLines (end of run)", () => {
  it("reports the session's tokens, split into fresh input, cached input and output", () => {
    const lines = sessionSummaryLines({
      project: "sample-project",
      tasksCompleted: 4,
      tasksRun: 5,
      tokens: { freshInput: 110_000, cacheRead: 10_200_000, cacheWrite: 130_000, output: 110_000 },
      duration: "1h 0m",
    });

    expect(lines).toContain("Total tokens:    10,550,000 (input 110k · cached 10.33M · output 110k)");
    expect(lines.join("\n")).not.toMatch(/\$/);
  });
});
