/**
 * swarm logs — List, fetch, and inspect remote telemetry runs.
 *
 * Commands:
 *   swarm logs list              List runs with optional filters
 *   swarm logs report <runId>    Fetch a run's grade report (JSON to stdout)
 *   swarm logs fetch <runId>     Download full tarball and extract locally
 *   swarm logs status            Show current sharing config
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createWriteStream } from "node:fs";
import { formatTokens } from "@mnmal-ai/swarm-types";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";
import { deriveAutonomy } from "@mnmal-ai/swarm-orchestrator";
import { DEFAULT_TELEMETRY_ENDPOINT } from "@mnmal-ai/swarm-telemetry";

// API base URL: the telemetry package's constant, never read from config or
// user-facing files.
const API_BASE = DEFAULT_TELEMETRY_ENDPOINT;

// ANSI codes for terminal output
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Is there anything to query?
// ---------------------------------------------------------------------------

/**
 * Why `swarm logs` has no collector to ask, as one line, or null when it has
 * one: the endpoint is the `.invalid` placeholder (this build was never
 * pointed at a deployed collector), or no project under `swarmDir` has
 * telemetry sharing on. Saying so beats dialing the placeholder and printing
 * a DNS error.
 */
export function telemetryUnavailableReason(endpoint: string, swarmDir: string): string | null {
  let host = "";
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    /* unparseable: treated as not configured */
  }
  if (host === "" || host === "invalid" || host.endsWith(".invalid")) {
    return `No telemetry collector is configured for this build (its endpoint is the placeholder ${endpoint}), so there are no remote runs to read.`;
  }
  const domainsDir = join(swarmDir, "domains");
  const sharing = existsSync(domainsDir)
    ? readdirSync(domainsDir).some((d) => {
        try {
          const cfg = JSON.parse(readFileSync(join(domainsDir, d, "config.json"), "utf-8")) as {
            telemetry_sharing?: { enabled?: unknown };
          };
          return cfg.telemetry_sharing?.enabled === true;
        } catch {
          return false;
        }
      })
    : false;
  if (!sharing) {
    return "Telemetry sharing is off (no project here has opted in); turn it on with `swarm sharing` to upload and read runs.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Get the user's GitHub token via `gh auth token`.
 * Uses execFileSync to avoid shell injection.
 */
function getGitHubToken(): string {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!token) {
      throw new Error("Empty token");
    }
    return token;
  } catch {
    console.error("Could not get GitHub token. Make sure you are logged in:");
    console.error("  gh auth login");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (using node:https, consistent with upload.ts)
// ---------------------------------------------------------------------------

interface ApiResponse {
  statusCode: number;
  body: string;
}

/**
 * Make an HTTPS GET request with Bearer auth.
 */
function apiGet(path: string, token: string): Promise<ApiResponse> {
  const url = new URL(`${API_BASE}${path}`);
  const requestFn = url.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

/**
 * Download a file from a URL to a local path.
 */
function downloadFile(fileUrl: string, destPath: string): Promise<void> {
  const url = new URL(fileUrl);
  const requestFn = url.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Accept: "application/gzip",
        },
        timeout: 120000,
      },
      (res) => {
        // Follow redirects (S3 presigned URLs may redirect)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
          res.resume();
          return;
        }

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", (err) => { file.close(); reject(err); });
      },
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// swarm logs list
// ---------------------------------------------------------------------------

interface RunEntry {
  run_id: string;
  identity: string;
  project: string;
  timestamp: string;
  tasks_completed: number;
  tasks_failed: number;
  /** All input tokens (cache included) plus output; absent for runs
   *  uploaded before swarm recorded tokens. */
  total_tokens?: number;
  goals_completed: number;
  goals_total: number;
}

