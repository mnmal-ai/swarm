import { describe, it, expect } from "vitest";
import { aggregateEvents } from "../src/cli/grade-data.js";

// Helper to create a bus event JSONL line
function busEvent(event: string, payload: Record<string, unknown>, runId?: string): string {
  const obj: Record<string, unknown> = {
    _type: "bus_event",
    event,
    timestamp: "2026-02-25T20:45:00.000Z",
    payload: { ...payload, timestamp: 1772052300000 },
  };
  if (runId) obj.runId = runId;
  return JSON.stringify(obj);
}

function orchEvent(eventType: string, detail: string, extra: Record<string, unknown> = {}, runId?: string): string {
  return busEvent("orchestration:event", { eventType, detail, project: "test", trustLevel: "medium", ...extra }, runId);
}

describe("aggregateEvents", () => {
  it("produces a valid RunReport from minimal events", () => {
    const lines = [
      orchEvent("session_started", "Starting"),
      busEvent("goal:start", { goalId: "goal-1", description: "Fix bugs", taskCount: 2 }),
      busEvent("task:start", { taskId: "goal-1-task-1", goalId: "goal-1", description: "Fix bug A", intent: "implementation" }),
      busEvent("oversight:verdict", { verdict: "approved", retryCount: 0, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "goal-1-task-1", verdict: "approved", tokens: { freshInput: 0, cacheRead: 1_500_000, cacheWrite: 0, output: 0 }, latencyMs: 30000, retryCount: 0, arbiterInvolved: false }),
      busEvent("task:start", { taskId: "goal-1-task-2", goalId: "goal-1", description: "Fix bug B", intent: "implementation" }),
      busEvent("oversight:verdict", { verdict: "approved", retryCount: 0, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "goal-1-task-2", verdict: "approved", tokens: { freshInput: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 0 }, latencyMs: 45000, retryCount: 0, arbiterInvolved: false }),
      busEvent("goal:completed", { goalId: "goal-1", completedTasks: 2, totalTasks: 2, totalTokens: 3_500_000 }),
      busEvent("tokens:update", { cumulativeTokens: 3_500_000, sessionTokenLimit: 50_000_000, percentUsed: 7 }),
      orchEvent("session_completed", "Done"),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });
    expect(report.session.total_goals).toBe(1);
    expect(report.session.total_tasks).toBe(2);
    expect(report.goals).toHaveLength(1);
    expect(report.goals[0].completion_rate).toBe(1.0);
    expect(report.oversight.first_pass_rate).toBe(1.0);
    expect(report.oversight.verdicts.approved).toBe(2);
    expect(report.tasks.by_status.completed).toBe(2);
    expect(report.tasks.failed).toHaveLength(0);
  });

  it("tracks failed tasks and computes correct rates", () => {
    const lines = [
      orchEvent("session_started", "Starting"),
      busEvent("goal:start", { goalId: "goal-1", description: "Test", taskCount: 3 }),
      busEvent("task:start", { taskId: "t1", goalId: "goal-1", description: "Task A", intent: "implementation" }),
      busEvent("oversight:verdict", { verdict: "approved", retryCount: 0, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }, latencyMs: 10000, retryCount: 0, arbiterInvolved: false }),
      busEvent("task:start", { taskId: "t2", goalId: "goal-1", description: "Task B", intent: "implementation" }),
      busEvent("oversight:verdict", { verdict: "rejected", retryCount: 2, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "t2", verdict: "rejected", tokens: { freshInput: 0, cacheRead: 3_000_000, cacheWrite: 0, output: 0 }, latencyMs: 90000, retryCount: 2, arbiterInvolved: false }),
      busEvent("task:start", { taskId: "t3", goalId: "goal-1", description: "Task C", intent: "investigation" }),
      busEvent("oversight:verdict", { verdict: "approved", retryCount: 1, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "t3", verdict: "approved", tokens: { freshInput: 0, cacheRead: 500_000, cacheWrite: 0, output: 0 }, latencyMs: 5000, retryCount: 1, arbiterInvolved: false }),
      busEvent("goal:completed", { goalId: "goal-1", completedTasks: 2, totalTasks: 3, totalTokens: 4_500_000 }),
      busEvent("tokens:update", { cumulativeTokens: 4_500_000, sessionTokenLimit: 50_000_000, percentUsed: 9 }),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });
    expect(report.tasks.by_status.completed).toBe(2);
    expect(report.tasks.by_status.failed).toBe(1);
    expect(report.tasks.failed).toHaveLength(1);
    expect(report.tasks.failed[0].id).toBe("t2");
    expect(report.oversight.first_pass_rate).toBeCloseTo(1 / 3);
    expect(report.oversight.retry_count).toBe(3);
    expect(report.tasks.most_tokens[0].id).toBe("t2");
    expect(report.tasks.slowest[0].id).toBe("t2");
  });

  it("filters by runId when provided", () => {
    const lines = [
      busEvent("task:start", { taskId: "t1", goalId: "g1", description: "A", intent: "implementation" }, "run-test-aaa111"),
      busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }, latencyMs: 5000, retryCount: 0, arbiterInvolved: false }, "run-test-aaa111"),
      busEvent("task:start", { taskId: "t2", goalId: "g1", description: "B", intent: "implementation" }, "run-test-bbb222"),
      busEvent("task:verdict", { taskId: "t2", verdict: "approved", tokens: { freshInput: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 0 }, latencyMs: 8000, retryCount: 0, arbiterInvolved: false }, "run-test-bbb222"),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000, runId: "run-test-aaa111" });
    expect(report.session.total_tasks).toBe(1);
    expect(report.meta.run_id).toBe("run-test-aaa111");
  });

  it("counts worktree events", () => {
    const lines = [
      busEvent("worktree:created", { taskId: "t1" }),
      busEvent("worktree:created", { taskId: "t2" }),
      busEvent("worktree:merged", { taskId: "t1" }),
      busEvent("worktree:conflict", { taskId: "t2" }),
      busEvent("worktree:destroyed", { taskId: "t1" }),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });
    expect(report.worktrees.created).toBe(2);
    expect(report.worktrees.merged).toBe(1);
    expect(report.worktrees.conflicts).toBe(1);
    expect(report.worktrees.destroyed).toBe(1);
  });

  it("counts context events and detects overflow", () => {
    const lines = [
      busEvent("context:loaded", { files: ["a.md", "b.md"], totalTokens: 3000, budgetUsedPercent: 60, truncated: [] }),
      busEvent("context:loaded", { files: ["a.md"], totalTokens: 1000, budgetUsedPercent: 110, truncated: ["c.md"] }),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });
    expect(report.context.avg_tokens_loaded).toBe(2000);
    expect(report.context.budget_overflow_count).toBe(1);
  });

  it("counts skill fetch events", () => {
    const lines = [
      busEvent("skill:fetched", { url: "http://example.com/a.md", estimatedTokens: 500, latencyMs: 200 }),
      busEvent("skill:fetched", { url: "http://example.com/b.md", estimatedTokens: 300, latencyMs: 150 }),
      busEvent("skill:fetch_failed", { url: "http://example.com/c.md", error: "timeout" }),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });
    expect(report.context.skills_fetched).toBe(2);
    expect(report.context.skill_fetch_failures).toBe(1);
  });

  it("evaluates alerts against computed metrics", () => {
    const alerts = [
      { id: "first-pass-rate-drop", metric: "first_pass_acceptance_rate", condition: "< 0.80", window: "rolling_7_days", severity: "high", message: "" },
      { id: "token-spike", metric: "avg_tokens_per_session", condition: "> 500000", window: "rolling_7_days", severity: "medium", message: "" },
    ];
    const lines = [
      busEvent("task:start", { taskId: "t1", goalId: "g1", description: "A", intent: "implementation" }),
      busEvent("oversight:verdict", { verdict: "approved", retryCount: 0, arbiterInvolved: false }),
      busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 0, cacheRead: 100_000, cacheWrite: 0, output: 0 }, latencyMs: 5000, retryCount: 0, arbiterInvolved: false }),
      busEvent("tokens:update", { cumulativeTokens: 100_000, sessionTokenLimit: 50_000_000, percentUsed: 0.2 }),
    ];
    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000, alerts });
    expect(report.alerts.passed).toContain("first-pass-rate-drop");
    expect(report.alerts.passed).toContain("token-spike");
    expect(report.alerts.triggered).toHaveLength(0);
  });

  it("refuses an alert on the removed dollar metric, naming its token replacement", () => {
    const alerts = [
      { id: "first-pass-rate-drop", metric: "first_pass_acceptance_rate", condition: "< 0.80", window: "rolling_7_days", severity: "high", message: "" },
      { id: "spend-spike", metric: "avg_cost_per_session_usd", condition: "> 20", window: "rolling_7_days", severity: "medium", message: "" },
    ];
    const lines = [
      busEvent("task:start", { taskId: "t1", goalId: "g1", description: "A", intent: "implementation" }),
      busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 0, cacheRead: 100_000, cacheWrite: 0, output: 0 }, latencyMs: 5000, retryCount: 0, arbiterInvolved: false }),
    ];

    const run = () => aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000, alerts });

    expect(run).toThrow(/spend-spike/);
    expect(run).toThrow(/avg_cost_per_session_usd/);
    expect(run).toThrow(/avg_tokens_per_session/);
  });

  it("reports tokens, not dollars: totals, per task, per goal, budget use and limit hits", () => {
    const lines = [
      busEvent("goal:start", { goalId: "goal-1", description: "Test", taskCount: 2 }),
      busEvent("task:start", { taskId: "t1", goalId: "goal-1", description: "Task A", intent: "implementation" }),
      busEvent("task:verdict", { taskId: "t1", verdict: "approved", tokens: { freshInput: 1_000, cacheRead: 900_000, cacheWrite: 50_000, output: 49_000 }, latencyMs: 1000, retryCount: 0, arbiterInvolved: false }),
      busEvent("task:start", { taskId: "t2", goalId: "goal-1", description: "Task B", intent: "implementation" }),
      busEvent("task:verdict", { taskId: "t2", verdict: "approved", tokens: { freshInput: 0, cacheRead: 3_000_000, cacheWrite: 0, output: 0 }, latencyMs: 1000, retryCount: 0, arbiterInvolved: false }),
      orchEvent("task_token_exceeded", "Task skipped: 3M tokens (limit: 2M tokens)"),
      busEvent("goal:completed", { goalId: "goal-1", completedTasks: 2, totalTasks: 2, totalTokens: 4_000_000 }),
      busEvent("tokens:update", { cumulativeTokens: 4_000_000, sessionTokenLimit: 50_000_000, percentUsed: 8 }),
    ];

    const report = aggregateEvents(lines, { project: "test", sessionTokenLimit: 50_000_000 });

    expect(report.session.total_tokens).toBe(4_000_000);
    expect(report.goals[0].tokens).toBe(4_000_000);
    expect(report.tokens.max_tokens_task).toMatchObject({ id: "t2", tokens: 3_000_000 });
    expect(report.tokens.avg_tokens_per_task).toBe(2_000_000);
    expect(report.tokens.token_limit_hits).toBe(1);
    expect(report.tokens.session_budget_used_pct).toBe(8);
    expect(JSON.stringify(report)).not.toMatch(/cost|usd/i);
  });
});
