import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunReport, RunReportGoal, RunReportTaskDetail, AlertDef, ProjectConfig } from "@mnmal-ai/swarm-types";
import { formatTokens } from "@mnmal-ai/swarm-types";
import { deriveAutonomy } from "@mnmal-ai/swarm-orchestrator";

// ---------------------------------------------------------------------------
// Types for parsed JSONL events
// ---------------------------------------------------------------------------

interface BusEvent {
  _type: "bus_event";
  event: string;
  timestamp: string;
  payload: Record<string, unknown>;
  runId?: string;
}

export interface AggregateOptions {
  project: string;
  /** The session token limit the run's budget use is measured against. */
  sessionTokenLimit: number;
  runId?: string;
  alerts?: AlertDef[];
  fromDate?: string;
  toDate?: string;
}

/**
 * Alert metrics removed when budgets moved from dollars to tokens, with the
 * metric that replaced each. An alert on one fails the run loudly: its
 * condition is a dollar amount, so quietly passing it — or evaluating it
 * against tokens — would both be wrong.
 */
const REMOVED_ALERT_METRICS: ReadonlyMap<string, string> = new Map([
  ["avg_cost_per_session_usd", "avg_tokens_per_session"],
]);

/** Throws naming every alert that uses a removed dollar metric, and its replacement. */
export function assertNoRemovedAlertMetrics(alerts: AlertDef[]): void {
  const problems = alerts.flatMap((alert) => {
    const replacement = REMOVED_ALERT_METRICS.get(alert.metric);
    return replacement === undefined
      ? []
      : [`alert "${alert.id}" uses metric "${alert.metric}", which is no longer reported: budgets are in tokens. ` +
         `Use "${replacement}" instead and restate its condition in tokens.`];
  });
  if (problems.length > 0) throw new Error(`alerts.json: ${problems.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Internal accumulator state
// ---------------------------------------------------------------------------

interface TaskAcc {
  id: string;
  goalId: string;
  description: string;
  intent: string;
  verdict?: string;
  /** All input tokens (cache included) plus output. */
  tokens: number;
  latencyMs: number;
  retryCount: number;
  arbiterInvolved: boolean;
}

// ---------------------------------------------------------------------------
// Core aggregation — pure function, no I/O
// ---------------------------------------------------------------------------

export function aggregateEvents(lines: string[], options: AggregateOptions): RunReport {
  const { project, sessionTokenLimit, runId, alerts = [] } = options;
  assertNoRemovedAlertMetrics(alerts);

  // Filter and parse
  let swarmVersion: string | undefined;
  const events: BusEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (runId && parsed.runId && parsed.runId !== runId) continue;
      // Extract swarm_version from SwarmEvent records
      if (!swarmVersion && parsed.swarm_version?.commit_sha) {
        swarmVersion = String(parsed.swarm_version.commit_sha).slice(0, 7);
      }
      if (parsed._type === "bus_event") {
        events.push(parsed as BusEvent);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Accumulators
  const goals = new Map<string, { completed: number; total: number; tokens: number }>();
  const tasks = new Map<string, TaskAcc>();
  const intentCounts: Record<string, number> = {};
  let totalRetries = 0;
  let arbiterInvocations = 0;
  let escalations = 0;
  let tokenLimitHits = 0;
  let lastSessionTokens = 0;
  let firstTimestamp = "";
  let lastTimestamp = "";

  // Oversight tracking (per-verdict, not per-task)
  let oversightTotal = 0;
  let oversightFirstPass = 0; // approved with retryCount === 0
  const verdictCounts: Record<string, number> = {};

  // Worktrees
  let worktreeCreated = 0;
  let worktreeMerged = 0;
  let worktreeConflicts = 0;
  let worktreeDestroyed = 0;

  // Context
  const contextTokensList: number[] = [];
  let budgetOverflows = 0;
  let skillsFetched = 0;
  let skillFetchFailures = 0;

  for (const e of events) {
    // Track timestamps
    if (!firstTimestamp || e.timestamp < firstTimestamp) firstTimestamp = e.timestamp;
    if (!lastTimestamp || e.timestamp > lastTimestamp) lastTimestamp = e.timestamp;

    const p = e.payload;

    switch (e.event) {
      case "goal:start": {
        const gid = String(p.goalId ?? "");
        if (gid && !goals.has(gid)) {
          goals.set(gid, { completed: 0, total: 0, tokens: 0 });
        }
        break;
      }

      case "goal:completed": {
        const gid = String(p.goalId ?? "");
        goals.set(gid, {
          completed: Number(p.completedTasks ?? 0),
          total: Number(p.totalTasks ?? 0),
          tokens: Number(p.totalTokens ?? 0),
        });
        break;
      }

      case "task:start": {
        const tid = String(p.taskId ?? "");
        if (tid) {
          const intent = String(p.intent ?? "unknown");
          intentCounts[intent] = (intentCounts[intent] ?? 0) + 1;
          tasks.set(tid, {
            id: tid,
            goalId: String(p.goalId ?? ""),
            description: String(p.description ?? ""),
            intent,
            tokens: 0,
            latencyMs: 0,
            retryCount: 0,
            arbiterInvolved: false,
          });
        }
        break;
      }

      case "task:verdict": {
        const tid = String(p.taskId ?? "");
        const existing = tasks.get(tid);
        if (existing) {
          existing.verdict = String(p.verdict ?? "unknown");
          existing.tokens = breakdownTotal(p.tokens);
          existing.latencyMs = Number(p.latencyMs ?? 0);
          existing.retryCount = Number(p.retryCount ?? 0);
          existing.arbiterInvolved = Boolean(p.arbiterInvolved);
        }
        // Count task-level verdicts
        const v = String(p.verdict ?? "unknown");
        verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
        break;
      }

      case "oversight:verdict": {
        oversightTotal++;
        const retry = Number(p.retryCount ?? 0);
        totalRetries += retry;
        if (String(p.verdict) === "approved" && retry === 0) {
          oversightFirstPass++;
        }
        if (p.arbiterInvolved) arbiterInvocations++;
        break;
      }

      case "task:escalated":
        escalations++;
        break;

      case "tokens:update":
        lastSessionTokens = Number(p.cumulativeTokens ?? lastSessionTokens);
        break;

      case "orchestration:event": {
        const et = String(p.eventType ?? "");
        if (et === "task_token_exceeded") tokenLimitHits++;
        break;
      }

      case "worktree:created": worktreeCreated++; break;
      case "worktree:merged": worktreeMerged++; break;
      case "worktree:conflict": worktreeConflicts++; break;
      case "worktree:destroyed": worktreeDestroyed++; break;

      case "context:loaded":
        contextTokensList.push(Number(p.totalTokens ?? 0));
        if (Number(p.budgetUsedPercent ?? 0) > 100) budgetOverflows++;
        break;

      case "skill:fetched": skillsFetched++; break;
      case "skill:fetch_failed": skillFetchFailures++; break;
    }
  }

  // Helper to keep report compact
  const truncate = (s: string, max = 200) => s.length > max ? s.slice(0, max) + "..." : s;

  // Compute derived metrics
  const taskList = Array.from(tasks.values());
  const completedCount = taskList.filter(t => t.verdict === "approved" || t.verdict === "skipped").length;
  const failedCount = taskList.filter(t => t.verdict && t.verdict !== "approved" && t.verdict !== "skipped").length;

  const statusCounts: Record<string, number> = {};
  if (completedCount > 0) statusCounts.completed = completedCount;
  if (failedCount > 0) statusCounts.failed = failedCount;

  const failedTasks: RunReportTaskDetail[] = taskList
    .filter(t => t.verdict && t.verdict !== "approved" && t.verdict !== "skipped")
    .slice(0, 5)
    .map(t => ({ id: t.id, description: truncate(t.description), reason: `verdict: ${t.verdict}, retries: ${t.retryCount}` }));

  const slowest: RunReportTaskDetail[] = [...taskList]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 5)
    .map(t => ({ id: t.id, description: truncate(t.description), latency_ms: t.latencyMs }));

  const mostTokens: RunReportTaskDetail[] = [...taskList]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map(t => ({ id: t.id, description: truncate(t.description), tokens: t.tokens }));

  const maxTokensTask = mostTokens.length > 0 ? mostTokens[0] : null;
  const totalTokens = lastSessionTokens || taskList.reduce((sum, t) => sum + t.tokens, 0);
  const avgTokensPerTask = taskList.length > 0 ? totalTokens / taskList.length : 0;

  const durationMs = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : 0;

  const firstPassRate = oversightTotal > 0 ? oversightFirstPass / oversightTotal : 1.0;
  const avgTokens = contextTokensList.length > 0
    ? Math.round(contextTokensList.reduce((a, b) => a + b, 0) / contextTokensList.length)
    : 0;

  // Evaluate alerts
  const metricValues: Record<string, number> = {
    first_pass_acceptance_rate: firstPassRate,
    human_escalation_rate: taskList.length > 0 ? escalations / taskList.length : 0,
    arbiter_involvement_rate: taskList.length > 0 ? arbiterInvocations / taskList.length : 0,
    avg_tokens_per_session: totalTokens,
    context_budget_exceeded_rate: contextTokensList.length > 0 ? budgetOverflows / contextTokensList.length : 0,
  };

  const triggeredAlerts: RunReport["alerts"]["triggered"] = [];
  const passedAlerts: string[] = [];

  for (const alert of alerts) {
    const val = metricValues[alert.metric];
    if (val === undefined) {
      passedAlerts.push(alert.id);
      continue;
    }
    const match = alert.condition.match(/^([<>]=?)\s*([\d.]+)$/);
    if (!match) {
      passedAlerts.push(alert.id);
      continue;
    }
    const [, op, threshStr] = match;
    const thresh = parseFloat(threshStr);
    let triggered = false;
    if (op === "<" && val < thresh) triggered = true;
    if (op === "<=" && val <= thresh) triggered = true;
    if (op === ">" && val > thresh) triggered = true;
    if (op === ">=" && val >= thresh) triggered = true;

    if (triggered) {
      triggeredAlerts.push({ id: alert.id, metric: alert.metric, value: val, threshold: alert.condition });
    } else {
      passedAlerts.push(alert.id);
    }
  }

  // Build goal list
  const goalList: RunReportGoal[] = Array.from(goals.entries()).map(([id, g]) => ({
    id,
    completed_tasks: g.completed,
    total_tasks: g.total,
    tokens: g.tokens,
    completion_rate: g.total > 0 ? g.completed / g.total : 0,
  }));

  const date = firstTimestamp ? firstTimestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);

  return {
    meta: {
      generated_at: new Date().toISOString(),
      run_id: runId,
      date_range: { start: options.fromDate ?? date, end: options.toDate ?? date },
      project,
      swarm_version: swarmVersion,
      total_events: events.length,
    },
    session: {
      duration_ms: durationMs,
      total_tokens: totalTokens,
      total_tasks: taskList.length,
      total_goals: goals.size,
    },
    goals: goalList,
    oversight: {
      first_pass_rate: firstPassRate,
      retry_count: totalRetries,
      arbiter_invocations: arbiterInvocations,
      escalations,
      verdicts: verdictCounts,
    },
    tokens: {
      avg_tokens_per_task: avgTokensPerTask,
      max_tokens_task: maxTokensTask,
      token_limit_hits: tokenLimitHits,
      session_budget_used_pct: sessionTokenLimit > 0 ? (totalTokens / sessionTokenLimit) * 100 : 0,
    },
    tasks: {
      by_status: statusCounts,
      by_intent: intentCounts,
      failed: failedTasks,
      slowest,
      most_tokens: mostTokens,
    },
    worktrees: {
      created: worktreeCreated,
      merged: worktreeMerged,
      conflicts: worktreeConflicts,
      destroyed: worktreeDestroyed,
    },
    alerts: {
      triggered: triggeredAlerts,
      passed: passedAlerts,
    },
    context: {
      avg_tokens_loaded: avgTokens,
      budget_overflow_count: budgetOverflows,
      skills_fetched: skillsFetched,
      skill_fetch_failures: skillFetchFailures,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runGradeData(args: Record<string, string>): Promise<void> {
  const swarmPath = args["swarm-path"]
    ? resolve(args["swarm-path"])
    : (await import("./run.js")).discoverSwarmPath();

  const project = args["project"] ?? "";
  const runIdFilter = args["run"];
  const dateFilter = args["date"];
  const fromDate = args["from"];
  const toDate = args["to"];

  if (!runIdFilter && !dateFilter && !fromDate) {
    console.error("Usage: swarm grade-data --run <runId> | --date <YYYY-MM-DD> | --from <date> --to <date>");
    console.error("  --swarm-path <path>   Path to the swarm repo");
    console.error("  --project <name>      Project name (required for date-based queries)");
    process.exit(1);
  }

  // Determine which JSONL files to read
  const eventsDir = join(swarmPath, "telemetry", "events");
  let allFiles: string[];
  try {
    allFiles = readdirSync(eventsDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort();
  } catch {
    console.error(`No telemetry events directory found at: ${eventsDir}`);
    process.exit(1);
  }

  let filesToRead: string[];
  if (dateFilter) {
    filesToRead = allFiles.filter(f => f.startsWith(dateFilter));
  } else if (fromDate) {
    const end = toDate ?? new Date().toISOString().slice(0, 10);
    filesToRead = allFiles.filter(f => {
      const d = f.replace(".jsonl", "");
      return d >= fromDate && d <= end;
    });
  } else {
    // runId mode — read all files (runId filter happens in aggregateEvents)
    filesToRead = allFiles;
  }

  if (filesToRead.length === 0) {
    console.error("No telemetry files found for the specified range.");
    process.exit(1);
  }

  // Read all lines
  const allLines: string[] = [];
  for (const f of filesToRead) {
    const content = await readFile(join(eventsDir, f), "utf-8");
    allLines.push(...content.split("\n"));
  }

  // Read alerts
  const alertsPath = join(swarmPath, "telemetry", "alerts.json");
  let alertDefs: AlertDef[] = [];
  try {
    const alertsRaw = await readFile(alertsPath, "utf-8");
    alertDefs = JSON.parse(alertsRaw).alerts ?? [];
  } catch {
    // No alerts file — continue without
  }

  // The session token limit, as swarm run resolves it: the project's own, or
  // its trust level's (medium when there is no project config to read).
  let sessionTokenLimit = deriveAutonomy({ trust_level: "medium" } as ProjectConfig).execution.max_tokens_per_session;
  if (project) {
    try {
      const configPath = join(swarmPath, "domains", project, "config.json");
      const configRaw = await readFile(configPath, "utf-8");
      const config = JSON.parse(configRaw) as ProjectConfig;
      sessionTokenLimit = deriveAutonomy(config).execution.max_tokens_per_session;
    } catch {
      // Use default
    }
  }

  // Compute effective date range for the report
  const effectiveFromDate = dateFilter ?? fromDate;
  const effectiveToDate = dateFilter ?? toDate ?? (fromDate ? new Date().toISOString().slice(0, 10) : undefined);

  const report = aggregateEvents(allLines, {
    project: project || "unknown",
    sessionTokenLimit,
    runId: runIdFilter,
    alerts: alertDefs,
    fromDate: effectiveFromDate,
    toDate: effectiveToDate,
  });

  // Write report
  const reportsDir = join(swarmPath, "telemetry", "reports");
  await mkdir(reportsDir, { recursive: true });
  const reportName = runIdFilter ?? dateFilter ?? `${fromDate}_${toDate ?? "now"}`;
  const reportPath = join(reportsDir, `${reportName}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

  // Print summary
  const goalPct = report.goals.length > 0
    ? report.goals.map(g => `${g.id}: ${Math.round(g.completion_rate * 100)}%`).join(", ")
    : "no goals";
  console.log(`Report written to: ${reportPath}`);
  console.log(`  Goals: ${goalPct}`);
  console.log(`  Tasks: ${report.session.total_tasks} (${report.tasks.by_status.completed ?? 0} completed, ${report.tasks.by_status.failed ?? 0} failed)`);
  console.log(`  First-pass rate: ${(report.oversight.first_pass_rate * 100).toFixed(1)}%`);
  console.log(`  Tokens: ${formatTokens(report.session.total_tokens)} (${report.tokens.session_budget_used_pct.toFixed(1)}% of the session limit)`);
  if (report.alerts.triggered.length > 0) {
    console.log(`  Alerts triggered: ${report.alerts.triggered.map(a => a.id).join(", ")}`);
  }
}

/** All tokens in a task:verdict's split (input, cache included, plus output); 0 when absent. */
function breakdownTotal(t: unknown): number {
  if (!t || typeof t !== "object") return 0;
  const b = t as Record<string, unknown>;
  return ["freshInput", "cacheRead", "cacheWrite", "output"].reduce((n, k) => n + (Number(b[k]) || 0), 0);
}