async function logsList(flags: Record<string, string>): Promise<void> {
  const token = getGitHubToken();

  // Build query string from flags
  const params = new URLSearchParams();
  if (flags["user"]) params.set("user", flags["user"]);
  if (flags["project"]) params.set("project", flags["project"]);
  if (flags["from"]) params.set("from", flags["from"]);
  if (flags["to"]) params.set("to", flags["to"]);
  if (flags["limit"]) params.set("limit", flags["limit"]);

  const query = params.toString();
  const path = `/runs${query ? `?${query}` : ""}`;

  const response = await apiGet(path, token);

  if (response.statusCode === 401 || response.statusCode === 403) {
    console.error("Access denied. Your GitHub account may not be on the allowlist.");
    console.error("Contact the swarm maintainer to request access.");
    process.exit(1);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error(`API error (${response.statusCode}): ${response.body}`);
    process.exit(1);
  }

  let data: { runs: RunEntry[] };
  try {
    data = JSON.parse(response.body);
  } catch {
    console.error("Failed to parse API response.");
    process.exit(1);
  }

  if (!data.runs || data.runs.length === 0) {
    console.log(`${DIM}No runs found.${RESET}`);
    return;
  }

  // Print header
  console.log(
    `${BOLD}${"RUN ID".padEnd(COL_RUN_ID)}${"USER".padEnd(COL_USER)}${"PROJECT".padEnd(COL_PROJECT)}${"DATE".padEnd(COL_DATE)}${"TASKS".padEnd(COL_TASKS)}${"TOKENS".padStart(COL_TOKENS)}  STATUS${RESET}`,
  );

  // Print rows
  for (const run of data.runs) {
    console.log(formatRunRow(run));
  }
}

// Column widths for fixed-width formatting; STATUS is variable-width (last).
const COL_RUN_ID = 26;
const COL_USER = 14;
const COL_PROJECT = 13;
const COL_DATE = 12;
const COL_TASKS = 7;
const COL_TOKENS = 10;

/** One row of `swarm logs list`. Exported for testing. */
export function formatRunRow(run: RunEntry): string {
  const runId = run.run_id.padEnd(COL_RUN_ID);
  const user = (run.identity ?? "").padEnd(COL_USER);
  const project = (run.project ?? "").padEnd(COL_PROJECT);
  const date = (run.timestamp ? run.timestamp.slice(0, 10) : "").padEnd(COL_DATE);
  const tasks = String(run.tasks_completed + (run.tasks_failed ?? 0)).padEnd(COL_TASKS);
  const tokens = (typeof run.total_tokens === "number" ? formatTokens(run.total_tokens) : "--").padStart(COL_TOKENS);
  const status = `${run.goals_completed ?? 0}/${run.goals_total ?? 0} goals`;
  return `${runId}${user}${project}${date}${tasks}${tokens}  ${status}`;
}

// ---------------------------------------------------------------------------
// swarm logs report <runId>
// ---------------------------------------------------------------------------

async function logsReport(runId: string): Promise<void> {
  const token = getGitHubToken();

  process.stderr.write(`${DIM}Fetching report for ${runId}...${RESET}\n`);

  const response = await apiGet(`/runs/${encodeURIComponent(runId)}/report`, token);

  if (response.statusCode === 401 || response.statusCode === 403) {
    console.error("Access denied. Your GitHub account may not be on the allowlist.");
    process.exit(1);
  }

  if (response.statusCode === 404) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error(`API error (${response.statusCode}): ${response.body}`);
    process.exit(1);
  }

  // Output the report JSON to stdout (pipeable to a file or jq)
  console.log(response.body);
}

// ---------------------------------------------------------------------------
// swarm logs fetch <runId>
// ---------------------------------------------------------------------------

async function logsFetch(runId: string): Promise<void> {
  const token = getGitHubToken();

  process.stderr.write(`${DIM}Fetching run metadata for ${runId}...${RESET}\n`);

  // Step 1: GET /runs/{runId} to get download URL
  const response = await apiGet(`/runs/${encodeURIComponent(runId)}`, token);

  if (response.statusCode === 401 || response.statusCode === 403) {
    console.error("Access denied. Your GitHub account may not be on the allowlist.");
    process.exit(1);
  }

  if (response.statusCode === 404) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.error(`API error (${response.statusCode}): ${response.body}`);
    process.exit(1);
  }

  let data: { meta: Record<string, unknown>; download_url: string };
  try {
    data = JSON.parse(response.body);
  } catch {
    console.error("Failed to parse API response.");
    process.exit(1);
  }

  if (!data.download_url) {
    console.error("No download URL in API response.");
    process.exit(1);
  }

  // Step 2: Download the tarball
  const swarmDir = resolve(process.cwd(), ".swarm");
  const downloadsDir = join(swarmDir, "telemetry", "downloads");
  const extractDir = join(downloadsDir, runId);
  const tarballPath = join(downloadsDir, `${runId}.tar.gz`);

  mkdirSync(downloadsDir, { recursive: true });

  process.stderr.write(`${DIM}Downloading tarball...${RESET}\n`);
  await downloadFile(data.download_url, tarballPath);

  // Step 3: Extract the tarball
  mkdirSync(extractDir, { recursive: true });

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir]);

  // Clean up the tarball after extraction
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tarballPath);
  } catch {
    // Not critical if cleanup fails
  }

  // Step 4: Print the extraction path and contents summary
  console.log(`Downloaded to ${CYAN}.swarm/telemetry/downloads/${runId}/${RESET}`);

  // Walk the extracted directory and list contents
  printExtractedContents(extractDir, "  ");
}

