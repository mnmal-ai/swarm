/**
 * `swarm logs` shows a run's usage in tokens: the run list's usage column,
 * the full report card and the metadata-only card carry token counts and no
 * dollar figure.
 */

import { describe, it, expect } from "vitest";
import { aggregateEvents } from "../src/cli/grade-data.js";
import { formatFullReportCard, formatMetaOnlyReportCard, formatRunRow } from "../src/cli/logs.js";

function busEvent(event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ _type: "bus_event", event, timestamp: "2026-02-25T20:45:00.000Z", payload });
}

const report = aggregateEvents(
  [
    busEvent("goal:start", { goalId: "goal-1", description: "Test", taskCount: 1 }),
    busEvent("task:start", { taskId: "t1", goalId: "goal-1", description: "Task A", intent: "implementation" }),
    busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 10_000, cacheRead: 11_900_000, cacheWrite: 90_000, output: 0 }, latencyMs: 60_000, retryCount: 0, arbiterInvolved: false }),
    busEvent("goal:completed", { goalId: "goal-1", completedTasks: 1, totalTasks: 1, totalTokens: 12_000_000 }),
    busEvent("tokens:update", { cumulativeTokens: 12_000_000, sessionTokenLimit: 60_000_000, percentUsed: 20 }),
  ],
  { project: "sample-project", sessionTokenLimit: 60_000_000 },
);

describe("swarm logs, in tokens", () => {
  it("report card shows the session's tokens against its limit, and the heaviest tasks", () => {
    const card = formatFullReportCard(report, { project: "sample-project" }, "run-1");

    expect(card).toContain("Tokens:    12M of 60M (20%)");
    expect(card).toContain("12M");
    expect(card).not.toMatch(/\$/);
  });

  it("metadata-only card shows the run's tokens", () => {
    const card = formatMetaOnlyReportCard({ project: "sample-project", total_tokens: 10_550_000, duration_ms: 60_000 }, "run-1");

    expect(card).toContain("Tokens:    10.55M");
    expect(card).not.toMatch(/\$/);
  });

  it("run list row shows tokens, or -- for a run uploaded before tokens were recorded", () => {
    const base = { run_id: "run-1", identity: "someone", project: "sample-project", timestamp: "2026-02-25T00:00:00Z", tasks_completed: 3, tasks_failed: 0, goals_completed: 1, goals_total: 1 };

    expect(formatRunRow({ ...base, total_tokens: 10_550_000 })).toContain("10.55M");
    expect(formatRunRow(base)).toContain("--");
    expect(formatRunRow({ ...base, total_tokens: 1 })).not.toMatch(/\$/);
  });
});