/**
 * Print a summary of extracted contents, showing file names and sizes.
 */
function printExtractedContents(dir: string, indent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const entryStat = statSync(entryPath);

      if (entryStat.isDirectory()) {
        // Print directory name and recurse
        console.log(`${indent}${entry}/`);
        printExtractedContents(entryPath, indent + "  ");
      } else {
        // Print file with line count for JSONL, or just the name
        let detail = "";
        if (entry.endsWith(".jsonl")) {
          try {
            const content = readFileSync(entryPath, "utf-8");
            const lineCount = content.split("\n").filter((l) => l.trim()).length;
            detail = ` ${DIM}(${lineCount} events)${RESET}`;
          } catch {
            // Skip line counting on read error
          }
        }
        console.log(`${indent}${entry}${detail}`);
      }
    } catch {
      console.log(`${indent}${entry}`);
    }
  }
}

// ---------------------------------------------------------------------------
// swarm logs status
// ---------------------------------------------------------------------------

function logsStatus(flags: Record<string, string>): void {
  const swarmDir = resolve(process.cwd(), flags["dir"] ?? ".swarm");

  if (!existsSync(swarmDir)) {
    console.error("No .swarm/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const domainsDir = join(swarmDir, "domains");
  if (!existsSync(domainsDir)) {
    console.error("No domains/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const projects = readdirSync(domainsDir).filter((d) =>
    existsSync(join(domainsDir, d, "config.json")),
  );

  if (projects.length === 0) {
    console.error("No project config found. Run 'swarm init' first.");
    process.exit(1);
  }

  console.log("");
  console.log(`${BOLD}Telemetry Sharing Status${RESET}`);
  console.log("");

  for (const project of projects) {
    const configPath = join(domainsDir, project, "config.json");
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.log(`  ${BOLD}${project}${RESET}  ${DIM}(config unreadable)${RESET}`);
      continue;
    }

    const sharing = config.telemetry_sharing as {
      enabled?: boolean;
      share_logs?: boolean;
      share_trees?: boolean;
      share_context?: boolean;
      identity?: {
        type: string;
        github_username?: string;
        telemetry_id?: string;
      };
    } | undefined;

    console.log(`  ${BOLD}${project}${RESET}`);

    if (!sharing || !sharing.enabled) {
      console.log(`    Sharing:  ${DIM}disabled${RESET}`);
      console.log("");
      continue;
    }

    // Identity display
    let identityStr: string;
    if (sharing.identity?.type === "github") {
      identityStr = `${GREEN}GitHub${RESET} (${sharing.identity.github_username})`;
    } else if (sharing.identity?.type === "anonymous") {
      const shortId = sharing.identity.telemetry_id?.slice(0, 8) ?? "unknown";
      identityStr = `${YELLOW}Anonymous${RESET} (${shortId}...)`;
    } else {
      identityStr = `${DIM}not configured${RESET}`;
    }

    const yes = `${GREEN}yes${RESET}`;
    const no = `${DIM}no${RESET}`;

    console.log(`    Sharing:  ${GREEN}enabled${RESET}`);
    console.log(`    Identity: ${identityStr}`);
    console.log(`    Logs:     ${sharing.share_logs ? yes : no}`);
    console.log(`    Trees:    ${sharing.share_trees ? yes : no}`);
    console.log(`    Context:  ${sharing.share_context ? yes : no}`);
    console.log("");
  }

  console.log(`  ${DIM}Update with: ${CYAN}swarm sharing${RESET}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// swarm logs grade — fetch, grade, and print a report card
// ---------------------------------------------------------------------------

async function logsGrade(runId: string): Promise<void> {
  // Step 1: Fetch the run (reuse logsFetch logic)
  console.error(`${DIM}Fetching run ${runId}...${RESET}`);
  const token = getGitHubToken();

  // Get run detail + download URL
  const detailRes = await apiGet(`/runs/${runId}`, token);
  if (detailRes.statusCode === 404) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  if (detailRes.statusCode !== 200) {
    console.error(`API error (${detailRes.statusCode}): ${detailRes.body}`);
    process.exit(1);
  }

  const detail = JSON.parse(detailRes.body);
  const meta = detail.meta;
  const downloadUrl = detail.download_url;

  if (!downloadUrl) {
    // No tarball — use metadata only for a lightweight report card
    printMetaOnlyReportCard(meta, runId);
    return;
  }

  // Download and extract
  const swarmDir = resolve(process.cwd(), ".swarm");
  const downloadDir = join(swarmDir, "telemetry", "downloads");
  const extractDir = join(downloadDir, runId);
  mkdirSync(extractDir, { recursive: true });

  const tarballPath = join(downloadDir, `${runId}.tar.gz`);

  console.error(`${DIM}Downloading tarball...${RESET}`);
  await downloadFile(downloadUrl, tarballPath);

  console.error(`${DIM}Extracting...${RESET}`);
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: "pipe" });
  } catch {
    console.error("Failed to extract tarball");
    // Fall back to metadata-only report card
    printMetaOnlyReportCard(meta, runId);
    return;
  }

  // Step 2: Check if report.json exists in the extracted data
  const reportPath = join(extractDir, "logs", "report.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    printFullReportCard(report, meta, runId);
    return;
  }

  // Step 3: If no report.json, try to grade from events.jsonl
  const eventsPath = join(extractDir, "logs", "events.jsonl");
  if (existsSync(eventsPath)) {
    console.error(`${DIM}No report.json found — grading from telemetry events...${RESET}`);
    const { aggregateEvents } = await import("./grade-data.js");
    const lines = readFileSync(eventsPath, "utf-8").split("\n");
    const report = aggregateEvents(lines, {
      project: meta?.project || "unknown",
      sessionTokenLimit: deriveAutonomy({ trust_level: "medium" } as ProjectConfig).execution.max_tokens_per_session,
      runId: runId,
    });
    printFullReportCard(report, meta, runId);
    return;
  }

  // Fallback: metadata-only
  printMetaOnlyReportCard(meta, runId);
}

// ---------------------------------------------------------------------------
// Report card renderers
// ---------------------------------------------------------------------------

const BOX_TL = "┌";
const BOX_TR = "┐";
const BOX_BL = "└";
const BOX_BR = "┘";
const BOX_H  = "─";
const BOX_V  = "│";
const BOX_ML = "├";
const BOX_MR = "┤";
const CHECK  = `${GREEN}✓${RESET}`;
const WARN   = `${YELLOW}⚠${RESET}`;
const FAIL   = `\x1b[31m✗${RESET}`;

function box(width: number, lines: string[]): string {
  const top = `${BOX_TL}${BOX_H.repeat(width - 2)}${BOX_TR}`;
  const bottom = `${BOX_BL}${BOX_H.repeat(width - 2)}${BOX_BR}`;
  const mid = `${BOX_ML}${BOX_H.repeat(width - 2)}${BOX_MR}`;
  const pad = (s: string) => {
    // Strip ANSI for length calculation
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = Math.max(0, width - 4 - stripped.length);
    return `${BOX_V}  ${s}${" ".repeat(padding)}${BOX_V}`;
  };
  return [top, ...lines.map(l => l === "---" ? mid : pad(l)), bottom].join("\n");
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "--";
  const m = Math.floor(ms / 60000);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m`;
}

function statusIcon(good: boolean): string {
  return good ? CHECK : WARN;
}

function printFullReportCard(report: import("@mnmal-ai/swarm-types").RunReport, meta: Record<string, unknown> | null, runId: string): void {
  console.log("");
  console.log(formatFullReportCard(report, meta, runId));
  console.log("");
}

/** The full report card, boxed. Exported for testing. */
export function formatFullReportCard(report: import("@mnmal-ai/swarm-types").RunReport, meta: Record<string, unknown> | null, _runId: string): string {
  const W = 55;
  const project = (meta?.project as string) || report.meta.project || "unknown";
  const user = (meta?.identity as string) || "unknown";
  const date = report.meta.date_range?.start || "unknown";
  const sdk = (meta?.swarm_sdk_version as string) || report.meta.swarm_version || "unknown";

  const totalTasks = report.session.total_tasks;
  const completedTasks = report.tasks.by_status.completed || 0;
  const failedTasks = report.tasks.by_status.failed || 0;
  const totalGoals = report.session.total_goals;
  const goalsCompleted = report.goals.filter(g => g.completion_rate === 1).length;
  const tokens = report.session.total_tokens;
  const budgetPct = report.tokens.session_budget_used_pct;
  const limit = budgetPct > 0 ? tokens / (budgetPct / 100) : 0;
  const duration = report.session.duration_ms;
  const firstPass = report.oversight.first_pass_rate;
  const arbiterRate = totalTasks > 0 ? report.oversight.arbiter_invocations / totalTasks : 0;
  const escalations = report.oversight.escalations;
  const conflicts = report.worktrees.conflicts;
  const verdicts = report.oversight.verdicts;
  const allSkipped = verdicts.skipped === totalTasks && !verdicts.approved && !verdicts.rejected;

  const lines: string[] = [
    `${BOLD}${project}${RESET} — Run Report Card`,
    `${DIM}${user} · ${date} · SDK ${sdk}${RESET}`,
    "---",
    `Goals:     ${goalsCompleted}/${totalGoals} completed          ${statusIcon(goalsCompleted === totalGoals)}`,
    `Tasks:     ${completedTasks}/${totalTasks} completed          ${statusIcon(failedTasks === 0)}`,
    `Tokens:    ${formatTokens(tokens)} of ${formatTokens(limit)} (${budgetPct.toFixed(0)}%)`,
    `Duration:  ${formatDuration(duration)}`,
    allSkipped
      ? `Oversight: ${YELLOW}all skipped${RESET}                  ${WARN}`
      : `Oversight: ${(firstPass * 100).toFixed(0)}% first-pass          ${statusIcon(firstPass >= 0.85)}`,
    `Arbiter:   ${(arbiterRate * 100).toFixed(0)}%                         ${statusIcon(arbiterRate <= 0.1)}`,
    `Escalated: ${escalations}                          ${statusIcon(escalations === 0)}`,
    `Conflicts: ${conflicts} merge conflict${conflicts !== 1 ? "s" : ""}        ${statusIcon(conflicts === 0)}`,
  ];

  // Tasks that used the most tokens
  if (report.tasks.most_tokens.length > 0) {
    lines.push("---");
    lines.push(`${BOLD}Most Tokens:${RESET}`);
    for (const t of report.tasks.most_tokens.slice(0, 3)) {
      const desc = t.description.length > 25 ? t.description.slice(0, 22) + "..." : t.description;
      const tokStr = t.tokens != null ? formatTokens(t.tokens) : "--";
      const latStr = t.latency_ms != null ? `(${formatDuration(t.latency_ms)})` : "";
      lines.push(`  ${t.id.padEnd(12)} ${desc.padEnd(25)} ${tokStr.padStart(7)}  ${latStr}`);
    }
  }

  // Issues
  const issues: string[] = [];
  if (allSkipped) issues.push(`${WARN} No oversight performed (all skipped)`);
  if (failedTasks > 0) issues.push(`${FAIL} ${failedTasks} task(s) failed`);
  if (conflicts > 0) issues.push(`${WARN} ${conflicts} merge conflict(s)`);
  if (report.tokens.token_limit_hits > 0) issues.push(`${WARN} ${report.tokens.token_limit_hits} task(s) hit the token limit`);
  if (report.context.budget_overflow_count > 0) issues.push(`${WARN} ${report.context.budget_overflow_count} context budget overflow(s)`);
  for (const t of report.tasks.failed) {
    const desc = t.description.length > 40 ? t.description.slice(0, 37) + "..." : t.description;
    issues.push(`${FAIL} ${desc}${t.reason ? `: ${t.reason}` : ""}`);
  }
  if (report.alerts.triggered.length > 0) {
    for (const a of report.alerts.triggered) {
      issues.push(`${WARN} Alert: ${a.id} (${a.metric} ${a.threshold}, got ${a.value.toFixed(2)})`);
    }
  }

  if (issues.length > 0) {
    lines.push("---");
    lines.push(`${BOLD}Issues:${RESET}`);
    for (const issue of issues) {
      lines.push(issue);
    }
  }

  return box(W, lines);
}

function printMetaOnlyReportCard(meta: Record<string, unknown>, runId: string): void {
  console.log("");
  console.log(formatMetaOnlyReportCard(meta, runId));
  console.log("");
}

/** The report card from upload metadata alone, boxed. Exported for testing. */
export function formatMetaOnlyReportCard(meta: Record<string, unknown>, runId: string): string {
  const W = 55;
  const project = (meta.project as string) || "unknown";
  const user = (meta.identity as string) || "unknown";
  const date = (meta.timestamp as string)?.slice(0, 10) || "unknown";
  const sdk = (meta.swarm_sdk_version as string) || "unknown";
  const tasks = (meta.tasks_completed as number) || 0;
  const tasksFailed = (meta.tasks_failed as number) || 0;
  const totalTasks = tasks + tasksFailed;
  const goals = (meta.goals_completed as number) || 0;
  const totalGoals = (meta.goals_total as number) || 0;
  const tokens = typeof meta.total_tokens === "number" ? formatTokens(meta.total_tokens) : "--";
  const duration = (meta.duration_ms as number) || 0;

  const lines: string[] = [
    `${BOLD}${project}${RESET} — Run Report Card`,
    `${DIM}${user} · ${date} · SDK ${sdk}${RESET}`,
    `${DIM}(metadata only — run 'swarm logs fetch ${runId}' for full report)${RESET}`,
    "---",
    `Goals:     ${goals}/${totalGoals} completed          ${statusIcon(goals === totalGoals)}`,
    `Tasks:     ${tasks}/${totalTasks} completed          ${statusIcon(tasksFailed === 0)}`,
    `Tokens:    ${tokens}`,
    `Duration:  ${formatDuration(duration)}`,
  ];

  return box(W, lines);
}

// ---------------------------------------------------------------------------
// Public API — entry point from main.ts
// ---------------------------------------------------------------------------

export async function runLogs(flags: Record<string, string>, positional: string[]): Promise<void> {
  const subcommand = positional[0];

  // Every subcommand but `status` reads the collector.
  if (subcommand === "list" || subcommand === "report" || subcommand === "fetch" || subcommand === "grade") {
    const reason = telemetryUnavailableReason(API_BASE, resolve(process.cwd(), flags["dir"] ?? ".swarm"));
    if (reason !== null) {
      console.error(reason);
      process.exit(1);
    }
  }

  switch (subcommand) {
    case "list":
      await logsList(flags);
      break;

    case "report": {
      const runId = positional[1];
      if (!runId) {
        console.error("Usage: swarm logs report <runId>");
        process.exit(1);
      }
      await logsReport(runId);
      break;
    }

    case "fetch": {
      const runId = positional[1];
      if (!runId) {
        console.error("Usage: swarm logs fetch <runId>");
        process.exit(1);
      }
      await logsFetch(runId);
      break;
    }

    case "grade": {
      const runId = positional[1];
      if (!runId) {
        console.error("Usage: swarm logs grade <runId>");
        process.exit(1);
      }
      await logsGrade(runId);
      break;
    }

    case "status":
      logsStatus(flags);
      break;

    default:
      console.log(`${BOLD}swarm logs${RESET} — View and fetch remote telemetry runs`);
      console.log("");
      console.log("Commands:");
      console.log("  list                  List runs (optional filters below)");
      console.log("  grade <runId>         Fetch, grade, and print a report card");
      console.log("  report <runId>        Fetch a run's grade report (JSON to stdout)");
      console.log("  fetch <runId>         Download full payload and extract locally");
      console.log("  status                Show current sharing config");
      console.log("");
      console.log("List filters:");
      console.log("  --user <username>     Filter by user");
      console.log("  --project <name>      Filter by project");
      console.log("  --from <YYYY-MM-DD>   Start date");
      console.log("  --to <YYYY-MM-DD>     End date");
      console.log("  --limit <n>           Max results (default: 50)");
      console.log("");
      console.log("Examples:");
      console.log(`  ${DIM}swarm logs list --user example-bot --project my-app${RESET}`);
      console.log(`  ${DIM}swarm logs grade run-my-app-b29842${RESET}`);
      console.log(`  ${DIM}swarm logs report run-my-app-b29842${RESET}`);
      console.log(`  ${DIM}swarm logs fetch run-my-app-b29842${RESET}`);
      console.log(`  ${DIM}swarm logs report run-my-app-b29842 | jq '.session'${RESET}`);
      if (subcommand) {
        process.exit(1);
      }
      break;
  }
}
