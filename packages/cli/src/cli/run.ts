/**
 * swarm run — Orchestrated execution loop.
 *
 * Loads project config and goals, initializes the Orchestrator and Swarm SDK,
 * then iterates goals in priority order. For each goal, creates investigation
 * and implementation tasks, builds dispatch directives, and calls
 * swarm.runWithOversight(). Enforces token budgets, saves checkpoints, handles SIGINT
 * gracefully, and prints a session summary at the end.
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  getExecutableGoals,
  Orchestrator,
  analyzeGoalResults,
  WorktreeManager,
  estimateComplexity,
  createEscalationWatcher,
  subDecompose,
  getTimeoutForComplexity,
  deriveAutonomy,
  effectiveDecomposition,
  describeDecomposition,
  classifyTaskForDispatch,
  getAnticipatedSerializations,
  loadConflictHistory,
  captureRunObservation,
  RateLimitGate,
  STACK_PRS_DEFAULT,
  SourceControlManager,
  MERGE_PRS_DEFAULT_SKIP_LABELS,
  validateSourceControlConfig,
  gitIdentityEnv,
  initialCommitMessage,
  loadShipReadinessContract,
  gateAppliesToGoal,
  runShipReadinessGate,
  defaultCommandRunner,
  defaultFetch,
  buildShipReadinessFollowUpTask,
  mirrorGoalStart,
  mirrorTaskExecutionStart,
  mirrorTaskExecutionEnd,
  linkTaskExecutionWorkerResult,
  readTaskExecutionCounts,
  pendingPublications,
  resumeStackHead,
  trackGoalPublications,
  FileMergeQueue,
  repoKeyFor,
  MERGE_ELIGIBLE_VERDICTS,
  MERGE_PRS_DEFAULT_MAX_ROUNDS,
  MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS,
} from "@mnmal-ai/swarm-orchestrator";
import type { ConflictResolver, MergeGoalOptions, MergeGoalResult, ReplanTaskResult, ShipReadinessContract } from "@mnmal-ai/swarm-orchestrator";
import type { MergePrsGateConfig } from "@mnmal-ai/swarm-types";
import { conflictTaskContext, conflictTaskDescription } from "./merge-conflict-task.js";

import { VERSION } from "../version.js";
import { resolveRepoRoot, assertGitRepo } from "./repo-root.js";
import { isGhostCompletion } from "./ghost-completion.js";
import {
  prepareGoalDispatch,
  createGoalStackLedger,
  recordGoalOutcomeForStack,
  whereGoalCommitsLanded,
  stackPushQueue,
  localBranchExists,
  type CompletedGoalRef,
  type UnstackedGoalRef,
} from "./goal-stack.js";
import { LoginStop, watchLogin, loginExpiredBanner } from "./login-stop.js";
import { codexHookCommand } from "./codex-hook.js";
import { preflightCodexRoles } from "./codex-preflight.js";
import { earlierMergeOptions, mergeGoalSafely, publishEarlierMergeGoals, formatEarlierPublications } from "./goal-publications.js";
import { claimProject } from "./project-claim.js";
import { roleBackendConfigs, withModelReporting, modelMismatch, describeModelReport } from "./role-models.js";
import type { RoleModelReport } from "./role-models.js";
import { formatGoalBrief, trelloSourceOptions } from "./goal-source.js";
import { assertValidLabelsConfig, labelGoals } from "./goal-labels.js";
import { loadComplexityThresholds, describeComplexityThresholds } from "./complexity-thresholds.js";
import { assertValidDecompositionConfig, applyPlannerCap, goalDecompositionWarnings, plannerTaskCapInstruction } from "./decomposition-policy.js";
import { assertValidFnlConfig, resolveFnl } from "./fnl-integration.js";
import { FnlTotals, describeFnlCoverage } from "./fnl-coverage.js";
import {
  assertValidContextConfig,
  createSectionSync,
  describeDocumentReads,
  gitHead,
  listProjectMarkdown,
  resolveContextPull,
  resolveContextRules,
  resolveContextRanking,
  resolveContextSections,
} from "./context-sections.js";
import { listSwarmMarkdown } from "./seed.js";
import { EXTERNAL_DEPENDENCIES, checkDependencyVersion } from "../external-deps.js";
import { resolveAuthorId } from "./author-id.js";
import { RunPrepError, acquireRunLock, assertValidRunPrepConfig, runSetupCommand, syncBaseBranch, type BaseSyncResult } from "./run-prep.js";
import { prepareGitHubAccess, formatGitHubBannerLine } from "./github-account.js";
import { Swarm, createProvider } from "@mnmal-ai/swarm-core";
import type { SwarmDeps } from "@mnmal-ai/swarm-core";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer, lanWarning } from "../server/index.js";
import { Telemetry } from "@mnmal-ai/swarm-telemetry";
import { Oversight } from "@mnmal-ai/swarm-oversight";
import { createTaskBackend, GitHubExternalSource, TrelloExternalSource, syncGoalLifecycle } from "@mnmal-ai/swarm-task-backends";
import { resolveWorkerBackend, instantiateFallback, createClaudeSynopsisWriter, createClaudeLabelWriter } from "@mnmal-ai/swarm-worker-backends";
import { ClaimRegistry, computeClaimAccuracy } from "@mnmal-ai/swarm-telemetry";
import { SWARM_DOCS_NAMESPACE, isLocalOnlyEnv, SubstrateClient, selectProjectContent, substrateDocsStore, syncDocuments } from "@mnmal-ai/swarm-substrate";
import { SUCCESS_VERDICTS, SUCCESS_TASK_STATUSES, SUCCESS_GOAL_STATUSES, tokenBreakdown, addTokenBreakdown, emptyTokenBreakdown, tokenBreakdownTotal, formatTokens, createEmptyGhConfigDir, loginExpiredMessage, addLeftForPerson, countLeftForPerson } from "@mnmal-ai/swarm-types";
import type {
  ProjectConfig,
  GoalsManifest,
  Goal,
  Task,
  DispatchDirective,
  SwarmOversightRunResult,
  OversightResult,
  SubDecompositionResult,
  WorktreeCleanupStrategy,
  TaskOutcomeSummary,
  ProgressEvent,
  TaskStatus,
  CommitStyle,
  GitIdentity,
  SourceControlConfig,
  GoalPublication,
  LeftForPersonGroup,
} from "@mnmal-ai/swarm-types";
import { ToolWedgeWatcher } from "./tool-wedge-watcher.js";
import { FailurePostmortemRecorder, type LineageNode } from "./failure-postmortem.js";
import { evaluateSessionBudget } from "./budget-guard.js";
import { chargeSession, spendTokens } from "./session-charge.js";
import { SessionLedger } from "./session-ledger.js";
import { assertValidBudgetConfig } from "./budget-config.js";
import { describeTaskOverrun, formatTokenLimitLines, resolveTaskOverrun, sessionSummaryLines } from "./token-budget-display.js";
import type { ActiveToolSnapshot, BackendFnlCoverageEvent, FnlCoverage } from "@mnmal-ai/swarm-types";

/**
 * DEBUG INSTRUMENTATION — milestone tracing for `swarm run`'s post-confirmation
 * path. Originally added to triage a run that stalled after confirmation; kept in the
 * codebase so the next "swarm ran for N seconds and did nothing" investigation
 * can be diagnosed in one cycle instead of three.
 *
 * Disabled by default. Enable by setting `SWARM_TRACE` truthy in the env:
 *
 *   SWARM_TRACE=1 swarm run 2>&1 | tee /tmp/swarm-trace.log
 *
 * Output goes to stderr (so `2>&1 | tee` captures it alongside stdout but
 * regular `> file` separates them) and carries a `[swarm:trace +Xs]` prefix
 * for easy grepping. Call sites are marked `M01`..`M28b` (main flow) and
 * `G01`..`G11` (inside ensureGitReady). New milestones should follow the
 * same naming so the call graph stays scannable.
 */
const __TRACE_ENABLED =
  process.env.SWARM_TRACE !== undefined &&
  process.env.SWARM_TRACE !== "" &&
  process.env.SWARM_TRACE !== "0" &&
  process.env.SWARM_TRACE.toLowerCase() !== "false" &&
  process.env.SWARM_TRACE.toLowerCase() !== "off";
const __TRACE_START_MS = Date.now();
function trace(msg: string): void {
  if (!__TRACE_ENABLED) return;
  const elapsed = ((Date.now() - __TRACE_START_MS) / 1000).toFixed(2);
  process.stderr.write(`[swarm:trace +${elapsed}s] ${msg}\n`);
}

/**
 * Prints the oldest 5 in-flight tool calls from a wedge snapshot so an
 * operator triaging at the terminal sees the wedge identity inline.
 * The full list is preserved in the `task:tool_wedged` event payload
 * and in the `FailurePostmortem` Substrate entity — this is just the at-a-
 * glance signal. Extracted from both wedge emit sites so the format
 * doesn't drift between them.
 */
function logActiveToolsSnapshot(tools: ActiveToolSnapshot[]): void {
  if (tools.length === 0) return;
  for (const t of tools.slice(0, 5)) {
    console.log(
      dim(
        `          ↳ ${t.name} (${(t.ageMs / 1000).toFixed(0)}s)` +
          (t.inputPreview ? `: ${t.inputPreview}` : ""),
      ),
    );
  }
  if (tools.length > 5) {
    console.log(dim(`          ↳ … and ${tools.length - 5} more`));
  }
}

// ---------------------------------------------------------------------------
// Swarm path discovery
// ---------------------------------------------------------------------------

/**
 * Discover the swarm content directory when `--swarm-path` is not given: the
 * `.swarm/` directory in the current directory (embedded mode from
 * `swarm init`). Never a sibling directory. When `.swarm/swarm.json` does not
 * exist the `.swarm/` path is still returned, so the caller's "no project
 * config" error names where `swarm init` puts it.
 */
export function discoverSwarmPath(): string {
  const embedded = resolve(process.cwd(), ".swarm");
  if (!existsSync(join(embedded, "swarm.json"))) return embedded;
  // Resolve symlinks so the preflight screen and telemetry show the real path
  try { return realpathSync(embedded); } catch { return embedded; }
}

// ---------------------------------------------------------------------------
// ANSI helpers (inline — no external dependency)
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function bold(text: string): string { return `${BOLD}${text}${RESET}`; }
function dim(text: string): string { return `${DIM}${text}${RESET}`; }
function green(text: string): string { return `${GREEN}${text}${RESET}`; }
function red(text: string): string { return `${RED}${text}${RESET}`; }
function yellow(text: string): string { return `${YELLOW}${text}${RESET}`; }
function cyan(text: string): string { return `${CYAN}${text}${RESET}`; }

/** Timestamp prefix for operational log lines: [HH:MM:SS] */
function ts(): string {
  return dim(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}]`);
}
function magenta(text: string): string { return `${MAGENTA}${text}${RESET}`; }

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** A task result's tokens as the budgets count them: all input (fresh,
 *  cache reads, cache writes) plus output. */
function resultTokens(result: { tokensUsed: { input: number; output: number } }): number {
  return result.tokensUsed.input + result.tokensUsed.output;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function verdictColor(verdict: string): string {
  switch (verdict) {
    case "approved": return green(verdict);
    case "rejected": return red(verdict);
    case "skipped": return dim(verdict);
    case "escalate": return yellow(verdict);
    default: return verdict;
  }
}

// ---------------------------------------------------------------------------
// Provider → credential key mapping (exported for testing)
// ---------------------------------------------------------------------------

/** Maps provider names to the environment variable keys they require. */
export const PROVIDER_CREDENTIALS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/** Returns the relevant credential env var names for a given provider. */
export function getProviderCredentialKeys(provider: string): string[] {
  return PROVIDER_CREDENTIALS[provider] ?? [];
}

// ---------------------------------------------------------------------------
// Swarm tree printer
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a file (1 token ≈ 4 characters).
 */
function estimateFileTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * List markdown files in a directory. Returns empty array if dir doesn't exist.
 */
async function listMdFiles(dirPath: string): Promise<{ name: string; tokens: number }[]> {
  try {
    const entries = await readdir(dirPath);
    const results: { name: string; tokens: number }[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dirPath, entry);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      const content = await readFile(filePath, "utf-8");
      results.push({ name: entry, tokens: estimateFileTokens(content) });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Print a tree view of the swarm directory structure for a project.
 * Shows core/, modes/, capabilities/, domains/<project>/, and skills/ tiers
 * with file names and estimated token costs.
 */
export async function printSwarmTree(swarmPath: string, project: string, substrateClient?: any): Promise<void> {
  console.log("");

  // When a Substrate client is available, query swarm content from the store instead of the filesystem
  if (substrateClient) {
    console.log(bold("  Swarm File Tree") + dim("  (from Substrate)"));
    // The endpoint the client actually resolved (configured, isolated
    // project stack, or found by port scan) — not the default port.
    if (typeof substrateClient.endpoint === "string") console.log(dim(`  ${substrateClient.endpoint}`));
    console.log("");

    try {
      // The rows this project reads on a shared Substrate: its own copy of a path,
      // else the legacy one; never another project's.
      const allContent = selectProjectContent(await substrateClient.query("SwarmContent", {}, {
        path: true, tier: true, tokenEstimate: true, projectId: true,
      }) as { path: string; tier: string; tokenEstimate: number; projectId: string }[], project);

      // Group by tier display sections
      const tierLabels: { tier: string; label: string }[] = [
        { tier: "core", label: "core/" },
        { tier: "mode", label: "modes/" },
        { tier: "capabilities", label: "capabilities/" },
        { tier: "domain", label: `domains/${project}/` },
      ];

      let totalFiles = 0;
      let totalTokens = 0;

      for (const section of tierLabels) {
        const files = allContent
          .filter(f => f.tier === section.tier && (section.tier !== "domain" || f.projectId === project))
          .sort((a, b) => a.path.localeCompare(b.path));
        const sectionTokens = files.reduce((sum, f) => sum + Number(f.tokenEstimate), 0);
        totalFiles += files.length;
        totalTokens += sectionTokens;

        if (files.length === 0) {
          console.log(`  ${dim("├─")} ${bold(section.label)} ${dim("(empty)")}`);
        } else {
          console.log(`  ${dim("├─")} ${bold(section.label)} ${dim(`${files.length} files, ~${sectionTokens.toLocaleString()} tokens`)}`);
          for (let i = 0; i < files.length; i++) {
            const connector = i === files.length - 1 ? "└─" : "├─";
            const name = files[i].path.split("/").pop() ?? files[i].path;
            const tokens = Number(files[i].tokenEstimate);
            console.log(`  ${dim("│  ")} ${dim(connector)} ${name} ${dim(`~${tokens.toLocaleString()}t`)}`);
          }
        }
      }

      // Skills
      const skillFiles = allContent
        .filter(f => f.tier === "skills_vetted" || f.tier === "skills_community" || f.tier === "skills_core")
        .sort((a, b) => a.path.localeCompare(b.path));
      const skillTokens = skillFiles.reduce((sum, f) => sum + Number(f.tokenEstimate), 0);
      totalFiles += skillFiles.length;
      totalTokens += skillTokens;

      console.log(`  ${dim("└─")} ${bold("skills/")} ${dim(`${skillFiles.length} files, ~${skillTokens.toLocaleString()} tokens`)}`);
      const tierGroups = [
        { label: "core/", filter: "skills_core" },
        { label: "vetted/", filter: "skills_vetted" },
        { label: "community/", filter: "skills_community" },
      ];
      for (const tg of tierGroups) {
        const tierFiles = skillFiles.filter(f => f.tier === tg.filter);
        if (tierFiles.length === 0) {
          console.log(`  ${dim("   ├─")} ${dim(tg.label)} ${dim("(empty)")}`);
        } else {
          console.log(`  ${dim("   ├─")} ${tg.label}`);
          for (let i = 0; i < tierFiles.length; i++) {
            const connector = i === tierFiles.length - 1 ? "└─" : "├─";
            const name = tierFiles[i].path.split("/").pop() ?? tierFiles[i].path;
            const tokens = Number(tierFiles[i].tokenEstimate);
            console.log(`  ${dim("   │  ")} ${dim(connector)} ${name} ${dim(`~${tokens.toLocaleString()}t`)}`);
          }
        }
      }

      console.log("");
      console.log(dim(`  Total: ${totalFiles} files, ~${totalTokens.toLocaleString()} tokens (queried from Substrate)`));
      console.log("");
      return;
    } catch {
      // Fall through to filesystem if Substrate query fails
      console.log(dim("  (Substrate query failed, falling back to filesystem)"));
      console.log("");
    }
  }

  // Filesystem fallback
  console.log(bold("  Swarm File Tree"));
  console.log(dim(`  ${swarmPath}`));
  console.log("");

  const sections: { label: string; dir: string; indent: string }[] = [
    { label: "core/", dir: join(swarmPath, "core"), indent: "  " },
    { label: "modes/", dir: join(swarmPath, "modes"), indent: "  " },
    { label: "capabilities/", dir: join(swarmPath, "capabilities"), indent: "  " },
    { label: `domains/${project}/`, dir: join(swarmPath, "domains", project), indent: "  " },
  ];

  let totalFiles = 0;
  let totalTokens = 0;

  for (const section of sections) {
    const files = await listMdFiles(section.dir);
    const sectionTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    totalFiles += files.length;
    totalTokens += sectionTokens;

    if (files.length === 0) {
      console.log(`${section.indent}${dim("├─")} ${bold(section.label)} ${dim("(empty)")}`);
    } else {
      console.log(`${section.indent}${dim("├─")} ${bold(section.label)} ${dim(`${files.length} files, ~${sectionTokens.toLocaleString()} tokens`)}`);
      for (let i = 0; i < files.length; i++) {
        const connector = i === files.length - 1 ? "└─" : "├─";
        console.log(`${section.indent}${dim("│  ")} ${dim(connector)} ${files[i].name} ${dim(`~${files[i].tokens.toLocaleString()}t`)}`);
      }
    }
  }

  const skillsTiers = [
    { label: "core/", dir: join(swarmPath, "skills", "core") },
    { label: "vetted/", dir: join(swarmPath, "skills", "vetted") },
    { label: "community/", dir: join(swarmPath, "skills", "community") },
  ];

  const allSkillFiles: { name: string; tokens: number; tier: string }[] = [];
  for (const tier of skillsTiers) {
    const files = await listMdFiles(tier.dir);
    for (const f of files) {
      allSkillFiles.push({ ...f, tier: tier.label });
    }
  }

  const skillTokens = allSkillFiles.reduce((sum, f) => sum + f.tokens, 0);
  totalFiles += allSkillFiles.length;
  totalTokens += skillTokens;

  console.log(`  ${dim("└─")} ${bold("skills/")} ${dim(`${allSkillFiles.length} files, ~${skillTokens.toLocaleString()} tokens`)}`);
  for (const tier of skillsTiers) {
    const tierFiles = allSkillFiles.filter(f => f.tier === tier.label);
    if (tierFiles.length === 0) {
      console.log(`  ${dim("   ├─")} ${dim(tier.label)} ${dim("(empty)")}`);
    } else {
      console.log(`  ${dim("   ├─")} ${tier.label}`);
      for (let i = 0; i < tierFiles.length; i++) {
        const connector = i === tierFiles.length - 1 ? "└─" : "├─";
        console.log(`  ${dim("   │  ")} ${dim(connector)} ${tierFiles[i].name} ${dim(`~${tierFiles[i].tokens.toLocaleString()}t`)}`);
      }
    }
  }

  console.log("");
  console.log(dim(`  Total: ${totalFiles} files, ~${totalTokens.toLocaleString()} tokens`));
  console.log("");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REMEDIATION_ITERATIONS = 2;

// ---------------------------------------------------------------------------
// Preflight credential check
// ---------------------------------------------------------------------------

/**
 * Verify that required API credentials are available before dispatching work.
 * Checks are provider-specific and extensible. Exits with a clear error
 * message if a required credential is missing — prevents the scenario where
 * every task fails individually with the same "no API key" error.
 *
 * Currently supports:
 * - claude-code: checks ANTHROPIC_API_KEY (needed for fallback to direct API)
 * - api (anthropic): checks ANTHROPIC_API_KEY
 * - api (openai): checks OPENAI_API_KEY
 *
 * Extend the switch statement for new providers.
 */
function preflightCredentialCheck(
  config: import("@mnmal-ai/swarm-types").ProjectConfig,
  _resolvedBackendType: string,
  fallbackUsed: boolean,
): void {
  const provider = config.models?.provider ?? "anthropic";
  const backendType = config.backends?.worker?.type ?? "api";
  const hasFallback = !!config.backends?.worker?.fallback;

  // Determine which API key is needed
  interface CredentialRequirement {
    envVar: string;
    providerName: string;
    getKeyUrl: string;
  }

  const requirements: Record<string, CredentialRequirement> = {
    anthropic: {
      envVar: "ANTHROPIC_API_KEY",
      providerName: "Anthropic",
      getKeyUrl: "https://console.anthropic.com/settings/keys",
    },
    openai: {
      envVar: "OPENAI_API_KEY",
      providerName: "OpenAI",
      getKeyUrl: "https://platform.openai.com/api-keys",
    },
  };

  const req = requirements[provider];
  if (!req) return; // Unknown provider — skip check

  switch (backendType) {
    case "claude-code": {
      // Claude Code manages its own auth. Only check the API key if
      // the fallback was actually used (Claude Code unavailable).
      // If fallback is configured but not triggered, just warn.
      if (!process.env[req.envVar]) {
        if (fallbackUsed) {
          // Fatal — we're actively using the fallback and it needs the key
          console.error("");
          console.error(`  \x1b[31mError: ${req.envVar} is not set.\x1b[0m`);
          console.error("");
          console.error(`  Claude Code was not available, so swarm fell back to the direct API.`);
          console.error(`  The ${req.providerName} API requires ${req.envVar} to be set.`);
          console.error("");
          console.error(`  Set it with:`);
          console.error(`    export ${req.envVar}=sk-...`);
          console.error("");
          console.error(`  Get a key at: ${req.getKeyUrl}`);
          console.error("");
          process.exit(1);
        } else if (hasFallback) {
          // Non-fatal warning — Claude Code is working, but fallback won't work without the key
          console.log(`  \x1b[33mWarning: ${req.envVar} is not set. If Claude Code becomes unavailable, the fallback will fail.\x1b[0m`);
          console.log(`  \x1b[2mSet it with: export ${req.envVar}=sk-...  (${req.getKeyUrl})\x1b[0m`);
          console.log("");
        }
      }
      break;
    }

    case "api": {
      // Direct API always needs the key
      if (!process.env[req.envVar]) {
        console.error("");
        console.error(`  \x1b[31mError: ${req.envVar} is not set.\x1b[0m`);
        console.error("");
        console.error(`  Your config uses the direct ${req.providerName} API backend.`);
        console.error(`  This requires ${req.envVar} to be set in your environment.`);
        console.error("");
        console.error(`  Set it with:`);
        console.error(`    export ${req.envVar}=sk-...`);
        console.error("");
        console.error(`  Get a key at: ${req.getKeyUrl}`);
        console.error("");
        process.exit(1);
      }
      break;
    }

    // Future providers go here:
    // case "cursor": { ... break; }
    // case "codex": { ... break; }

    default:
      // Unknown backend type — skip credential check
      break;
  }
}

// ---------------------------------------------------------------------------
// Git readiness check
// ---------------------------------------------------------------------------

/**
 * Ensure the working directory is a git repo with at least one commit
 * and the base branch exists. Handles four edge cases:
 *
 * 1. No git repo → git init + initial commit
 * 2. Git repo, no commits → initial commit
 * 3. Git repo, has commits, but base_branch missing → create it or use current
 * 4. Git repo, has commits, base_branch exists → no-op (happy path)
 *
 * Without this, worktree creation fails with "fatal: invalid reference: main"
 * when the repo has no commits, because the branch ref doesn't exist yet.
 */
export async function ensureGitReady(
  cwd: string,
  baseBranch: string,
  worktreesEnabled: boolean,
  commit?: { identity?: GitIdentity; style?: CommitStyle },
): Promise<void> {
  trace(`G01 ensureGitReady start cwd=${cwd}`);
  const { execFileSync } = await import("node:child_process");
  const stdio = ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"];
  const gitOpts = { cwd, encoding: "utf-8" as const, stdio };
  trace("G02 child_process imported, gitOpts ready");

  // Step 1: Check if git repo exists
  let isGitRepo = false;
  try {
    trace("G03 about to: git rev-parse --git-dir");
    execFileSync("git", ["rev-parse", "--git-dir"], gitOpts);
    isGitRepo = true;
    trace("G04 git rev-parse --git-dir succeeded");
  } catch { /* not a git repo */ trace("G04 git rev-parse --git-dir threw"); }

  if (!isGitRepo) {
    console.log(yellow("  No git repo found — initializing..."));
    execFileSync("git", ["init"], gitOpts);
    console.log(green("  Git repo initialized."));
  }

  // Step 2: Check if there are any commits
  let hasCommits = false;
  try {
    trace("G05 about to: git rev-parse HEAD");
    execFileSync("git", ["rev-parse", "HEAD"], gitOpts);
    hasCommits = true;
    trace("G06 git rev-parse HEAD succeeded (repo has commits)");
  } catch { /* no commits yet */ trace("G06 git rev-parse HEAD threw (no commits)"); }

  if (!hasCommits) {
    trace("G07 entering no-commits initialization block (likely NOT your case)");
    console.log(yellow("  No commits found — creating initial commit..."));

    // Ensure a .gitignore exists to prevent committing secrets.
    // If the project doesn't have one, create a minimal one with
    // common secret patterns before staging anything.
    const { existsSync: fileExists, writeFileSync: writeFs } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const gitignorePath = pathJoin(cwd, ".gitignore");
    if (!fileExists(gitignorePath)) {
      console.log(yellow("  No .gitignore found — creating one with secret exclusions..."));
      writeFs(gitignorePath, [
        "# Created by swarm — prevent accidental secret commits",
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        "*.p12",
        "*.pfx",
        "Secrets.xcconfig",
        "credentials.json",
        "service-account.json",
        "",
      ].join("\n"));
    }

    // Ensure git identity is configured (common issue in CI, Docker, fresh
    // machines) — unless source_control.git_identity supplies one.
    if (!commit?.identity) {
      try {
        execFileSync("git", ["config", "user.name"], gitOpts);
      } catch {
        console.log(yellow("  Git user.name not configured — setting default..."));
        execFileSync("git", ["config", "user.name", "swarm"], gitOpts);
        execFileSync("git", ["config", "user.email", "swarm@localhost"], gitOpts);
      }
    }

    // Stage files, show what's being committed, then commit
    execFileSync("git", ["add", "-A"], gitOpts);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], gitOpts).trim();

    if (staged) {
      const files = staged.split("\n");

      // Warn about any files that look like secrets despite .gitignore
      const suspiciousPatterns = [/\.env$/i, /\.pem$/i, /\.key$/i, /secret/i, /credential/i, /\.p12$/i, /\.pfx$/i];
      const suspicious = files.filter(f => suspiciousPatterns.some(p => p.test(f)));
      if (suspicious.length > 0) {
        console.log(yellow("  Warning: these staged files may contain secrets:"));
        for (const f of suspicious) {
          console.log(red(`    ${f}`));
        }
        console.log(yellow("  Add them to .gitignore if they contain sensitive data."));
        // Unstage suspicious files — use rm --cached since HEAD doesn't exist yet
        for (const f of suspicious) {
          try { execFileSync("git", ["rm", "--cached", f], gitOpts); } catch { /* may not be staged */ }
        }
        console.log(dim("  Suspicious files excluded from initial commit."));
      }

      // Show what's being committed
      const cleanFiles = files.filter(f => !suspicious.includes(f));
      if (cleanFiles.length > 0) {
        console.log(dim(`  Committing ${cleanFiles.length} file(s):`));
        for (const f of cleanFiles.slice(0, 10)) {
          console.log(dim(`    ${f}`));
        }
        if (cleanFiles.length > 10) {
          console.log(dim(`    ... and ${cleanFiles.length - 10} more`));
        }
      }
    }

    try {
      execFileSync("git", ["commit", "-m", initialCommitMessage(commit?.style), "--allow-empty"], {
        ...gitOpts,
        env: gitIdentityEnv(commit?.identity),
      });
      console.log(green("  Initial commit created."));
    } catch (commitErr) {
      const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      console.log(red(`  Could not create initial commit: ${msg}`));
      if (msg.includes("user.name") || msg.includes("user.email")) {
        console.log(red("  Git identity not configured. Run:"));
        console.log(red('    git config user.name "Your Name"'));
        console.log(red('    git config user.email "you@example.com"'));
      }
      if (worktreesEnabled) {
        console.log(red("  Worktrees require at least one commit."));
        process.exit(1);
      }
    }
  }

  // Step 3: Check if the base branch exists
  if (!worktreesEnabled) {
    trace("G08 worktrees disabled, ensureGitReady returning early");
    return;
  }

  let branchExists = false;
  try {
    trace(`G09 about to: git rev-parse --verify ${baseBranch}`);
    execFileSync("git", ["rev-parse", "--verify", baseBranch], gitOpts);
    branchExists = true;
    trace(`G10 base branch ${baseBranch} verified`);
  } catch { /* branch doesn't exist */ trace(`G10 git rev-parse --verify ${baseBranch} threw`); }

  if (!branchExists) {
    // Check what the current branch is
    let currentBranch = "";
    try {
      currentBranch = execFileSync("git", ["branch", "--show-current"], gitOpts).trim();
    } catch { /* detached HEAD or similar */ }

    if (currentBranch && currentBranch !== baseBranch) {
      // Current branch exists but doesn't match base_branch from config
      // Create the base branch pointing to the same commit
      console.log(yellow(`  Base branch "${baseBranch}" not found — creating from "${currentBranch}"...`));
      try {
        execFileSync("git", ["branch", baseBranch], gitOpts);
        console.log(green(`  Branch "${baseBranch}" created.`));
      } catch {
        console.log(yellow(`  Could not create "${baseBranch}" — using "${currentBranch}" as base.`));
      }
    } else if (!currentBranch) {
      // No current branch (detached HEAD) — try renaming to the base branch
      console.log(yellow(`  No branch found — renaming to "${baseBranch}"...`));
      try {
        execFileSync("git", ["checkout", "-b", baseBranch], gitOpts);
        console.log(green(`  Branch "${baseBranch}" created.`));
      } catch {
        console.log(red(`  Could not create branch "${baseBranch}". Worktrees may fail.`));
      }
    }
    // If currentBranch === baseBranch, the rev-parse should have succeeded,
    // but if we got here it means something odd — proceed and let worktree
    // creation surface the error with a clear message.
  }
  trace("G11 ensureGitReady end");
}

// ---------------------------------------------------------------------------
// Interactive prompt helper
// ---------------------------------------------------------------------------

async function promptUser(question: string, choices: string[]): Promise<string> {
  // Non-interactive environments (CI, piped input) — default to last choice (safest/abort)
  if (!process.stdin.isTTY) {
    console.warn(`[swarm] Non-interactive terminal detected. Defaulting to "${choices[choices.length - 1]}".`);
    return choices[choices.length - 1];
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choiceLabels = choices.map((c) => `  [${c[0].toUpperCase()}] ${c}`).join("\n");
    const answer = await rl.question(`\n${question}\n${choiceLabels}\n\nChoice: `);
    const normalized = answer.trim().toLowerCase();
    const match = choices.find((c) => c[0].toLowerCase() === normalized || c.toLowerCase() === normalized);
    return match ?? choices[choices.length - 1];
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Telemetry redaction
// ---------------------------------------------------------------------------

function redactToolPayload(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  if (!p.toolInput || typeof p.toolInput !== "object") return payload;
  const input = p.toolInput as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (key === "content" || key === "contents") {
      redacted[key] = typeof val === "string" ? `<${val.length} chars>` : val;
    } else if (typeof val === "string" && val.length > 200) {
      redacted[key] = val.slice(0, 200) + "...";
    } else {
      redacted[key] = val;
    }
  }
  return { ...p, toolInput: redacted };
}

// ---------------------------------------------------------------------------
// Event bus subscriber setup
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, string> = {
  read_file: "R",
  write_file: "W",
  list_directory: "L",
  run_command: ">",
};

/**
 * Walks a task's decomposition lineage from the leaf upward, stopping
 * at the root (parentTaskId === null) or when the chain bottoms out.
 * Returns the chain oldest-ancestor-first so consumers can render the
 * lineage as "root → … → leaf". Safe against cycles (rare but possible
 * after a botched re-decomposition) — caps depth at 32.
 */
async function walkTaskLineage(
  backend: import("@mnmal-ai/swarm-types").TaskBackend,
  taskId: string,
): Promise<LineageNode[]> {
  const chain: LineageNode[] = [];
  const seen = new Set<string>();
  let current: string | null = taskId;
  let depth = 0;
  while (current && depth < 32) {
    if (seen.has(current)) break;
    seen.add(current);
    const task = await backend.getTaskById(current);
    if (!task) {
      chain.push({ taskId: current, intent: null, description: null, parentTaskId: null });
      break;
    }
    chain.push({
      taskId: task.id,
      intent: task.intent ?? null,
      description: task.description ?? null,
      parentTaskId: task.parentTaskId ?? null,
    });
    current = task.parentTaskId ?? null;
    depth++;
  }
  // Reverse so the root is first (oldest-ancestor-first).
  chain.reverse();
  return chain;
}

/** Resolves the goalId for a task via the task backend. Returns null
 *  when the task isn't found (e.g., scratch ids during decomposition).
 *  Task interface uses `goal_id` (snake_case) per the public schema. */
async function resolveTaskGoalId(
  backend: import("@mnmal-ai/swarm-types").TaskBackend,
  taskId: string,
): Promise<string | null> {
  const task = await backend.getTaskById(taskId);
  return task?.goal_id ?? null;
}

function setupEventSubscribers(eventBus: SwarmEventBus, substrateClient?: SubstrateClient, projectConfig?: ProjectConfig, authorId?: string): void {
  eventBus.on("tool:start", (e) => {
    const icon = TOOL_ICONS[e.toolName] ?? "?";
    const detail = e.toolName === "read_file"
      ? String(e.toolInput.path ?? "")
      : e.toolName === "run_command"
        ? String(e.toolInput.command ?? "").slice(0, 60)
        : e.toolName === "write_file"
          ? String(e.toolInput.path ?? "")
          : e.toolName === "list_directory"
            ? String(e.toolInput.path ?? "")
            : JSON.stringify(e.toolInput).slice(0, 60);
    console.log(dim(`      [${icon}] ${e.toolName}: ${detail}`));
  });

  eventBus.on("tool:end", (e) => {
    if (e.isError) {
      console.log(red(`      [!] ${e.toolName} failed (${e.durationMs}ms): ${e.errorPreview ?? "unknown error"}`));
    } else if (e.durationMs > 5000) {
      console.log(dim(`      [.] ${e.toolName} completed (${formatDuration(e.durationMs)})`));
    }
  });

  eventBus.on("turn:end", (e) => {
    console.log(dim(`      turn ${e.turn + 1} | ${e.toolCallCount} tool calls | tokens: ${formatTokens(e.inputTokens)} in, ${formatTokens(e.outputTokens)} out`));
  });

  eventBus.on("oversight:start", (e) => {
    console.log(dim(`      reviewing (${e.role}: ${e.model})...`));
  });

  eventBus.on("oversight:verdict", (e) => {
    const color = e.verdict === "approved" ? green : e.verdict === "escalate" ? yellow : red;
    console.log(`${ts()}      oversight: ${color(e.verdict)} (${formatDuration(e.durationMs)})`);

    // Emit a reviewer SessionEvent to Substrate for timing breakdown
    if (substrateClient) {
      substrateClient.mutate("createSessionEvent", {
        eventId: `evt-review-${Date.now()}`,
        sessionId: e.sessionId ?? "",
        role: "reviewer",
        provider: "",
        modelId: projectConfig?.models?.reviewer ?? "claude-sonnet-4-6",
        intent: "",
        swarmFilesLoaded: "[]",
        // Numbers: these are field.number() fields, and Substrate refuses strings.
        contextTokensUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: e.durationMs ?? 0,
        authorId,
        timestamp: new Date().toISOString(),
      }, { id: true }).catch(() => {});
    }
  });

  eventBus.on("retry", (e) => {
    console.log(yellow(`      retry ${e.attempt}/${e.maxRetries}: ${e.reasons.join("; ")}`));
  });

  eventBus.on("session:start", (e) => {
    console.log(ts() + dim(` session ${e.sessionId.slice(-8)} started: ${e.role} (${e.model})`));
  });

  eventBus.on("intent:classified", (e) => {
    console.log(dim(`      intent: ${e.intent} (${e.confidence}) keywords: [${e.matchedKeywords.join(", ")}]`));
  });

  eventBus.on("context:loaded", (e) => {
    console.log(dim(`      swarm: ${e.files.length} files, ${e.totalTokens} tokens (${e.budgetUsedPercent.toFixed(1)}% of budget)`));
    // Defensive: an older client that didn't request `truncated` in its
    // field selection (or a substrate that doesn't return it) lands here with
    // e.truncated === undefined. The previous unguarded `.length` access
    // crashed every swarm.run during decomposition.
    if (e.truncated && e.truncated.length > 0) {
      console.log(yellow(`      truncated: ${e.truncated.join(", ")}`));
    }
  });

  eventBus.on("agent:role", (e) => {
    if (e.role !== "worker") {
      console.log(dim(`      agent role: ${e.role} (${e.model})`));
    }
  });

  eventBus.on("session:end", (e) => {
    const fnlLine = e.fnl ? describeFnlCoverage(e.fnl) : null;
    const docsLine = e.docs ? describeDocumentReads(e.docs) : null;
    console.log(
      ts() +
        dim(
          ` session done: ${e.totalTurns} turns, ${formatTokens(e.totalInputTokens + e.totalOutputTokens)} tokens${fnlLine ? ` · fnl: ${fnlLine}` : ""}${docsLine ? ` · docs: ${docsLine}` : ""}`,
        ),
    );
  });

  eventBus.on("skill:fetched", (e) => {
    console.log(dim(`      skill fetched: ${e.url.split("/").pop()} (${e.estimatedTokens} tokens, ${e.latencyMs}ms)`));
  });

  eventBus.on("skill:fetch_failed", (e) => {
    console.log(yellow(`      skill fetch failed: ${e.url} — ${e.error}`));
  });
}

// ---------------------------------------------------------------------------
// Default task fallback
// ---------------------------------------------------------------------------

function defaultTasks(goal: Goal): Task[] {
  return [
    { id: `${goal.id}-investigate`, goal_id: goal.id, description: `Investigate: ${goal.description}`, intent: "investigation", status: "pending" as const, order: 1 },
    { id: `${goal.id}-implement`, goal_id: goal.id, description: `Implement: ${goal.description}`, intent: "implementation", status: "pending" as const, order: 2 },
  ];
}

// ---------------------------------------------------------------------------
// Decomposition output parser (exported for testing)
// ---------------------------------------------------------------------------

export type DecompositionTaskEntry = {
  title?: string;
  description: string;
  intent: string;
  parallel?: boolean;
  creates?: string[];
  modifies?: string[];
};

/**
 * Parse LLM decomposition output. Supports:
 * - Object format: `{ "shared_files": [...], "tasks": [...] }`
 * - Legacy array format: `[{ title, description, ... }]`
 *
 * Returns null if no valid JSON found. Shared files are auto-injected
 * into each task's `modifies` array (deduplicated).
 */
/**
 * Map an oversight result to the task status that should be written to the backend.
 * Single source of truth used by the three dispatch loops in runOrchestrator.
 */
function computeTaskStatus(oversight: OversightResult): TaskStatus {
  if (oversight.humanEscalation) return "blocked";
  const { verdict } = oversight;
  if (verdict === "completed_with_notes") return "completed_with_notes";
  if (verdict === "completed_with_deferrals") return "completed_with_deferrals";
  return SUCCESS_VERDICTS.has(verdict) ? "completed" : "failed";
}

/**
 * Filter checkpoint task IDs, removing any belonging to reset goals.
 * Task IDs use the convention `${goalId}-task-N`, so we match by prefix.
 * Exported for testing.
 */
export function filterCheckpointTasks(taskIds: string[], resetGoalIds: string[]): string[] {
  return taskIds.filter(taskId =>
    !resetGoalIds.some(goalId => taskId.startsWith(`${goalId}-`))
  );
}

/**
 * Persist the goals manifest to disk. Exported for testing.
 * Non-fatal — swallows errors so in-memory status still works.
 */
export async function persistGoalStatus(goalsPath: string, manifest: GoalsManifest): Promise<boolean> {
  try {
    await writeFile(goalsPath, JSON.stringify(manifest, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Bug#2: reset failure-blocked goals to "pending" at run startup so a
 * subsequent `swarm run` re-attempts them.
 *
 * When iter-1 tasks all fail, the orchestrator persists status="blocked" to
 * goals.json (see the goal-completion block). Bug#3 then makes getExecutableGoals
 * hard-skip any goal still "blocked" at filter time — zero LLM calls. Those two
 * fixes together would strand a transiently-failed goal forever: it could never
 * be retried, even though "Re-run to retry" is the documented recovery path.
 *
 * A status="blocked" goal is indistinguishable, by status alone, from a
 * deliberately-blocked goal. `skipBlockedGoals` (project config
 * `skip_blocked_goals`) is the operator's opt-in to leave blocked goals alone:
 *   - false (default): each blocked goal is being re-attempted this run — reset
 *     it to "pending" so getExecutableGoals routes it to `executable` once its
 *     deps are satisfied, and a clean completion flips it to "completed".
 *   - true: deliberate-skip mode — no reset; the goal stays "blocked" and
 *     getExecutableGoals hard-skips it (Bug#3), firing one goal_blocked event.
 *
 * This is a one-time startup pass over disk-loaded state. Goals blocked *within*
 * the current session (recordSkippedGoals, or the goal-completion block on task
 * failure) are not re-reset, so a single run never retries a goal it just
 * blocked — the next `swarm run` is the re-attempt boundary.
 *
 * Mutates each reset goal's `status` in place (shared refs with the manifest)
 * and returns the ids that were reset so the caller can log and persist.
 * Exported for testing.
 */
export function resetBlockedGoalsForRetry(goals: Goal[], skipBlockedGoals: boolean): string[] {
  if (skipBlockedGoals) return [];
  const reset: string[] = [];
  for (const goal of goals) {
    if (goal.status === "blocked") {
      goal.status = "pending";
      reset.push(goal.id);
    }
  }
  return reset;
}

/**
 * Bug#2 (b): determine a goal's terminal status from THIS run's task outcomes
 * alone — never from its prior persisted status. This is what makes the
 * write-back idempotent: a goal that was "blocked" last run flips to
 * "completed" the moment all its tasks complete, with no special-casing of the
 * prior state. A goal with zero completed tasks, or only some completed, stays
 * "blocked" so getExecutableGoals does not unblock its dependents.
 * Exported for testing.
 */
export function determineGoalStatus(goalCompletedCount: number, totalTaskCount: number): "blocked" | "completed" {
  if (goalCompletedCount === 0 && totalTaskCount > 0) return "blocked";
  if (goalCompletedCount < totalTaskCount) return "blocked";
  return "completed";
}

export type { CompletedGoalRef, UnstackedGoalRef } from "./goal-stack.js";

/**
 * The subset of {@link SourceControlManager} the stacked-PR push step depends
 * on. Declared structurally so the wiring is unit-testable against a stub that
 * records `gh`/`git` calls without touching the network.
 */
export interface StackedPrManager {
  onGoalComplete(goals: CompletedGoalRef[]): Promise<{
    pushed: boolean;
    prUrl?: string;
    goals: Array<{ goalId: string; branch: string; base: string; pushed: boolean; prUrl?: string }>;
  }>;
  restoreBaseBranch(): Promise<void>;
}

/**
 * Bug#1: route ALL completed goals — not just the last — through the
 * SourceControlManager's per-goal push+PR loop.
 *
 * The pre-fix orchestrator delegated PR creation to the worker via
 * SWARM_GOAL_BRANCH/SWARM_BASE_BRANCH, which reliably produced exactly one PR
 * per session: every other completed goal's branch was committed locally but
 * never pushed-and-PR'd. This hands the full ordered list of completed goals to
 * `onGoalComplete`, whose loop pushes each goal's branch and opens one stacked
 * PR per goal (goal N's base = goal N-1's head). A 3-goal stack yields 3 PRs.
 *
 * Gated on stack_prs + remote_pr; returns `null` (a pure no-op, no git/gh
 * touched) for every other strategy so non-stack / non-remote_pr runs are
 * byte-identical to before. Also a no-op when no goal completed this run.
 *
 * No session branch is made and nothing is checked out before the push: each
 * goal's branch is pushed by name, so a working tree a failed task left dirty
 * cannot block it (creating a session branch used to `git checkout -b`, which
 * such a tree refused, and the whole stack stayed local). The base branch is
 * restored afterward, best effort, so the repo is left on a deterministic
 * ref. Exported for testing.
 */
export async function pushCompletedGoalStack(
  manager: StackedPrManager,
  completedGoals: CompletedGoalRef[],
  opts: { stackPRs: boolean; strategy: string | undefined; sessionId: string },
): Promise<Awaited<ReturnType<StackedPrManager["onGoalComplete"]>> | null> {
  if (!opts.stackPRs || opts.strategy !== "remote_pr") return null;
  if (completedGoals.length === 0) return null;

  const result = await manager.onGoalComplete(completedGoals);
  await manager.restoreBaseBranch();
  return result;
}

/**
 * Reporting hooks for {@link runStackedPrPushStep}. Kept as injectable
 * callbacks so the console coloring stays at the call site and the error
 * isolation is unit-testable without capturing stdout.
 */
export interface StackedPrPushLogger {
  /** Invoked with the push result on success (`null` when the step no-ops). */
  onResult?(result: Awaited<ReturnType<StackedPrManager["onGoalComplete"]>> | null): void;
  /** Invoked when constructing the manager or the push/PR loop throws. The
   *  error is logged then SWALLOWED — never re-thrown. */
  onError?(err: unknown, completedCount: number): void;
  /** Invoked with the completed goals that could not be stacked (no goal
   *  branch), so they are reported instead of silently left unpushed. */
  onUnstacked?(goals: UnstackedGoalRef[]): void;
}

/**
 * Console lines for completed goals the stacked-PR step could not push: names
 * each goal and the branch its commits are on. Exported for testing.
 */
export function formatUnstackedGoalsWarning(goals: UnstackedGoalRef[]): string[] {
  const lines = [
    `Stacked PRs: ${goals.length} completed goal(s) were not stacked, so no branch was pushed and no PR opened for them:`,
  ];
  for (const g of goals) {
    const where = g.commitCount === 0
      ? "no commits"
      : `${g.commitCount} commit(s) on '${g.commitsOn ?? "an unknown branch"}'`;
    lines.push(`  ${g.goalId} "${g.goalDescription}": ${where}`);
  }
  lines.push("  Their commits are local only. Move them onto a branch and open the PR by hand, or re-run the goal.");
  return lines;
}

/** "6m" or "45s" for a wait. */
function waitText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/** ", 2 rounds, waited 6m, conflict resolved by a worker" — only the parts that happened. */
function mergeExtras(r: MergeGoalResult): string {
  const parts: string[] = [];
  if ((r.rounds ?? 1) > 1) parts.push(`${r.rounds} rounds`);
  if ((r.waitedMs ?? 0) >= 5_000) parts.push(`waited ${waitText(r.waitedMs!)}`);
  if (r.conflictsResolved) parts.push(r.conflictsResolved === 1 ? "conflict resolved by a worker" : `${r.conflictsResolved} conflicts resolved by a worker`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

/** Console lines for one goal's merge-as-you-go outcome. Exported for testing. */
export function formatMergeOutcome(r: MergeGoalResult): string[] {
  const lines: string[] = [];
  if (r.gate) {
    const took = `${Math.round(r.gate.durationMs / 1000)}s`;
    lines.push(r.gate.passed ? green(`    Merge gate passed (${took})`) : red(`    Merge gate ${r.gate.timedOut ? "timed out" : "failed"} (${took})`));
    if (!r.gate.passed && r.gate.tail) for (const l of r.gate.tail.split("\n")) lines.push(dim(`      ${l}`));
  }
  if (r.merged) {
    lines.push(green(`    Merged ${r.prUrl ?? r.branch} into ${r.base}${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 12)})` : ""}${mergeExtras(r)}`));
  } else {
    lines.push(yellow(`    Left open ${r.prUrl ?? `(no PR) ${r.branch}`}: ${r.reason ?? "unknown reason"}`));
    if (r.error) lines.push(dim(`      ${r.error}`));
  }
  if (r.queueWarning) lines.push(yellow(`    ⚠ ${r.queueWarning}`));
  return lines;
}

/** A task:verdict event's reviewer lists: what it left for a person and the
 *  deviations it accepted, each only when there are any. Exported for testing. */
export function verdictDetail(oversight: OversightResult): { deferred?: string[]; notes?: string[] } {
  return {
    ...(oversight.deferred?.length ? { deferred: oversight.deferred } : {}),
    ...(oversight.notes?.length ? { notes: oversight.notes } : {}),
  };
}

/**
 * The end-of-run lines for what reviewers left for a person: the total, then
 * each goal's count (by its short label when it has one). Nothing when no
 * goal has any. Exported for testing.
 */
export function formatLeftForPersonSummary(
  byGoal: ReadonlyMap<string, readonly LeftForPersonGroup[]>,
  labels?: ReadonlyMap<string, string>,
): string[] {
  const goals = [...byGoal].filter(([, groups]) => countLeftForPerson([...groups]) > 0);
  if (goals.length === 0) return [];
  const total = goals.reduce((n, [, groups]) => n + countLeftForPerson([...groups]), 0);
  const lines = [`Left for a person: ${total} item${total === 1 ? "" : "s"} in ${goals.length} goal${goals.length === 1 ? "" : "s"} (listed on each goal's pull request)`];
  for (const [goalId, groups] of goals) {
    const n = countLeftForPerson([...groups]);
    lines.push(`  ${labels?.get(goalId) ?? goalId}: ${n} item${n === 1 ? "" : "s"}`);
  }
  return lines;
}

/** The end-of-run merge-as-you-go summary. Exported for testing. */
export function formatMergeSummary(outcomes: MergeGoalResult[]): string[] {
  const merged = outcomes.filter((o) => o.merged);
  const open = outcomes.filter((o) => !o.merged);
  const lines = [bold(`  Merge-as-you-go: merged ${merged.length}, left open ${open.length}`)];
  const waited = outcomes.reduce((n, o) => n + (o.waitedMs ?? 0), 0);
  const extraRounds = outcomes.reduce((n, o) => n + Math.max(0, (o.rounds ?? 1) - 1), 0);
  const resolved = outcomes.reduce((n, o) => n + (o.conflictsResolved ?? 0), 0);
  if (waited >= 5_000 || extraRounds > 0 || resolved > 0) {
    lines.push(dim(`    waited ${waitText(waited)} for the merge turn · ${extraRounds} extra round${extraRounds === 1 ? "" : "s"} · ${resolved} conflict${resolved === 1 ? "" : "s"} resolved by a worker`));
  }
  for (const o of merged) lines.push(dim(`    merged   ${o.goalId}: ${o.prUrl ?? o.branch}`));
  for (const o of open) lines.push(dim(`    open     ${o.goalId}: ${o.prUrl ?? o.branch} (${o.reason ?? "unknown reason"})`));
  return lines;
}

/**
 * Bug#4 (call-site error isolation): run the stacked-PR push step with TOTAL
 * error isolation so nothing in it can short-circuit the run-summary capture
 * that fires later at session_end.
 *
 * The capture (`captureRunObservation`) lives further down the linear
 * session-end path, not in a finally — so any throw between the goal loop and
 * the capture silently drops `learned/runs/<runId>.md` (observed for run-id
 * 3dcd7f). Two parts of this step can throw: constructing the
 * SourceControlManager (bad repo / git state) and the push+PR loop itself (a
 * half-pushed stack trips the wedge guards inside onGoalComplete). Both are
 * wrapped here, logged via `logger.onError`, and swallowed, so the downstream
 * capture is GUARANTEED to run on a successful session regardless of the push
 * outcome.
 *
 * Gating mirrors {@link pushCompletedGoalStack}: a pure no-op (the manager
 * factory is never invoked, no git/gh touched) unless stack_prs + remote_pr
 * with at least one completed goal. Exported for testing.
 */
export async function runStackedPrPushStep(
  makeManager: () => StackedPrManager,
  completedGoals: CompletedGoalRef[],
  opts: {
    stackPRs: boolean;
    strategy: string | undefined;
    sessionId: string;
    /** Completed goals with no goal branch; reported via logger.onUnstacked. */
    unstackedGoals?: UnstackedGoalRef[];
  },
  logger?: StackedPrPushLogger,
): Promise<Awaited<ReturnType<StackedPrManager["onGoalComplete"]>> | null> {
  if (!opts.stackPRs || opts.strategy !== "remote_pr") return null;
  // Never silent: a completed goal that could not be stacked gets no PR, so
  // say so, naming it and where its commits are.
  if (opts.unstackedGoals && opts.unstackedGoals.length > 0) {
    logger?.onUnstacked?.(opts.unstackedGoals);
  }
  if (completedGoals.length === 0) return null;

  try {
    // Construction is INSIDE the try on purpose: a throwing SourceControlManager
    // ctor must not escape and skip the capture below.
    const manager = makeManager();
    const result = await pushCompletedGoalStack(manager, completedGoals, opts);
    logger?.onResult?.(result);
    return result;
  } catch (err) {
    // A half-pushed stack throws from the wedge guards inside onGoalComplete.
    // Surface it loudly; the completed branches remain local for a re-run.
    // Crucially, swallow it: the session-end capture must still fire.
    logger?.onError?.(err, completedGoals.length);
    return null;
  }
}

/**
 * Emit a `goal_blocked` event for every goal getExecutableGoals() placed in its
 * `skipped` list, using that goal's one-line skip reason (from `skipReasons`)
 * as the event message.
 *
 * Each skipped goal is marked processed (added to `processedGoalIds`) and
 * flipped to status="blocked" so the dispatch loop never selects it — a skipped
 * goal reaches neither decomposition nor worker dispatch, costing zero LLM
 * calls. Bug#3: a goal whose own status is already "blocked" lands in `skipped`
 * regardless of its dependency state and is short-circuited here; bug#26: a
 * goal whose dependency failed lands here under skip_blocked_goals.
 *
 * Returns the Ship Readiness outcome rows for the newly-skipped goals so the
 * caller can surface them in the run summary. Idempotent per goal: a goal
 * already in `processedGoalIds` is ignored, so no duplicate event fires.
 * Exported for testing.
 */
export function recordSkippedGoals(
  skippedGoals: Goal[],
  skipReasons: Record<string, string>,
  processedGoalIds: Set<string>,
  recordEvent: (type: "goal_blocked", message: string, meta: { goal_id: string }) => void,
  log: (line: string) => void = (line) => console.log(line),
): Array<{ goalId: string; applied: false; status: "skipped"; detail: string }> {
  const outcomes: Array<{ goalId: string; applied: false; status: "skipped"; detail: string }> = [];
  for (const goal of skippedGoals) {
    if (processedGoalIds.has(goal.id)) continue;
    processedGoalIds.add(goal.id);
    // A skipped goal is terminal for this session: mark it blocked so the
    // in-memory manifest reflects the skip and the dispatch loop's
    // executable-goal filter never reconsiders it.
    goal.status = "blocked" as const;
    const reason = skipReasons[goal.id] ?? "skipped";
    log(yellow(`  Skipping goal (${reason}): ${goal.description}`));
    log(dim(`  [${goal.id}]`));
    log("");
    recordEvent("goal_blocked", reason, { goal_id: goal.id });
    outcomes.push({ goalId: goal.id, applied: false, status: "skipped", detail: reason });
  }
  return outcomes;
}

export function parseDecompositionOutput(output: string): { tasks: DecompositionTaskEntry[]; sharedFiles: string[] } | null {
  // Extract JSON — try object format first, fall back to array
  let jsonStr: string | null = null;
  const objIdx = output.indexOf("{");
  const arrIdx = output.indexOf("[");

  const startIdx = objIdx !== -1 && (arrIdx === -1 || objIdx < arrIdx) ? objIdx : arrIdx;
  if (startIdx === -1) return null;

  const openChar = startIdx === objIdx ? "{" : "[";
  const closeChar = openChar === "{" ? "}" : "]";

  let depth = 0;
  for (let i = startIdx; i < output.length; i++) {
    if (output[i] === openChar) depth++;
    if (output[i] === closeChar) depth--;
    if (depth === 0) {
      jsonStr = output.slice(startIdx, i + 1);
      break;
    }
  }

  if (!jsonStr) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  let sharedFiles: string[] = [];
  let parsed: DecompositionTaskEntry[];

  if (Array.isArray(raw)) {
    parsed = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).tasks)) {
    const obj = raw as Record<string, unknown>;
    parsed = obj.tasks as DecompositionTaskEntry[];
    if (Array.isArray(obj.shared_files)) {
      sharedFiles = (obj.shared_files as unknown[]).filter((f): f is string => typeof f === "string");
    }
  } else {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const validTasks = parsed.filter(t => t.description && typeof t.description === "string");
  if (validTasks.length === 0) return null;

  // Auto-inject shared_files into each task's modifies (deduplicated)
  if (sharedFiles.length > 0) {
    for (const t of validTasks) {
      const existing = new Set(Array.isArray(t.modifies) ? t.modifies : []);
      for (const sf of sharedFiles) {
        existing.add(sf);
      }
      t.modifies = [...existing];
    }
  }

  return { tasks: validTasks, sharedFiles };
}

/**
 * The banner's Push row: what swarm run will actually push at session end.
 * The only push step is the stacked-PR loop (runStackedPrPushStep), gated on
 * remote_pr + stack_prs; autonomy.merge.push_to_remote is not read by
 * anything, so it must not decide this row. Exported for testing.
 */
export function describePushBehaviour(sourceControl: SourceControlConfig | undefined): string {
  if (sourceControl?.strategy !== "remote_pr") return "off";
  if (sourceControl.merge_prs?.enabled === true) return "on (merge-as-you-go: each done goal's PR merges when its gate passes)";
  if (sourceControl.stack_prs !== true) return "off (remote_pr pushes only with stack_prs)";
  if (sourceControl.auto_push === false) return "off (auto_push is false)";
  if (sourceControl.pr_on_goal_complete === false) return "on (stacked branches, no PRs)";
  return "on (stacked PRs)";
}

/**
 * Fail fast on a malformed source_control.git_identity / commit_style /
 * github_account, before any work starts, with every problem and the config
 * file named. Exported for testing.
 */
export function assertValidSourceControlConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateSourceControlConfig(projectConfig.source_control);
  if (errors.length === 0) return;
  throw new Error(`Invalid source_control in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

/**
 * The decomposition prompt's guidance for task titles, which become commit
 * subjects. With commit_style "conventional" it asks for Conventional Commit
 * subjects so commits need no `chore(swarm):` fallback. Exported for testing.
 */
export function decompositionTitleGuidance(style: CommitStyle | undefined): {
  instruction: string;
  exampleTitles: [string, string];
} {
  if (style === "conventional") {
    return {
      instruction:
        `For each task, provide a short "title" that is a Conventional Commit subject, "type(scope): summary" ` +
        `(under 60 chars; type is one of feat, fix, refactor, test, docs, chore, perf, build, ci, style; ` +
        `lower-case summary, no trailing period), and a longer "description" that explains what to do.`,
      exampleTitles: ["feat(api): add the export endpoint", "test(api): cover export edge cases"],
    };
  }
  return {
    instruction: `For each task, provide a short "title" (under 60 chars, like a commit subject) and a longer "description" that explains what to do.`,
    exampleTitles: ["Short task title", "Another task title"],
  };
}

// ---------------------------------------------------------------------------
// LLM-driven task decomposition
// ---------------------------------------------------------------------------

/**
 * Ask the planner to break a goal into tasks. With `maxTasks`, the prompt
 * asks for at most that many; the cap is enforced afterwards by
 * applyPlannerCap, since the planner may not keep to it. Exported for testing.
 */
export async function decomposeGoal(
  swarm: Swarm,
  goal: Goal,
  projectName: string,
  repoRoot: string,
  priorGoalsContext?: string,
  claimFeedback?: { accuracy: number; missedFiles: string[] },
  swarmPath?: string,
  commitStyle?: CommitStyle,
  maxTasks?: number,
): Promise<{ tasks: Task[]; createsMap: Map<string, string[]> }> {
  const titleGuidance = decompositionTitleGuidance(commitStyle);
  const taskCapInstruction = plannerTaskCapInstruction(maxTasks);
  // Load design references for this goal
  let designContext = "";
  if (goal.designs && goal.designs.length > 0 && swarmPath) {
    const designFiles: string[] = [];
    for (const designPath of goal.designs) {
      const fullPath = resolve(join(swarmPath, designPath));
      // Prevent path traversal — design files must stay within the swarm directory
      if (!fullPath.startsWith(resolve(swarmPath) + "/")) {
        continue; // skip paths that escape the swarm directory
      }
      if (existsSync(fullPath)) {
        const ext = designPath.split(".").pop()?.toLowerCase();
        if (ext === "md") {
          // Mermaid or text — include inline
          designFiles.push(`--- ${designPath} ---\n${readFileSync(fullPath, "utf-8")}`);
        } else if (ext === "url") {
          // Figma URL — include the URL
          designFiles.push(`--- ${designPath} ---\nFigma URL: ${readFileSync(fullPath, "utf-8").trim()}`);
        } else {
          // Image — instruct the agent to view the file visually before working
          designFiles.push(`--- ${designPath} ---\n[Design image: ${designPath}]\nIMPORTANT: View this image file before starting work. Study what it shows and incorporate it into your implementation.`);
        }
      }
    }
    if (designFiles.length > 0) {
      designContext = "\n\n## Design References\n\n" + designFiles.join("\n\n");
    }
  }

  // Run an investigation to understand the goal scope
  const investigationResult = await swarm.run(
    `Analyze this goal and break it down into specific, actionable implementation tasks.`,
    {
      input: [
        ...(priorGoalsContext ? [priorGoalsContext, ""] : []),
        ...formatGoalBrief(goal, designContext),
        "",
        `## Instructions`,
        `Explore the project codebase to understand the current state.`,
        `Then output a JSON object containing a "shared_files" array and a "tasks" array. Each task should be a specific, concrete action.`,
        ...(taskCapInstruction ? [taskCapInstruction] : []),
        titleGuidance.instruction,
        `Order them by dependency — tasks that must happen first should come first.`,
        `Mark independent tasks with "parallel": true.`,
        "",
        `For each task, declare ALL files it will touch — including secondary files:`,
        `- "creates": files this task will create that do not exist yet. Use full relative paths from the project root.`,
        `- "modifies": existing files this task will need to change. Use full relative paths from the project root.`,
        `This is used to detect conflicts between parallel tasks. When unsure whether a task will modify a file, include it in "modifies" — over-declaring is safe (slower but prevents conflicts), under-declaring risks expensive merge conflicts.`,
        "",
        `CRITICAL: Most merge conflicts happen on shared files that tasks touch as side effects. For EVERY task, think about:`,
        `- Route/endpoint registration files (e.g., routes/index.ts, app.ts)`,
        `- Barrel/index exports (e.g., src/index.ts, models/index.ts)`,
        `- Config files (e.g., package.json, tsconfig.json)`,
        `- Middleware chains, validation schemas, shared type definitions`,
        `- Dependency manifests, app entry points`,
        `If a task creates a new file, it almost certainly also modifies an index/barrel file to export it.`,
        "",
        ...(claimFeedback && claimFeedback.accuracy < 0.5 ? [
          `## File Intent Accuracy Warning`,
          `Previous goals in this session had ${(claimFeedback.accuracy * 100).toFixed(0)}% claim accuracy.`,
          `Files that were modified but NOT declared: ${claimFeedback.missedFiles.slice(0, 10).join(", ")}`,
          `Be especially careful to declare these kinds of files in your file intents.`,
          "",
        ] : []),
        `Also identify "shared_files" — files that MULTIPLE tasks will need to modify. These will be auto-injected into each task's "modifies" to prevent conflicts.`,
        "",
        `## CRITICAL — Output Format`,
        `You may explore the codebase first (list directories, read files) to understand the project structure.`,
        `After exploring, your FINAL response MUST be ONLY a JSON object — no prose, no markdown, no explanation before or after the JSON.`,
        `The JSON will be machine-parsed. Any text outside the JSON will cause a parse failure.`,
        "",
        `Required JSON format:`,
        "```json",
        `{`,
        `  "shared_files": ["src/routes/index.ts", "src/app.ts"],`,
        `  "tasks": [`,
        `    { "title": "${titleGuidance.exampleTitles[0]}", "description": "Detailed explanation of what to do and why", "intent": "investigation|implementation|code-review", "parallel": false, "creates": ["src/new-file.ts"], "modifies": ["src/index.ts"] },`,
        `    { "title": "${titleGuidance.exampleTitles[1]}", "description": "Detailed steps for this task", "intent": "implementation", "parallel": true, "creates": [], "modifies": ["src/index.ts", "src/routes/index.ts"] }`,
        `  ]`,
        `}`,
        "```",
      ].join("\n"),
      project: projectName,
      intentOverride: "orchestration",
      workingDirectory: repoRoot,
    },
  );

  const parseResult = parseDecompositionOutput(investigationResult.output);
  if (!parseResult) {
    console.log(dim(`      (Could not parse task decomposition — using default tasks)`));
    if (process.env.SWARM_DEBUG) {
      const outputPreview = investigationResult.output?.trim()
        ? investigationResult.output.trim().substring(0, 200)
        : "(empty output)";
      console.log(dim(`      Output preview: ${outputPreview}`));
    }
    return { tasks: defaultTasks(goal), createsMap: new Map() };
  }

  const { tasks: validTasks, sharedFiles } = parseResult;
  if (sharedFiles.length > 0) {
    console.log(dim(`      (${sharedFiles.length} shared files identified: ${sharedFiles.join(", ")})`));
  }

  const tasks = validTasks.map((t, i) => ({
    id: `${goal.id}-task-${i + 1}`,
    goal_id: goal.id,
    title: t.title,
    description: t.description,
    intent: t.intent || "implementation",
    status: "pending" as const,
    order: i + 1,
    serializedFiles: Array.isArray(t.modifies) ? [...t.modifies] : undefined,
  }));
  const createsMap = new Map<string, string[]>();
  validTasks.forEach((t, i) => {
    if (Array.isArray(t.creates) && t.creates.length > 0) {
      createsMap.set(`${goal.id}-task-${i + 1}`, t.creates);
    }
  });
  return { tasks, createsMap };
}

// ---------------------------------------------------------------------------
// LLM-driven remediation decomposition
// ---------------------------------------------------------------------------

async function decomposeRemediation(
  swarm: Swarm,
  goal: Goal,
  projectName: string,
  failedTaskIds: string[],
  tasks: Task[],
  iterationNumber: number,
  repoRoot: string,
): Promise<Task[]> {
  const failedTasks = tasks.filter(t => failedTaskIds.includes(t.id));
  const failureSummary = failedTasks
    .map(t => `- ${t.title ?? t.description}: <task_output>${t.result?.output?.slice(0, 200) ?? "no output"}</task_output>`)
    .join("\n");

  const result = await swarm.run(
    `Create remediation tasks to fix validation failures for this goal.`,
    {
      input: [
        `## Goal: ${goal.description}`,
        "",
        `## Acceptance Criteria`,
        ...goal.acceptance_criteria.map(c => `- ${c}`),
        "",
        `## Failed Tasks`,
        failureSummary,
        "",
        `## Instructions`,
        `This is remediation iteration ${iterationNumber}.`,
        `Analyze what went wrong and create targeted fix tasks.`,
        `Do NOT re-do work that already succeeded. Only fix what failed.`,
        `The LAST task must be a validation task that runs the project's definition-of-done checks.`,
        "",
        `For each task, declare which files it will touch:`,
        `- "creates": new files. "modifies": existing files to change. Use relative paths.`,
        `When unsure, include the file in "modifies".`,
        "",
        `Output ONLY a JSON array:`,
        "```json",
        `[{ "title": "...", "description": "...", "intent": "implementation", "parallel": false, "creates": [], "modifies": ["src/file.ts"] }]`,
        "```",
      ].join("\n"),
      project: projectName,
      intentOverride: "orchestration",
      workingDirectory: repoRoot,
    },
  );

  // Extract the first JSON array from the output using balanced bracket matching
  let jsonStr: string | null = null;
  const startIdx = result.output.indexOf("[");
  if (startIdx !== -1) {
    let depth = 0;
    for (let i = startIdx; i < result.output.length; i++) {
      if (result.output[i] === "[") depth++;
      if (result.output[i] === "]") depth--;
      if (depth === 0) {
        jsonStr = result.output.slice(startIdx, i + 1);
        break;
      }
    }
  }

  if (!jsonStr) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonStr) as Array<{ title?: string; description: string; intent: string; parallel?: boolean; creates?: string[]; modifies?: string[] }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    const validTasks = parsed.filter(t => t.description && typeof t.description === "string");

    return validTasks.map((t, i) => ({
      id: `${goal.id}-remediate-${iterationNumber}-task-${i + 1}`,
      goal_id: goal.id,
      title: t.title,
      description: t.description,
      intent: t.intent || "implementation",
      status: "pending" as const,
      order: i + 1,
      serializedFiles: Array.isArray(t.modifies) ? [...t.modifies] : undefined,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

export async function runOrchestrator(args: Record<string, string>, substrateClient?: any, _queryClient?: import("@mnmal-ai/swarm-substrate").SwarmQueryClient): Promise<void> {
  const startTime = Date.now();
  // The session's tokens split into fresh input, cache reads, cache writes and
  // output, for the live dashboard's tokens:update payloads and the end-of-run
  // summary. The budget checks read the orchestrator's total, which counts
  // the same work: the sequential paths charge both through chargeSession,
  // and the parallel pool adds each pooled result inside dispatchParallel.
  let sessionTokens = emptyTokenBreakdown();

  // -------------------------------------------------------------------------
  // 1. Resolve paths
  // -------------------------------------------------------------------------

  const swarmPath = args["swarm-path"]
    ? resolve(args["swarm-path"])
    : discoverSwarmPath();

  const { resolveProjectName } = await import("./swarm-meta.js");
  const projectName = resolveProjectName(swarmPath, args["project"]);
  if (!projectName || projectName === "global") {
    console.error(`\n  ${red("Error:")} --project is required, and could not be inferred from .swarm-meta.json or .swarm/domains/.`);
    console.error(`  Usage: swarm run --project <name> [--swarm-path <path>]\n`);
    process.exit(1);
  }

  const runId = `run-${projectName}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;

  // One run per project at a time: a second `swarm run` on the same .swarm
  // would fight the first over the work repo, the dashboard port and the
  // checkpoint. The lock names the live process and goes with it.
  let releaseRunLock: () => void = () => {};
  try {
    releaseRunLock = acquireRunLock(swarmPath, runId);
  } catch (err) {
    if (err instanceof RunPrepError) {
      console.error(`\n  ${red("Error:")} ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", () => releaseRunLock());

  // Resolve the author identity ONCE per session (env USER > git user.email >
  // anonymous). Threaded into every telemetry write path so each row carries it
  // for future per-engineer reporting — taxonomy now, enforcement deferred.
  // Never re-resolved per task.
  const authorId = resolveAuthorId();

  // -------------------------------------------------------------------------
  // 2. Load project config
  // -------------------------------------------------------------------------

  const domainDir = join(swarmPath, "domains", projectName);
  const configPath = join(domainDir, "config.json");

  if (!existsSync(configPath)) {
    console.error("");
    console.error(`  ${red("Error:")} No project config found at: ${configPath}`);
    console.error("");
    console.error(`  Run ${cyan("swarm init")} first to set up your project.`);
    console.error("");
    process.exit(1);
  }

  const configRaw = await readFile(configPath, "utf-8");
  const projectConfig: ProjectConfig = JSON.parse(configRaw);
  assertValidBudgetConfig(projectConfig, configPath);
  assertValidSourceControlConfig(projectConfig, configPath);
  assertValidDecompositionConfig(projectConfig, configPath);
  assertValidFnlConfig(projectConfig, configPath);
  assertValidContextConfig(projectConfig, configPath);
  assertValidLabelsConfig(projectConfig, configPath);
  assertValidRunPrepConfig(projectConfig, configPath);

  // Complexity thresholds from the swarm's swarm.json (defaults when it has no
  // complexity section). Loaded here so a bad section stops the run before any
  // work starts.
  const loadedComplexityThresholds = loadComplexityThresholds(swarmPath);
  const complexityThresholds = loadedComplexityThresholds.thresholds;

  // Derive the full autonomy matrix from project config (explicit or preset).
  const autonomy = deriveAutonomy(projectConfig);

  // The project's decomposition policy (a goal's swarm_split label can
  // override it; see effectiveDecomposition in the goal loop).
  const projectDecomposition = effectiveDecomposition(projectConfig.decomposition, undefined, autonomy);

  // Resolve the work repo, decoupled from process.cwd():
  // --repo-path flag > config.repo_root > config.project_root > cwd.
  // Defaulting to cwd preserves the original single-repo behavior.
  const repoRoot = resolveRepoRoot(args, projectConfig, process.cwd());
  assertGitRepo(repoRoot);
  if (repoRoot !== process.cwd() && args["quiet"] !== "true") {
    console.log(`  ${dim("Work repo")}      ${dim(repoRoot)}`);
  }

  // The work repo as the run needs it, before anything reads it: the base
  // branch current with the remote (source_control.sync_base_branch), then the
  // project's own setup (setup_command). Either one refusing stops the run.
  const baseBranch = projectConfig.base_branch ?? "main";
  let baseSync: BaseSyncResult | undefined;
  try {
    if (projectConfig.source_control?.sync_base_branch) {
      const remote = projectConfig.source_control.remote ?? "origin";
      // swarm's own directory, when it is inside the work repo, is not dirt.
      baseSync = syncBaseBranch(repoRoot, remote, baseBranch, [swarmPath]);
      if (args["quiet"] !== "true") {
        const moved = baseSync.commits === 0
          ? "already current"
          : `fast-forwarded ${baseSync.commits} commit${baseSync.commits === 1 ? "" : "s"} to ${baseSync.after.slice(0, 7)}`;
        console.log(`  ${dim("Base branch")}    ${dim(`${baseBranch} ← ${remote}: ${moved}`)}`);
      }
    }
    if (projectConfig.setup_command) {
      if (args["quiet"] !== "true") console.log(`  ${dim("Setup")}          ${dim(projectConfig.setup_command)}`);
      await runSetupCommand(repoRoot, projectConfig.setup_command);
    }
  } catch (err) {
    if (err instanceof RunPrepError) {
      console.error(`\n  ${red("Error:")} ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // The GitHub account swarm's own GitHub operations run as. With
  // source_control.github_account set, its token is resolved from gh once,
  // here, and checked (account, repo visibility, noreply email) before any
  // work — a failed check stops the run. The credential holds the token in
  // memory and goes only to swarm's own gh/git calls below, never to
  // process.env. Without the setting, gh's active account is used as before
  // and the banner names it. Also warns when gh's major version is untested.
  const githubAccess = await prepareGitHubAccess(projectConfig, repoRoot);
  for (const warning of githubAccess.warnings) console.log(yellow(`  ⚠ ${warning}`));
  if (!githubAccess.ok) {
    console.error("");
    console.error(`  ${red("Error:")} ${githubAccess.error}`);
    console.error(`  ${dim(`(source_control.github_account in ${configPath})`)}`);
    console.error("");
    process.exit(1);
  }
  const githubCredential = githubAccess.credential;

  // -------------------------------------------------------------------------
  // 3. Load goals
  // -------------------------------------------------------------------------

  const goalsPath = join(domainDir, "goals.json");

  // Determine the effective task backend config.
  const effectiveBackendType = projectConfig.taskBackendConfig?.type ?? projectConfig.task_backend;
  const effectiveRepo = projectConfig.taskBackendConfig?.repo;
  const effectiveCreateTasks = projectConfig.taskBackendConfig?.createTasks ?? false;

  let goals: Goal[];
  let goalsManifest: GoalsManifest;
  let githubSource: GitHubExternalSource | undefined;
  let trelloSource: TrelloExternalSource | undefined;

  if (effectiveBackendType === "github") {
    // -----------------------------------------------------------------------
    // GitHub Issues as task source — bootstrap sync
    // -----------------------------------------------------------------------
    console.log("");
    console.log(`  ${cyan("GitHub Issues")} backend — fetching goals from ${effectiveRepo || "auto-detected repo"}...`);

    githubSource = new GitHubExternalSource({ repo: effectiveRepo, credential: githubCredential });
    const githubGoals = await githubSource.fetchGoals();

    if (githubGoals.length === 0) {
      // Fall back to goals.json if no GitHub issues found
      if (!existsSync(goalsPath)) {
        console.error("");
        console.error(`  ${red("Error:")} No goals found on GitHub and no goals.json at: ${goalsPath}`);
        console.error(`  Create issues with the "swarm:goal" label, or run ${cyan("swarm init")} first.`);
        console.error("");
        process.exit(1);
      }
      console.log(`  No GitHub issues with "swarm:goal" label found. Falling back to goals.json.`);
      const goalsRaw = await readFile(goalsPath, "utf-8");
      goalsManifest = JSON.parse(goalsRaw);
      goals = [...goalsManifest.goals].sort((a, b) => a.priority - b.priority);
    } else {
      console.log(`  Found ${githubGoals.length} goal(s) from GitHub Issues.`);
      goals = [...githubGoals].sort((a, b) => a.priority - b.priority);

      // Write goals to goals.json as a read-only cache so other parts
      // of the system (checkpoints, telemetry) have a local reference.
      goalsManifest = {
        project: projectConfig.project,
        created: new Date().toISOString(),
        goals,
      };
      await writeFile(goalsPath, JSON.stringify(goalsManifest, null, 2), "utf-8");
    }
  } else if (effectiveBackendType === "trello") {
    // -----------------------------------------------------------------------
    // Trello as task source — the top card(s) of each board's queue column.
    // No fallback to goals.json: an empty queue means there is nothing ready,
    // and a stale goals.json must not be worked in its place.
    // -----------------------------------------------------------------------
    const trelloOptions = trelloSourceOptions(projectConfig.taskBackendConfig?.trello, repoRoot);
    console.log("");
    console.log(`  ${cyan("Trello")} backend — taking the top of "${trelloOptions.queueList ?? "To Do"}" on ${trelloOptions.boards.join(", ")}...`);

    trelloSource = new TrelloExternalSource(trelloOptions);
    goals = await trelloSource.fetchGoals();
    if (goals.length === 0) {
      console.log("");
      console.log(`  ${green("Nothing is queued on Trello.")} Nothing to do.`);
      console.log("");
      return;
    }
    console.log(`  Found ${goals.length} card(s): ${goals.map((g) => g.description).join("; ")}`);

    // Cache locally, as for GitHub, so checkpoints and telemetry have a reference.
    goalsManifest = {
      project: projectConfig.project,
      created: new Date().toISOString(),
      goals,
    };
    await writeFile(goalsPath, JSON.stringify(goalsManifest, null, 2), "utf-8");
  } else {
    // -----------------------------------------------------------------------
    // Local goals.json — existing behavior
    // -----------------------------------------------------------------------
    if (!existsSync(goalsPath)) {
      console.error("");
      console.error(`  ${red("Error:")} No goals found at: ${goalsPath}`);
      console.error(`  Run ${cyan("swarm init")} first to set up your project.`);
      console.error("");
      process.exit(1);
    }

    const goalsRaw = await readFile(goalsPath, "utf-8");
    goalsManifest = JSON.parse(goalsRaw);
    goals = [...goalsManifest.goals].sort((a, b) => a.priority - b.priority);
  }

  // Keep all goals in the array — completed goals are needed by the
  // dependency resolver (getExecutableGoals checks dependsOn against
  // completed goal IDs). The main loop skips completed goals via
  // processedGoalIds.
  //
  // Include completed_with_notes and completed_with_deferrals via
  // SUCCESS_GOAL_STATUSES. A literal `status !== "completed"` check would
  // leak goals whose lifecycle ended with notes/deferrals back into the
  // runnable set — risking a costly re-execution of work that's already
  // shipped.
  const pendingGoals = goals.filter((g) => !SUCCESS_GOAL_STATUSES.has(g.status));
  if (pendingGoals.length === 0) {
    console.log("");
    console.log(`  ${green("All goals are completed!")} Nothing to do.`);
    console.log("");
    return;
  }

  // Short names for the dashboard's goal badges: the ticket's id from its URL,
  // or a model's pick when the project names one (one small call per new or
  // retitled ticket, cached). Kept off the goal objects, which are written
  // back to goals.json.
  const labelModel = projectConfig.taskBackendConfig?.labels?.model;
  const goalLabels = await labelGoals(pendingGoals, {
    source: effectiveBackendType ?? "local",
    ...(labelModel ? { writer: createClaudeLabelWriter({ model: labelModel }) } : {}),
    cachePath: join(domainDir, "goal-labels.json"),
    log: (line) => console.log(dim(`  ${line}`)),
  });

  // -------------------------------------------------------------------------
  // 4. Initialize task backend
  // -------------------------------------------------------------------------

  const backend = createTaskBackend(
    effectiveBackendType === "github"
      ? { type: "github", repo: effectiveRepo, createTasks: effectiveCreateTasks, credential: githubCredential }
      : { type: "local", storageDir: join(domainDir, ".tasks") },
  );

  // -------------------------------------------------------------------------
  // 5. Initialize Orchestrator
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 5b. Initialize event bus early (Orchestrator needs it)
  // -------------------------------------------------------------------------

  const workerModel = projectConfig.models?.worker ?? "claude-sonnet-4-6";
  const reviewerModel = projectConfig.models?.reviewer ?? "claude-sonnet-4-6";
  const arbiterModel = projectConfig.models?.arbiter ?? "claude-opus-4-6";
  const providerName = projectConfig.models?.provider ?? "anthropic";

  const eventBus = new SwarmEventBus();
  setupEventSubscribers(eventBus, substrateClient, projectConfig, authorId);

  // Mirror goal progress onto the Trello cards the goals came from:
  // Doing at start, Review once the PR exists, Blocked when tasks fail.
  // Detached in Cleanup, after the stacked-PR step has moved cards to Review.
  let detachTrelloSync: (() => void) | undefined;
  if (trelloSource) {
    const mergePrsForSync = projectConfig.source_control?.merge_prs;
    detachTrelloSync = syncGoalLifecycle(eventBus, trelloSource, {
      externalIdFor: (goalId) => (goalId.startsWith("trello-") ? goalId.slice("trello-".length) : undefined),
      ...(mergePrsForSync?.enabled === true ? { mergePrs: { afterMerge: mergePrsForSync.after_merge ?? "done" } } : {}),
      onError: (err, event) => {
        console.log(yellow(`  Trello update failed (${event}): ${err instanceof Error ? err.message : String(err)}`));
      },
    });
  }

  // Failure postmortem recorder — listens for tool wedges + oversight
  // rejections, writes structured JSON artifacts to
  // `.swarm/telemetry/postmortems/<runId>/<taskId>.json` for downstream
  // diagnosis. Started after the event bus is wired so it captures
  // everything from the first goal forward; stopped at run end so
  // listeners don't outlive the session.
  const postmortemRecorder = new FailurePostmortemRecorder({
    runId,
    eventBus,
    substrateClient,
    resolveLineage: (taskId) => walkTaskLineage(backend, taskId),
    resolveGoalId: (taskId) => resolveTaskGoalId(backend, taskId),
  });
  postmortemRecorder.start();

  // Global rate limit gate — shared across all parallel dispatches.
  const rateLimitGate = new RateLimitGate();
  eventBus.on("backend:rate-limited", (e) => {
    rateLimitGate.trigger(
      new Date(e.resetAt).getTime(),
      e.estimatedWaitMs,
    );
  });

  // models.<role> names each role's model; roleBackendConfig passes it to that
  // role's backend (unless the backend block names its own), so it is a
  // contract with the runtime rather than a telemetry label. Every
  // role's backend also carries source_control.git_identity, so commits an
  // agent makes itself use it too. Workers get no GitHub access: every role
  // gets this run's empty GH_CONFIG_DIR (and no GitHub token variable), so gh
  // inside an agent has no login to fall back to.
  // fnl (project `fnl` block): agents' Bash commands go through fnl's digest.
  // A missing or too-old fnl turns it off with one warning.
  const fnlSetup = resolveFnl(projectConfig.fnl);
  if (fnlSetup.fnl) {
    // Say what is true: fnl digests a build or test command only when the
    // agent runs it on its own, and the counts below show how often it did.
    const counted = fnlSetup.fnl.json ? "; coverage is counted per session" : "";
    console.log(dim(`  fnl${fnlSetup.version ? ` ${fnlSetup.version}` : ""} at ${fnlSetup.fnl.bin}: digests build and test commands an agent runs on their own${counted}`));
  }
  if (fnlSetup.warning) console.log(yellow(`  ${fnlSetup.warning}`));
  if (fnlSetup.fnl) {
    const fnlVersion = await checkDependencyVersion({ ...EXTERNAL_DEPENDENCIES.fnl, command: fnlSetup.fnl.bin });
    if (fnlVersion.warning) console.log(yellow(`  ${fnlVersion.warning}`));
  }
  // context.sections (stage 1 of the context-sections spec): before each task,
  // store the swarm's markdown and the task checkout's documents as sections in
  // swarm-docs, with model-written synopses, and load context by section. Needs
  // a Substrate sidecar; without one it stays off with a warning. (Removed
  // documents: syncDocuments deletes their sections itself before the
  // document, so nothing waits on Substrate's periodic crossRef cascade.)
  const sectionsSetup = resolveContextSections(projectConfig.context);
  const docsEndpoint = typeof substrateClient?.endpoint === "string" ? (substrateClient.endpoint as string) : undefined;
  let syncSections: ((workingDirectory: string) => Promise<void>) | undefined;
  if (sectionsSetup && !docsEndpoint) {
    console.log(yellow("  context.sections is on, but this run has no Substrate sidecar; context loads from whole files"));
  } else if (sectionsSetup && docsEndpoint) {
    const docsStore = substrateDocsStore(new SubstrateClient(docsEndpoint, { namespace: SWARM_DOCS_NAMESPACE }));
    const writer = createClaudeSynopsisWriter();
    syncSections = createSectionSync({
      projectId: projectConfig.project,
      paths: sectionsSetup.paths,
      listSwarmFiles: () => listSwarmMarkdown(swarmPath),
      listProjectFiles: listProjectMarkdown,
      commitOf: gitHead,
      syncDocuments: (files, opts) => syncDocuments(docsStore, files, { ...opts, writer }),
      ...(sectionsSetup.concurrency === undefined ? {} : { concurrency: sectionsSetup.concurrency }),
      log: (message) => console.log(dim(`      ${message}`)),
      emit: (type, payload) => eventBus.emit(type, payload),
    });
    console.log(dim(`  context: by section, from .swarm/ and ${sectionsSetup.paths.join(", ")}`));
  }
  // context.pull (stage 2): the worker's context ends with an index of the
  // stored documents, and reads spanning several of their sections over the
  // limit are refused. Only with sections stored.
  const pullSetup = syncSections ? resolveContextPull(projectConfig.context) : null;
  if (pullSetup) {
    console.log(dim(`  context: documents indexed by section; whole-document reads over ${pullSetup.maxReadTokens.toLocaleString("en-US")} tokens are refused`));
  }
  // context.rules: over its budget, rules arrive as must/pinned/relevant in
  // full and the rest by line range. Needs neither sections nor pull.
  const rulesSetup = resolveContextRules(projectConfig.context);
  if (rulesSetup) {
    console.log(dim(`  context: rules over ${rulesSetup.maxTokens.toLocaleString("en-US")} tokens are delivered by index (${rulesSetup.relevant} relevant in full)`));
  }
  // context.ranking (stage 3): each task's sections are ranked against it by
  // the sidecar's embedding model, which prepareProjectSubstrate gave it.
  const rankingSetup = syncSections ? resolveContextRanking(projectConfig.context) : null;
  if (rankingSetup) {
    console.log(dim(`  context: sections ranked against each task by ${rankingSetup.model} (${rankingSetup.dimension} dimensions) at ${rankingSetup.ollamaUrl}; up to ${rankingSetup.maxSections} added`));
  }
  const roleConfigs = roleBackendConfigs(projectConfig, { ghConfigDir: createEmptyGhConfigDir(), fnl: fnlSetup.fnl, codexHookCommand: codexHookCommand() });
  const baseBackendConfig = roleConfigs.worker;

  // Bridge Claude Code progress events to the event bus.
  // Preserve any existing onProgress handler the caller may have set.
  const existingOnProgress = baseBackendConfig.interactionHandler?.onProgress;
  const workerBackendConfig = {
    ...baseBackendConfig,
    interactionHandler: {
      ...baseBackendConfig.interactionHandler,
      onProgress: (event: Parameters<NonNullable<typeof existingOnProgress>>[0]) => {
        existingOnProgress?.(event);
        eventBus.emit("backend:progress", event);
      },
    },
  };

  // Every backend session reports, from the runtime, which models served it —
  // tagged with its role, persisted with the run's events, and flagged loudly
  // when the runtime did not use the model the role asked for.
  const reportModels = (r: RoleModelReport) => {
    eventBus.emit("backend:model_report", r);
    const mismatch = modelMismatch(r.report);
    if (mismatch) {
      console.log(yellow(`  [models] ${r.role}: ${mismatch}`));
    } else if (args["quiet"] !== "true") {
      console.log(dim(`  [models] ${describeModelReport(r)}`));
    }
  };

  // Every session any role runs is counted once: inside a task it adds to
  // that task's result, outside one it is charged straight to the run (the
  // sink is set once the orchestrator exists). See session-ledger.ts.
  const sessionLedger = new SessionLedger();
  const countSession = (spent: Parameters<SessionLedger["charge"]>[0]) => sessionLedger.charge(spent);

  // Every session whose fnl explains its decisions reports how many build and
  // test commands fnl digested (FnlCoverage). The run adds them up for the
  // summary and the dashboard; a worker's shows on its "session done" line,
  // a reviewer's or arbiter's on its own line.
  const fnlTotals = new FnlTotals();
  const reportFnl = (r: BackendFnlCoverageEvent) => {
    fnlTotals.add(r.coverage);
    eventBus.emit("backend:fnl_coverage", r);
    const line = describeFnlCoverage(r.coverage);
    if (line && r.role !== "worker" && args["quiet"] !== "true") console.log(dim(`  [fnl] ${r.role}: ${line}`));
  };

  // An expired login stops the whole run (see login-stop.ts): every role's
  // backend reports one here, and fails fast once it has happened.
  const loginStop = new LoginStop();

  const resolvedWorker = await resolveWorkerBackend(workerBackendConfig);
  const workerBackend = watchLogin(withModelReporting(resolvedWorker.backend, "worker", reportModels, countSession, reportFnl), loginStop);
  const fallbackUsed = resolvedWorker.fallbackUsed;

  // resolveWorkerBackend is used for all roles — it resolves any BackendConfig, not just workers
  // Reviewer backend — defaults to API if not configured
  const reviewerBackendConfig = roleConfigs.reviewer;
  const reviewerBackend = watchLogin(withModelReporting((await resolveWorkerBackend(reviewerBackendConfig)).backend, "reviewer", reportModels, countSession, reportFnl), loginStop);

  // Arbiter backend — defaults to API if not configured
  const arbiterBackendConfig = roleConfigs.arbiter;
  const arbiterBackend = watchLogin(withModelReporting((await resolveWorkerBackend(arbiterBackendConfig)).backend, "arbiter", reportModels, countSession, reportFnl), loginStop);

  // -------------------------------------------------------------------------
  // Preflight: verify required credentials before dispatching any work
  // -------------------------------------------------------------------------
  const workerAuth = projectConfig.backends?.worker?.auth ?? "api_key";
  if (workerAuth !== "subscription" || fallbackUsed) {
    preflightCredentialCheck(projectConfig, workerBackend.type, fallbackUsed);
  }

  // A codex role runs only with Codex installed, its deny list enforceable
  // and its hook passing the self-test: Codex runs commands its hook failed to judge.
  const codexProblems = await preflightCodexRoles(
    roleConfigs,
    { worker: workerBackend.type, reviewer: reviewerBackend.type, arbiter: arbiterBackend.type },
    repoRoot,
  );
  for (const { role, message } of codexProblems) {
    console.error("");
    console.error(`  \x1b[31mError: the ${role} runs on codex, but ${message}.\x1b[0m`);
  }
  if (codexProblems.length > 0) {
    console.error("");
    process.exit(1);
  }

  // Subscribe all bus events to JSONL telemetry persistence
  const eventTelemetry = new Telemetry(join(swarmPath, "telemetry", "events"), true, substrateClient);
  eventTelemetry.setRunId(runId);
  const unsubTelemetry = eventBus.onAny(async (event, payload) => {
    try {
      // Redact tool events before persisting (same as dashboard server)
      const safePayload = event.startsWith("tool:") ? redactToolPayload(payload) : payload;
      await eventTelemetry.emitGenericEvent(event, safePayload);
    } catch {
      // Telemetry write failures should not crash the orchestrator
    }
  });

  // Subscribe to transcript events for dedicated transcript persistence.
  // Worker-role transcripts are persisted by Swarm itself (buffered into the
  // atomic persistTaskTelemetry flush, or written per-row when that resolver is
  // absent), so skip them here to avoid a duplicate row. Reviewer/arbiter
  // transcripts (emitted by the oversight chain) have no atomic-envelope slot and
  // are still persisted here.
  eventBus.on("transcript", async (entry) => {
    if (entry.role === "worker") return;
    try {
      await eventTelemetry.emitTranscript(entry);
    } catch {
      // Non-fatal — don't crash the run if transcript writing fails
    }
  });

  const checkpointDir = join(domainDir, ".checkpoints");
  // `swarm merge` uses the same work repo and checkpoint: never both at once.
  const projectClaim = await claimProject(checkpointDir, "run");
  if (!projectClaim.ok) {
    console.error("");
    console.error(`  ${red("Error:")} swarm merge (pid ${projectClaim.holder.pid}) has been using ${projectName} since ${projectClaim.holder.since}; run again after it finishes.`);
    console.error("");
    process.exit(1);
  }
  const conflictHistoryPath = join(domainDir, "conflict_history.json");
  const orchestrator = new Orchestrator({
    projectConfig,
    backend,
    checkpointPath: checkpointDir,
    eventBus,
    conflictHistoryPath,
    substrateClient: substrateClient,
    // Explicit opt-in for live-repo commits. The Orchestrator no-ops on
    // git operations when repoRoot is unset; the CLI passes the resolved
    // work repo to enable per-task commits when worktrees are
    // disabled (max_workers=1 or --no-worktrees). See orchestrator/index.ts
    // § commitLiveRepo for behavior.
    repoRoot,
  });

  /** Tell the dashboard the session's tokens so far, split, against the limit. */
  const emitTokensUpdate = (): void => {
    const limit = orchestrator.getTokenLimits().session;
    const cumulative = tokenBreakdownTotal(sessionTokens);
    eventBus.emit("tokens:update", {
      cumulativeTokens: cumulative,
      tokens: sessionTokens,
      sessionTokenLimit: limit,
      percentUsed: limit > 0 ? (cumulative / limit) * 100 : 0,
      timestamp: Date.now(),
    });
  };

  // Sessions outside any task (planning a goal, revising the plan, splitting a
  // task, or what a failed or abandoned task spent) go to the session total
  // the budgets read, and to the dashboard's split.
  sessionLedger.setRunSink((spent) => {
    sessionTokens = chargeSession(orchestrator, sessionTokens, { tokensUsed: spent }).sessionTokens;
    emitTokensUpdate();
  });

  const claimRegistry = new ClaimRegistry(repoRoot, eventBus);
  // Side-channel for `creates` arrays (not stored on Task interface)
  let taskCreatesMap = new Map<string, string[]>();

  // Track worktree merge outcomes per task for claim accuracy computation
  const mergeOutcomes = new Map<string, { filesChanged: string[]; mergeResult: "clean" | "conflict" | "skipped"; conflictFiles?: string[] }>();

  // Listen for merge events to capture actual files changed
  eventBus.on("worktree:merged", (data: { taskId: string; filesChanged: string[] }) => {
    if (!data?.taskId || !Array.isArray(data.filesChanged)) return;
    mergeOutcomes.set(data.taskId, { filesChanged: data.filesChanged, mergeResult: "clean" });
  });
  eventBus.on("worktree:conflict", (data: { taskId: string; conflictFiles: string[] }) => {
    if (!data?.taskId || !Array.isArray(data.conflictFiles)) return;
    mergeOutcomes.set(data.taskId, { filesChanged: [], mergeResult: "conflict", conflictFiles: data.conflictFiles });
  });

  // Track claim accuracy per goal for the feedback loop (capped at 5 entries)
  const goalClaimAccuracy = new Map<string, { claimed: string[]; actual: string[]; accuracy: number; missedFiles: string[] }>();
  const CLAIM_ACCURACY_CAP = 5;

  // Track task outcomes for learning capture
  const capturedTaskOutcomes: TaskOutcomeSummary[] = [];
  const capturedConflictFiles: string[] = [];
  const capturedFilesChanged = new Set<string>();

  // What reviewers left for a person, per goal: grouped by task, de-duplicated.
  const leftForPersonByGoal = new Map<string, LeftForPersonGroup[]>();

  function recordTaskOutcome(task: Task, goalId: string, result: SwarmOversightRunResult, latencyMs: number): void {
    const deferred = result.oversight.deferred ?? [];
    if (deferred.length > 0 && SUCCESS_VERDICTS.has(result.oversight.verdict)) {
      leftForPersonByGoal.set(goalId, addLeftForPerson(leftForPersonByGoal.get(goalId) ?? [], task.title || task.description, deferred));
    }
    capturedTaskOutcomes.push({
      taskId: task.id,
      goalId,
      intent: task.intent ?? "",
      description: task.description ?? "",
      verdict: result.oversight.verdict,
      latencyMs,
      retryCount: result.oversight.retryCount,
      arbiterInvolved: result.oversight.arbiterInvolved,
      humanEscalation: result.oversight.humanEscalation,
      rejectionReasons: [...result.oversight.rejectionReasons],
      // Input tokens (cache reads and writes included) and output tokens.
      inputTokens: result.tokensUsed.input,
      outputTokens: result.tokensUsed.output,
    });
  }

  // Accumulate files changed for learning capture (independent of mergeOutcomes which gets cleared per-goal)
  const onMergedForCapture = (data: { taskId: string; filesChanged: string[] }) => {
    if (Array.isArray(data?.filesChanged)) {
      for (const f of data.filesChanged) capturedFilesChanged.add(f);
    }
  };
  const onConflictForCapture = (data: { taskId: string; conflictFiles: string[] }) => {
    if (Array.isArray(data?.conflictFiles)) {
      capturedConflictFiles.push(...data.conflictFiles);
    }
  };
  eventBus.on("worktree:merged", onMergedForCapture);
  eventBus.on("worktree:conflict", onConflictForCapture);

  // -------------------------------------------------------------------------
  // 6. Check for checkpoint
  // -------------------------------------------------------------------------

  const existingCheckpoint = await orchestrator.loadCheckpoint();
  // The goal the checkpointed run stopped in the middle of, when this run
  // resumes it (null on --fresh).
  let resumedCurrentGoal: string | null = existingCheckpoint?.current_goal ?? null;
  if (existingCheckpoint) {
    console.log("");
    console.log(yellow("  Found checkpoint for " + existingCheckpoint.project));
    console.log(dim(`  ${existingCheckpoint.completed_tasks.length} tasks completed | that run used ${formatTokens(existingCheckpoint.cumulative_tokens ?? 0)} tokens | saved ${existingCheckpoint.last_updated}`));
    if (existingCheckpoint.skipped_tasks?.length) {
      console.log(dim(`  ${existingCheckpoint.skipped_tasks.length} tasks skipped (over their token limit)`));
    }
    console.log("");

    // --resume / --fresh flags short-circuit the prompt entirely for scripted
    // and non-TTY launches. When neither is set and no TTY is attached, we
    // default to "resume" (safe, non-destructive) instead of promptUser's
    // last-choice fallback — discarding a checkpoint should require intent.
    let choice: string;
    if (args["resume"] === "true") {
      choice = "resume";
    } else if (args["fresh"] === "true") {
      choice = "fresh";
    } else if (!process.stdin.isTTY) {
      console.log(dim("  Non-interactive — defaulting to resume (use --fresh to discard)."));
      choice = "resume";
    } else {
      choice = await promptUser(
        "How would you like to proceed?",
        ["resume", "fresh"],
      );
    }

    if (choice === "fresh") {
      console.log(dim("  Discarding checkpoint. Starting fresh..."));
      await orchestrator.clearCheckpoint();
      resumedCurrentGoal = null;
    } else {
      console.log(green("  Resuming from checkpoint..."));
      // The checkpoint's tokens are the earlier run's. This run's total, and
      // the session budget it is held to, start from zero.
      console.log(dim("  This run's token total and session budget start from zero."));
    }
    console.log("");
  }

  // SDK-23: Swarm config is extracted so we can create fresh instances between goals
  const swarmConfig = {
    swarmPath,
    provider: providerName,
    model: workerModel,
    oversight: {
      enabled: true,
      reviewerModel,
      reviewerProvider: providerName,
      arbiterModel,
      arbiterProvider: providerName,
    },
    telemetry: {
      enabled: true,
    },
    eventBus,
    workerBackend: workerBackend.supportsDirectExecution ? workerBackend : undefined,
    reviewerBackend: reviewerBackend.supportsDirectExecution ? reviewerBackend : undefined,
    arbiterBackend: arbiterBackend.supportsDirectExecution ? arbiterBackend : undefined,
    backendConfig: workerBackendConfig,
    contextSections: syncSections !== undefined,
    ...(pullSetup ? { contextPull: pullSetup } : {}),
    ...(rulesSetup ? { contextRules: rulesSetup } : {}),
    ...(rankingSetup ? { contextRanking: { maxSections: rankingSetup.maxSections } } : {}),
    // Session author — Swarm threads this onto every worker SessionEvent,
    // transcript, and oversight verdict it persists. Set once; reused by the
    // fresh Swarm instances created between goals.
    authorId,
  } as const;

  // The worker's fallback runs sessions too; count their tokens like the
  // primary's (counting only: its model reports are not checked).
  const withCounting = (fallback: ReturnType<typeof instantiateFallback>) =>
    fallback ? watchLogin(withModelReporting(fallback, "worker", () => {}, countSession, reportFnl), loginStop) : fallback;

  // Build DI deps for the Swarm class
  function makeSwarmDeps(): SwarmDeps {
    const telemetryPath = `${swarmPath}/telemetry/events`;
    const telemetryInstance = new Telemetry(telemetryPath, true, substrateClient);

    // Wrap the concrete Telemetry class as a TelemetryAdapter
    const telemetryAdapter = {
      name: "jsonl-telemetry",
      kind: "telemetry" as const,
      healthCheck: async () => ({ healthy: true }),
      emit: (event: import("@mnmal-ai/swarm-types").SwarmEvent) => telemetryInstance.emitEvent(event),
      flush: async () => {},
      buildEvent: telemetryInstance.buildEvent.bind(telemetryInstance),
      emitOversightEvent: telemetryInstance.emitOversightEvent.bind(telemetryInstance),
      emitTranscript: telemetryInstance.emitTranscript.bind(telemetryInstance),
      // Buffered atomic-telemetry support: Swarm attaches a per-task buffer here
      // so the worker SessionEvent + TranscriptEntry are folded into the single
      // persistTaskTelemetry flush. Absent it, Swarm falls back to per-row writes.
      setTaskBuffer: telemetryInstance.setTaskBuffer.bind(telemetryInstance),
    };

    // Resolve API key for oversight providers
    const envVarMap: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
    const apiKey = process.env[envVarMap[providerName] ?? ""] ?? "";

    // Create oversight runner. When an API key is available, the reviewer/arbiter
    // can fall back to direct API calls. Without one, the nullProvider throws on
    // invocation and Oversight's catch blocks reject/escalate for safety.
    const noKeyError = "No API key — oversight will reject/escalate for safety";
    const nullProvider: ReturnType<typeof createProvider> = {
      name: providerName,
      execute: async () => { throw new Error(noKeyError); },
      executeWithTools: async () => { throw new Error(noKeyError); },
    };
    const reviewerProv = apiKey ? createProvider(providerName, apiKey) : nullProvider;
    const arbiterProv = apiKey ? createProvider(providerName, apiKey) : nullProvider;
    const oversightRunner = new Oversight({
      reviewerProvider: reviewerProv,
      reviewerModel: reviewerModel,
      arbiterProvider: arbiterProv,
      arbiterModel: arbiterModel,
      arbiterPolicy: projectConfig.oversight?.arbiter,
      eventBus,
      substrateClient: substrateClient,
    });

    return {
      telemetry: telemetryAdapter,
      oversight: oversightRunner,
      eventBus,
      fallbackBackend: withCounting(instantiateFallback(workerBackendConfig)),
      queryClient: substrateClient,
      syncSections,
    };
  }

  let swarm = new Swarm(swarmConfig, makeSwarmDeps());

  // -------------------------------------------------------------------------
  // 7b. Warm the router cache (complexity thresholds were loaded in step 2)
  // -------------------------------------------------------------------------

  await swarm.getManifest();

  // -------------------------------------------------------------------------
  // 8. Preflight confirmation screen
  // -------------------------------------------------------------------------

  const worktreesEnabled = orchestrator.getMaxConcurrency() > 1 && args["no-worktrees"] !== "true";
  const permMode = workerBackendConfig.permissions?.mode ?? "acceptEdits";
  const skipConfirm = args["yes"] === "true" || args["y"] === "true" || !process.stdin.isTTY;
  const showTree = args["no-tree"] !== "true";
  const preflightOnly = args["preflight"] === "true";

  // Dashboard: flags over config.dashboard over the defaults.
  const dashboardEnabled = args["no-dashboard"] !== "true";
  const dashboardPort = parseInt(args["dashboard-port"] ?? String(projectConfig.dashboard?.port ?? 3141), 10);
  const dashboardLan = args["dashboard-lan"] === "true" || (args["dashboard-lan"] === undefined && projectConfig.dashboard?.lan === true);

  // --- Swarm tree printer ---
  if (showTree) {
    await printSwarmTree(swarmPath, projectConfig.project, substrateClient);
  }

  // --- Preflight display ---
  console.log("");
  console.log(bold(`  swarm run · ${projectConfig.project}`));
  console.log(dim("  ─────────────────────────────────────────────"));

  // Project
  console.log("");
  console.log(`  ${dim("Run ID")}        ${cyan(runId)}`);
  console.log(`  ${dim("Trust level")}   ${trustLevelDisplay(projectConfig.trust_level)}`);
  console.log(`  ${dim("Working dir")}   ${dim(repoRoot)}`);

  // Autonomy
  console.log("");
  console.log(`  ${bold("Autonomy")}`);
  console.log(`    Review      ${autonomy.review.require_review ? green("on") : yellow("off")}`);
  console.log(`    Retry       ${autonomy.review.auto_retry_on_rejection ? dim(`up to ${autonomy.review.max_retries}`) : dim("off")}`);
  console.log(`    Arbiter     ${autonomy.review.arbiter_can_resolve ? dim("can resolve") : dim("human only")}`);
  console.log(`    Merge       ${autonomy.merge.auto_merge_worktrees ? dim("auto") : dim("manual")}`);
  console.log(`    Conflicts   ${dim(autonomy.merge.conflict_anticipation)}`);
  console.log(`    Push        ${dim(describePushBehaviour(projectConfig.source_control))}`);
  console.log(`    Decompose   ${dim(describeDecomposition(projectDecomposition))}`);
  console.log(`    Complexity  ${dim(describeComplexityThresholds(loadedComplexityThresholds))}`);

  // Models
  console.log("");
  console.log(`  ${bold("Models")}`);
  console.log(`    Worker      ${cyan(workerModel)}`);
  console.log(`    Reviewer    ${dim(reviewerModel)}`);
  console.log(`    Arbiter     ${dim(arbiterModel)}${projectConfig.oversight?.arbiter === "always" ? dim(" (signs off on every approval)") : ""}`);
  console.log(`    Backend     ${cyan(workerBackend.type)}${fallbackUsed ? yellow(" (fallback)") : ""}`);
  if (permMode === "bypassPermissions") {
    console.log(`    Permissions ${red("⚠ bypassPermissions — ALL SAFETY CHECKS DISABLED")}`);
  } else {
    console.log(`    Permissions ${dim(permMode)}`);
  }
  if (workerBackendConfig.permissions?.permissionPromptTool) {
    console.log(`    Perm tool   ${dim(workerBackendConfig.permissions.permissionPromptTool)}`);
  }

  // Credentials — only show keys relevant to the configured provider
  console.log("");
  console.log(`  ${bold("Credentials")}`);
  if (workerAuth === "subscription") {
    console.log(`    Billing     ${green("Claude subscription")}${process.env.ANTHROPIC_API_KEY ? dim("  (ANTHROPIC_API_KEY withheld from sessions)") : ""}`);
  }
  const relevantKeys = getProviderCredentialKeys(providerName);
  // Claude Code backend manages its own auth, but show the key status
  // since it's needed for fallback and oversight API calls
  for (const key of relevantKeys) {
    const val = process.env[key];
    if (val) {
      const masked = val.length > 4
        ? "●●●●" + val.slice(-4)
        : "●●●●";
      console.log(`    ${key}  ${green(masked)}  ${green("✓")}`);
    } else {
      console.log(`    ${key}  ${dim("(not set)")}  ${dim("○")}`);
    }
  }
  // The GitHub account swarm's own GitHub operations run as (workers get none).
  console.log(`    ${formatGitHubBannerLine(githubAccess.banner, { ok: green, dim, warn: yellow })}`);

  // Limits
  console.log("");
  console.log(`  ${bold("Limits")}`);
  const effectiveWorkers = autonomy.execution.parallel_workers ? autonomy.execution.max_workers : 1;
  console.log(`    Workers     ${String(effectiveWorkers)} max${worktreesEnabled ? dim("  (worktrees enabled)") : ""}`);
  for (const line of formatTokenLimitLines(orchestrator.getTokenLimits())) {
    console.log(`    ${line}`);
  }

  // Goals — show only pending (an earlier `goals.length` count, which
  // listed every goal as pending and previewed completed goals in the first 5).
  const previewPending = goals.filter((g) => !SUCCESS_GOAL_STATUSES.has(g.status));
  console.log("");
  console.log(`  ${bold("Goals")} ${dim(`(${previewPending.length} pending)`)}`);
  for (const g of previewPending.slice(0, 5)) {
    console.log(`    ${dim(String(g.priority) + ".")} ${g.description}`);
  }
  if (previewPending.length > 5) {
    console.log(dim(`    ... and ${previewPending.length - 5} more`));
  }
  // A goal whose ticket carries both swarm_split labels runs as
  // swarm_split: false; say so before the run starts.
  for (const warning of goalDecompositionWarnings(previewPending, projectConfig.decomposition, autonomy)) {
    console.log(yellow(`    ⚠ ${warning}`));
  }

  // Source control
  const scStrategy = projectConfig.source_control?.strategy ?? "ephemeral";
  console.log("");
  console.log(`  ${bold("Source control")}  ${dim(scStrategy)}`);
  if (baseSync) {
    console.log(`  ${bold("Base branch")}    ${dim(`${baseBranch} at ${baseSync.after.slice(0, 7)}${baseSync.commits > 0 ? ` (+${baseSync.commits} from remote)` : ", current"}`)}`);
  }
  if (projectConfig.setup_command) {
    console.log(`  ${bold("Setup")}          ${green("ran")} ${dim(projectConfig.setup_command)}`);
  }
  if (worktreesEnabled) {
    console.log(`  ${bold("Worktrees")}      ${dim(".swarm/worktrees/")}`);
  }

  // Dashboard
  console.log(`  ${bold("Dashboard")}      ${dashboardEnabled
    ? dim(`port ${dashboardPort}${dashboardLan ? ", on the LAN" : ", this machine only"}${args["dashboard-port"] || args["dashboard-lan"] ? "" : projectConfig.dashboard ? " (config.dashboard)" : ""}`)
    : dim("off")}`);

  // Telemetry
  const telemetrySharing = projectConfig.telemetry_sharing?.enabled ? green("on") : dim("off");
  console.log(`  ${bold("Telemetry")}      sharing ${telemetrySharing}`);

  console.log("");
  console.log(dim("  ─────────────────────────────────────────────"));

  if (fallbackUsed) {
    console.log(yellow(`  ⚠ ${workerBackendConfig.type} not available, using fallback: ${workerBackend.type}`));
    console.log("");
  }

  trace("M01 reached confirmation-prompt block");
  if (preflightOnly) {
    console.log(green("  Preflight passed.") + dim(" --preflight: stopping here, no goal was started."));
    console.log("");
    releaseRunLock();
    process.exit(0);
  }
  // Confirmation prompt
  if (!skipConfirm) {
    trace("M02 readline.createInterface starting (will block on Enter)");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`  ${green("Enter")} to start · ${dim("Ctrl+C")} to abort  `);
      trace("M03 user confirmed (Enter received)");
      void answer; // consume — any input proceeds
    } finally {
      rl.close();
      trace("M04 readline closed");
    }
  } else {
    console.log(dim("  Starting (--yes)..."));
    trace("M03 --yes flag, skipped prompt");
  }

  console.log("");
  console.log(dim("  Press Ctrl+C to gracefully pause. Press again within 2s to stop immediately."));
  console.log("");
  trace("M05 post-prompt console.log block done");

  // -------------------------------------------------------------------------
  // 8b. Start live dashboard
  // -------------------------------------------------------------------------

  trace(`M06 dashboardEnabled=${dashboardEnabled}`);
  let dashboardServer: DashboardServer | null = null;

  if (dashboardEnabled) {
    trace(`M07 about to construct DashboardServer port=${dashboardPort} lan=${dashboardLan}`);
    dashboardServer = new DashboardServer(eventBus, dashboardPort, backend, dashboardLan, substrateClient);
    trace("M08 DashboardServer constructed");
    dashboardServer.setProject(projectConfig.project, orchestrator.getTokenLimits().session);
    trace("M09 setProject done");
    dashboardServer.setMaxWorkers(projectConfig.concurrency.max_workers);
    trace("M10 setMaxWorkers done");
    const lanIp = dashboardLan ? getLanIp() : null;
    if (dashboardLan) trace(`M11 LAN IP lookup: ${lanIp ?? "none"}`);
    for (const line of dashboardBanner(dashboardPort, dashboardLan, lanIp, isLocalOnlyEnv())) console.log(line);
    console.log("");
    trace("M12 dashboard block complete");
  } else {
    trace("M12 dashboard disabled by --no-dashboard");
  }

  // -------------------------------------------------------------------------
  // 9. SIGINT handler — graceful pause / immediate stop
  // -------------------------------------------------------------------------

  let pauseRequested = false;
  // The goal being worked on, from when it is picked until its outcome is
  // recorded: what a stop (Ctrl+C, an expired login) leaves in the checkpoint.
  let inFlightGoalId: string | null = null;
  let lastSigintTime = 0;
  let worktreeManager: WorktreeManager | null = null;
  trace("M13 SIGINT-related locals declared");

  // Ensure git repo is in a usable state before any work begins.
  // Worktrees require a branch ref to exist (at least one commit).
  // Sequential mode also benefits from git for tracking changes.
  trace(`M14 about to call ensureGitReady cwd=${repoRoot} baseBranch=${projectConfig.base_branch ?? "main"} worktrees=${worktreesEnabled}`);
  await ensureGitReady(repoRoot, projectConfig.base_branch ?? "main", worktreesEnabled, {
    identity: projectConfig.source_control?.git_identity,
    style: projectConfig.source_control?.commit_style,
  });
  trace("M15 ensureGitReady returned");

  // Create WorktreeManager if parallel execution is enabled
  trace(`M16 worktreesEnabled=${worktreesEnabled}`);
  if (worktreesEnabled) {
    trace("M17 constructing WorktreeManager");
    worktreeManager = new WorktreeManager(repoRoot, {
      cleanupStrategy: (["auto-merge", "leave-for-review", "discard"] as WorktreeCleanupStrategy[]).includes(args["worktree-cleanup"] as WorktreeCleanupStrategy)
        ? (args["worktree-cleanup"] as WorktreeCleanupStrategy)
        : "auto-merge",
      conflictHistoryPath,
      gitIdentity: projectConfig.source_control?.git_identity,
      commitStyle: projectConfig.source_control?.commit_style,
    }, eventBus);
    trace("M18 WorktreeManager constructed, about to pruneStale");

    // SDK-22: Prune stale worktrees and orphaned branches from previous runs
    // before dispatching any goals. This prevents "branch already exists" errors.
    try {
      const pruneResult = await worktreeManager.pruneStale();
      if (pruneResult.deletedBranches.length > 0) {
        console.log(yellow(`  Pruned ${pruneResult.deletedBranches.length} stale worktree branch(es) from previous run`));
        for (const branch of pruneResult.deletedBranches) {
          console.log(dim(`    - ${branch}`));
        }
        console.log("");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(yellow(`  Warning: worktree prune failed: ${msg}`));
    }

    trace("M19 about to startPolling");
    worktreeManager.startPolling(3000);
    trace("M20 worktreeManager.startPolling done");
  }

  trace("M21 constructing AbortController");
  const abortController = new AbortController();

  const sigintHandler = () => {
    const now = Date.now();
    if (now - lastSigintTime < 2000) {
      // Second Ctrl+C within 2 seconds — clean up worktrees then exit
      console.log("");
      console.log(red("  Immediate stop requested. Cleaning up worktrees..."));
      if (worktreeManager) {
        worktreeManager.stopPolling();
        Promise.race([
          worktreeManager.destroyAll(),
          new Promise<void>(r => setTimeout(r, 5000)),
        ]).finally(() => process.exit(130));
      } else {
        process.exit(130);
      }
      return;
    }
    lastSigintTime = now;
    pauseRequested = true;
    abortController.abort();
    console.log("");
    console.log(yellow("  Graceful pause requested. Finishing current task..."));
    console.log(dim("  Press Ctrl+C again within 2s to stop immediately."));
  };

  process.on("SIGINT", sigintHandler);
  trace("M22 SIGINT handler installed");

  // An expired login: stop like a pause (nothing more is dispatched, and the
  // in-flight goal is neither failed nor blocked), say so loudly, and let the
  // source put the in-flight goal's item back in its queue.
  loginStop.onTrip((detail) => {
    pauseRequested = true;
    abortController.abort();
    for (const line of loginExpiredBanner(detail, loginStop.runtime)) console.log(red(line));
    eventBus.emit("run:login_expired", {
      message: loginExpiredMessage(loginStop.runtime),
      detail,
      ...(inFlightGoalId ? { goalId: inFlightGoalId } : {}),
      timestamp: Date.now(),
    });
  });

  // -------------------------------------------------------------------------
  // 10. Main execution loop
  // -------------------------------------------------------------------------
  trace("M23 entering pre-main-loop setup");

  // Filter out checkpoint tasks for goals that have been reset to pending/blocked.
  const resetGoalIds = goals
    .filter(g => g.status === "pending" || g.status === "blocked")
    .map(g => g.id);
  const completedTasks: string[] = filterCheckpointTasks(
    existingCheckpoint?.completed_tasks ?? [], resetGoalIds);
  const skippedTasks: string[] = filterCheckpointTasks(
    existingCheckpoint?.skipped_tasks ?? [], resetGoalIds);
  const blockedTasks: string[] = [];
  const allPendingTaskIds: string[] = [];
  let totalTasksRun = 0;
  let tasksFailedThisSession = 0;
  let tokenWarningIssued = false;
  // _taskCreatesMap replaced by taskCreatesMap (declared with ClaimRegistry above)

  // Record session start
  trace("M24 about to recordEvent(session_started) — first store write");
  orchestrator.recordEvent("session_started", `Starting orchestrated execution for ${projectConfig.project}`);
  trace("M25 session_started recorded");

  // Ship-readiness gate (presence-triggered, plan Decision P): active iff
  // .swarm/oversight/ship-readiness.json exists — no top-level config flag.
  // Loaded once here, consulted at each gated goal's completion below. When the
  // contract is absent, every gate code path is skipped and the run is
  // byte-identical to a non-gated run.
  const shipReadinessContractPath = join(swarmPath, "oversight", "ship-readiness.json");
  const shipReadinessContract: ShipReadinessContract | null = loadShipReadinessContract(swarmPath);
  if (shipReadinessContract) {
    // Three scope cases — keep them distinct so the log doesn't tell the
    // operator the gate is "active for all goals" when `goalIds: []`
    // actually means "active for NO goal" (gateAppliesToGoal returns false
    // for every id when the array is empty, since [].includes(_) === false).
    // The 10 scaffolded templates default to `goalIds: []`, so the previous
    // log would have lied on every fresh scaffold.
    const goalIds = shipReadinessContract.goalIds;
    const gatedScope = goalIds === undefined
      ? "all goals"
      : goalIds.length === 0
        ? "no goals (goalIds is empty — edit the contract to opt in)"
        : goalIds.join(", ");
    console.log(dim(`  Ship-readiness gate active for: ${gatedScope}`));
  } else {
    console.log(dim("  gate inactive — no contract found"));
  }

  // -------------------------------------------------------------------------
  // 10b. Telemetry sharing: tree capture + retry pending uploads
  // -------------------------------------------------------------------------

  let treeBefore: string | undefined;
  const sharingConfig = projectConfig.telemetry_sharing;
  trace(`M25b telemetry sharing enabled=${sharingConfig?.enabled ?? false} share_trees=${sharingConfig?.share_trees ?? false}`);

  try {
    if (sharingConfig?.enabled && sharingConfig?.share_trees) {
      trace("M25c about to dynamic-import swarm-telemetry for captureTree");
      const { captureTree } = await import("@mnmal-ai/swarm-telemetry");
      trace("M25d captureTree imported, about to capture cwd tree");
      treeBefore = await captureTree(repoRoot);
      trace("M25e captureTree returned");
    }

    if (sharingConfig?.enabled) {
      trace("M25f about to dynamic-import swarm-telemetry for retryPending");
      const { retryPending } = await import("@mnmal-ai/swarm-telemetry");
      trace("M25g retryPending imported, about to retry pending uploads");
      await retryPending(join(swarmPath, "telemetry", "pending"));
      trace("M25h retryPending returned");
    }
  } catch (telemErr) {
    // Upload failures must never crash the run
    trace(`M25i telemetry block caught error (swallowed): ${telemErr instanceof Error ? telemErr.message : String(telemErr)}`);
  }
  trace("M25j telemetry-sharing block complete");

  // Process goals in dependency order. After each goal completes, re-check
  // which goals are now unblocked. This handles out-of-priority-order deps
  // (e.g., [g2 dependsOn g1, g1] where g2 appears before g1 in the list).
  // getExecutableGoals is imported at top of file
  const processedGoalIds = new Set<string>(
    // Include completed_with_notes/_with_deferrals via
    // SUCCESS_GOAL_STATUSES. Same fix as the pendingGoals filter above —
    // a literal `=== "completed"` check undercounts here and leaves
    // completed-with-notes goal IDs out of the skip-set, causing the
    // orchestrator to re-enter them.
    goals.filter((g) => SUCCESS_GOAL_STATUSES.has(g.status)).map((g) => g.id),
  );

  const skipBlockedGoals = projectConfig.skip_blocked_goals ?? false;

  // Bug#2: a goal persisted as "blocked" by a prior run's task failures must be
  // re-attempted on this run. Reset it to "pending" BEFORE the dispatch loop so
  // getExecutableGoals() — which hard-skips status="blocked" (Bug#3) — routes it
  // to `executable` once its deps are satisfied, and a clean completion flips it
  // to "completed". Suppressed when skip_blocked_goals is set (deliberate-skip
  // mode). One-time startup pass: goals blocked within this session stay
  // terminal, so a single run never retries a goal it just blocked.
  const retriedGoalIds = resetBlockedGoalsForRetry(goals, skipBlockedGoals);
  if (retriedGoalIds.length > 0) {
    await persistGoalStatus(goalsPath, goalsManifest);
    console.log(dim(`  Re-attempting ${retriedGoalIds.length} previously-blocked goal(s): ${retriedGoalIds.join(", ")}`));
  }

  // Stacked-PR mode. When enabled, each goal's task
  // worktrees branch off the *previous* goal's branch instead of
  // projectConfig.base_branch. This produces a chain of PRs that stack on
  // each other in a multi-goal run, rather than N independent PRs that all
  // target main and conflict pairwise on the same files. The previous-goal
  // branch is reset to null after any non-success goal so partial / broken
  // work doesn't poison the next iteration's base.
  const stackPRs = projectConfig.source_control?.stack_prs ?? STACK_PRS_DEFAULT;
  const stackBranchPrefix = projectConfig.source_control?.branch_prefix ?? "swarm/";
  const projectBaseBranch = projectConfig.base_branch ?? "main";
  // Bug#1: in stack mode the orchestrator (never the worker) owns push+PR — it
  // runs the SourceControlManager per-goal loop at session end over EVERY
  // completed goal. Workers have no GitHub access, so stack_prs without
  // remote_pr is refused at startup (validateSourceControlConfig).
  // The stack pointer (previousGoalBranch) plus the completed goals, in
  // completion order, fed to the stacked-PR push loop at session end. Only
  // populated in stack mode; recordGoalOutcomeForStack appends a goal exactly
  // when it advances the stack pointer onto it.
  const stackLedger = createGoalStackLedger();
  // Merge-as-you-go (source_control.merge_prs). Each done goal's PR is opened
  // and, when eligible and its gate passes, merged before the next goal
  // starts; every goal branches off the freshly synced base, so nothing
  // stacks. Startup validation refuses it together with stack_prs.
  const mergePrsConfig = projectConfig.source_control?.merge_prs;
  const mergePRs = mergePrsConfig?.enabled === true && projectConfig.source_control?.strategy === "remote_pr";
  const mergeManager = mergePRs && projectConfig.source_control
    ? new SourceControlManager(
        repoRoot,
        { ...projectConfig.source_control, base_branch: projectBaseBranch },
        eventBus,
        { github: githubCredential },
      )
    : null;
  const prMergeOutcomes: MergeGoalResult[] = [];
  // The final review verdict of every task, for merge eligibility.
  const taskVerdicts = new Map<string, string>();
  if (mergePRs) eventBus.on("task:verdict", (e) => taskVerdicts.set(e.taskId, e.verdict));
  if (mergePRs) {
    console.log(dim(`  Merge-as-you-go: on (each done goal's PR merges into ${projectBaseBranch} when its gate passes: ${mergePrsConfig?.gate?.command ?? "?"})`));
  } else if (stackPRs) {
    console.log(dim(`  Stacked-PR mode: on (each goal's branch is built on the previous completed goal's branch)`));
  } else {
    console.log(dim(`  Stacked-PR mode: off (every goal branches off ${projectBaseBranch} independently)`));
  }

  // The repository's merge turn (merge-queue spec): every swarm process on
  // this machine that merges into this repository and base takes turns.
  let mergeQueue: FileMergeQueue | undefined;
  if (mergeManager) {
    try {
      mergeQueue = new FileMergeQueue(await repoKeyFor(repoRoot, projectConfig.source_control?.remote ?? "origin", projectBaseBranch));
    } catch (err) {
      console.log(yellow(`  ⚠ Merge queue: the work repo's remote could not be read (${err instanceof Error ? err.message : String(err)}); merges run without a turn`));
    }
    eventBus.on("source_control:merge_waiting", (e) => {
      const who = e.holderProject ? `${e.holderProject}${e.holderPrUrl ? ` (gating ${e.holderPrUrl})` : ""}` : "another run";
      console.log(dim(`    Merge queue: waiting for ${who}, ${e.ahead} ahead`));
    });
    eventBus.on("source_control:merge_turn_taken", (e) => {
      if (e.tookOverFrom) console.log(yellow(`    Merge queue: took over the merge turn left by ${e.tookOverFrom}, which stopped answering`));
    });
  }
  /** The merge options shared by every merge this run makes; a resolver is added per goal. */
  const baseMergeOptions = (gate: MergePrsGateConfig): MergeGoalOptions => ({
    gate,
    skipLabels: mergePrsConfig?.skip_labels ?? MERGE_PRS_DEFAULT_SKIP_LABELS,
    ...(mergeQueue ? { queue: mergeQueue } : {}),
    project: projectConfig.project,
    maxRounds: mergePrsConfig?.max_rounds ?? MERGE_PRS_DEFAULT_MAX_ROUNDS,
    maxConflictRounds: mergePrsConfig?.max_conflict_rounds ?? MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS,
  });
  /**
   * A worker resolves a conflict with the base, as a reviewed task in the work
   * repo, through the same path as remediation tasks (swarm.runWithOversight).
   * Absent when merge_prs.resolve_conflicts is false.
   */
  const conflictResolver: ConflictResolver | undefined =
    mergePrsConfig?.resolve_conflicts === false
      ? undefined
      : async (ctx) => {
          console.log(yellow(`    Merge-as-you-go: ${ctx.branch} conflicts with ${ctx.base} in ${ctx.files.length} file(s); a worker resolves it`));
          const description = conflictTaskDescription(ctx);
          // In the task's scope, as the remediation path does: its .result is the run.
          const result = await sessionLedger.startTask(() =>
            swarm.runWithOversight(description, {
              input: description,
              project: projectConfig.project,
              intentOverride: "implementation",
              additionalContext: conflictTaskContext(ctx),
              workingDirectory: repoRoot,
              taskTokenLimit: orchestrator.getTaskTokenLimit(),
              reviewRequired: true,
              maxTurns: projectConfig.maxTurns,
            }),
          ).result;
          const charged = chargeSession(orchestrator, sessionTokens, result);
          sessionTokens = charged.sessionTokens;
          emitTokensUpdate();
          const verdict = String(result.oversight.verdict);
          return MERGE_ELIGIBLE_VERDICTS.has(verdict) ? { resolved: true } : { resolved: false, reason: `the resolution was not approved (${verdict})` };
        };

  // Ship-readiness outcome accumulator. One entry per goal iterated for
  // completion, feeding the run summary's Ship-readiness section. Populated
  // inside the goal-completion block below — every goal hits exactly one
  // branch (gate ran pass/fail, or skipped). Presence-gated: with no contract
  // loaded, every goal still records a 'skipped' entry so the summary renders
  // the 'No contract' line.
  const shipReadinessOutcomes: Array<{ goalId: string; applied: boolean; status: "passed" | "failed" | "skipped"; detail?: string }> = [];

  // The checkpoint as of now: the existing per-goal saves' fields, with the
  // goal in flight while the run is stopping (Ctrl+C, an expired login).
  const saveRunCheckpoint = (currentGoal: string | null = pauseRequested ? inFlightGoalId : null) =>
    orchestrator.saveCheckpoint({
      session_id: orchestrator.getSessionId(),
      swarm_version: "HEAD",
      project: projectConfig.project,
      current_goal: currentGoal,
      current_task: null,
      completed_tasks: [...completedTasks],
      pending_tasks: allPendingTaskIds.filter((id) => !completedTasks.includes(id)),
      skipped_tasks: [...skippedTasks],
      blocked: false,
    });

  // Goal publications (saved with the checkpoint): every push, PR and merge
  // is recorded as it happens, so what a run could not publish, the next run
  // publishes, and nothing is done twice.
  const detachPublicationTracking = trackGoalPublications(eventBus, orchestrator);
  const publicationSettings = {
    autoPush: projectConfig.source_control?.auto_push !== false,
    openPr: projectConfig.source_control?.pr_on_goal_complete !== false,
  };
  const stackPushes = stackPRs && projectConfig.source_control?.strategy === "remote_pr";
  // Stacked: goals earlier runs finished but did not publish join this run's
  // stack, in the order they finished, and this run's goals build on them.
  const earlierStackGoals: GoalPublication[] = stackPushes
    ? pendingPublications(orchestrator.getGoalPublications(), "stack", publicationSettings)
    : [];
  if (stackPushes) {
    for (const line of formatEarlierPublications(earlierStackGoals, "stack")) console.log(yellow(`  ${line}`));
    const head = resumeStackHead(orchestrator.getGoalPublications(), {
      interrupted: resumedCurrentGoal !== null,
      settings: publicationSettings,
    });
    if (head && (await localBranchExists(repoRoot, head))) {
      stackLedger.previousGoalBranch = head;
      console.log(dim(`  Stacked-PR mode: this run's goals build on '${head}', where the earlier run's stack ends`));
    } else if (head) {
      console.log(yellow(`  Stacked-PR mode: the earlier run's stack ended on '${head}', which no longer exists here; this run's goals build on ${projectBaseBranch}`));
    }
  }
  // Merge-as-you-go: goals earlier runs finished but did not publish get
  // their push, PR and (when eligible) merge, once per run. Before the first
  // goal, so it starts from a base that has them; but when the last run
  // stopped in the middle of a goal, only after that goal, whose branch was
  // built on the base as it was then and must not have it move underneath.
  let earlierMergesPublished = !(mergeManager && mergePrsConfig?.gate);
  const publishEarlierMerges = async (): Promise<void> => {
    if (earlierMergesPublished || !mergeManager || !mergePrsConfig?.gate) return;
    earlierMergesPublished = true;
    const earlierMergeGoals = pendingPublications(orchestrator.getGoalPublications(), "merge", publicationSettings);
    for (const line of formatEarlierPublications(earlierMergeGoals, "merge")) console.log(yellow(`  ${line}`));
    await publishEarlierMergeGoals(
      mergeManager,
      earlierMergeGoals,
      earlierMergeOptions(
        { ...baseMergeOptions(mergePrsConfig.gate), ...(conflictResolver ? { resolveConflict: conflictResolver } : {}) },
        { stopping: pauseRequested },
      ),
      projectBaseBranch,
      async (outcome) => {
        prMergeOutcomes.push(outcome);
        for (const line of formatMergeOutcome(outcome)) console.log(line);
        await saveRunCheckpoint(inFlightGoalId ?? resumedCurrentGoal);
      },
    );
  };
  if (resumedCurrentGoal === null) await publishEarlierMerges();
  // The goal the last run stopped in goes first, so it continues on the
  // branch it was built on.
  let resumeGoalFirst = resumedCurrentGoal;

  trace("M26 entering main while loop");
  let __loopIter = 0;
  while (!pauseRequested) {
    __loopIter++;
    trace(`M27 loop iteration #${__loopIter}, getExecutableGoals about to run`);
    const { executable, blocked: __blockedByDep, skipped: skippedByDep, skipReasons } = getExecutableGoals(goals, skipBlockedGoals);
    trace(`M28 getExecutableGoals returned: ${executable.length} executable, ${__blockedByDep.length} blocked-by-dep, ${skippedByDep.length} skipped-by-dep`);
    if (executable.length === 0) {
      trace(`M28b NO EXECUTABLE GOALS. blocked=${__blockedByDep.map(g => g.id).join(',')} skipped=${skippedByDep.map(g => g.id).join(',')}`);
    }

    // Every goal getExecutableGoals() placed in `skipped` — whether bug#3
    // hard-skipped (own status="blocked") or bug#26 dependency-failed — fires a
    // goal_blocked event with its skip reason and is marked processed so it
    // never reaches decomposition or worker dispatch (zero LLM calls). The
    // returned outcome rows surface these goals in the Ship Readiness section of
    // the run report; without them dep-skipped goals would vanish from the
    // summary, since the main goal-execution block is never entered for skips.
    shipReadinessOutcomes.push(
      ...recordSkippedGoals(
        skippedByDep,
        skipReasons,
        processedGoalIds,
        (type, message, meta) => orchestrator.recordEvent(type, message, meta),
      ),
    );

    // Find the next executable goal we haven't processed yet (in priority
    // order), the one the last run stopped in first.
    const candidates = executable
      .filter((g) => !processedGoalIds.has(g.id))
      .sort((a, b) => a.priority - b.priority);
    const goal = candidates.find((g) => g.id === resumeGoalFirst) ?? candidates[0];
    resumeGoalFirst = null;
    if (!goal) break; // No more executable goals
    processedGoalIds.add(goal.id);
    inFlightGoalId = goal.id;

    const goalStartTime = Date.now();
    // Sessions outside this goal's tasks (planning it, revising the plan,
    // splitting a task, failed or abandoned tasks) count toward the goal too.
    const goalOverheadMark = sessionLedger.runOverhead();

    // Per-iteration stack-mode bookkeeping. Declared here so it's visible to
    // both the dispatch-prep block (which materializes the branch) and the
    // post-dispatch status-handling block (which advances the stack pointer
    // after a successful goal). Null when stack mode is off OR branch
    // creation failed, both of which the post-dispatch block treats as
    // "don't advance the stack pointer".
    let currentGoalBranch: string | null = null;

    console.log(bold(`  Goal: ${goal.description}`));
    console.log(dim(`  [${goal.id}] priority=${goal.priority}`));
    console.log("");

    orchestrator.recordEvent("goal_started", goal.description, { goal_id: goal.id });

    // Mirror the goal into the swarm/Goal Substrate entity at goal-start so the
    // updateGoal block at goal-completion finds a matching row to flip. This is
    // a fire-and-forget telemetry mirror (never awaited, never throws — the
    // helper swallows failures); the authoritative state stays the in-memory
    // goal.status / capturedTaskOutcomes tracking, which this does not touch.
    if (substrateClient) {
      mirrorGoalStart(substrateClient, {
        goalId: goal.id,
        projectId: projectConfig.project,
        description: goal.description,
        priority: String(goal.priority),
        status: "running",
        acceptanceCriteria: goal.acceptance_criteria,
        constraints: goal.constraints,
        dependsOn: goal.dependsOn ?? [],
        timestamp: new Date(goalStartTime).toISOString(),
      });
    }

    // This goal's decomposition policy: the project's, unless the goal's
    // swarm_split label overrides it.
    const goalDecomposition = effectiveDecomposition(projectConfig.decomposition, goal, autonomy);
    if (goalDecomposition.source !== "project") {
      console.log(dim(`    Decompose   ${describeDecomposition(goalDecomposition)}`));
    }

    console.log(ts() + dim(" Decomposing goal into tasks..."));
    // goal:start follows once the goal has tasks; until then the dashboard
    // shows that it is being planned.
    const goalLabel = goalLabels.get(goal.id);
    eventBus.emit("goal:planning", { goalId: goal.id, ...(goalLabel ? { label: goalLabel } : {}), timestamp: Date.now() });

    let tasks: Task[];
    taskCreatesMap = new Map<string, string[]>();

    // Build claim feedback from recent goals (last 3) so signal stays responsive
    let claimFeedback: { accuracy: number; missedFiles: string[] } | undefined;
    try {
      if (goalClaimAccuracy.size > 0) {
        const recentAccuracies = [...goalClaimAccuracy.values()].slice(-3);
        const avgAccuracy = recentAccuracies.reduce((sum, g) => sum + g.accuracy, 0) / recentAccuracies.length;
        const allMissed = [...new Set(recentAccuracies.flatMap(g => g.missedFiles))];
        claimFeedback = { accuracy: avgAccuracy, missedFiles: allMissed };
      }

      const decomposed = await decomposeGoal(swarm, goal, projectConfig.project, repoRoot, orchestrator.buildPriorGoalsContext(), claimFeedback, swarmPath, projectConfig.source_control?.commit_style, goalDecomposition.maxTasks);
      tasks = decomposed.tasks;
      taskCreatesMap = decomposed.createsMap;

      // NOTE: We no longer set parentTaskId on decomposed tasks. The decomposition
      // loop detector (line ~2417) handles the infinite re-decomposition case by
      // checking if prior decompositions produced completions. This allows genuinely
      // complex tasks to be sub-decomposed once, while preventing the loop.
      if (taskCreatesMap.size > 0) {
        console.log(dim(`      (${taskCreatesMap.size} tasks declared file creates)`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Rate limit during decomposition: pause and retry once
      if (msg.includes("rate limit") || msg.includes("resets soon") || msg.includes("429")) {
        console.log(yellow(`    Decomposition hit rate limit — pausing 60s and retrying...`));
        await new Promise(resolve => setTimeout(resolve, 60_000));
        try {
          const retryDecomposed = await decomposeGoal(swarm, goal, projectConfig.project, repoRoot, orchestrator.buildPriorGoalsContext(), claimFeedback, swarmPath, projectConfig.source_control?.commit_style, goalDecomposition.maxTasks);
          tasks = retryDecomposed.tasks;
          taskCreatesMap = retryDecomposed.createsMap;
        } catch (retryErr) {
          console.log(red(`    Decomposition retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`));
          console.log(dim("    Falling back to default investigate + implement tasks"));
          tasks = defaultTasks(goal);
        }
      } else {
        console.log(red(`    Decomposition failed: ${msg}`));
        console.log(dim("    Falling back to default investigate + implement tasks"));
        tasks = defaultTasks(goal);
      }
    }

    // The login expired while planning: the goal never starts, so its source
    // item never left the queue and nothing about it is marked.
    if (loginStop.tripped) break;

    // Enforce the task cap on whatever the planner (or the fallback) produced:
    // tasks past the cap are folded into the last allowed task, not dropped.
    {
      const capped = applyPlannerCap(tasks, taskCreatesMap, goalDecomposition.maxTasks);
      tasks = capped.tasks;
      taskCreatesMap = capped.createsMap;
      if (capped.message) console.log(dim(`      (${capped.message})`));
    }

    eventBus.emit("goal:start", {
      goalId: goal.id,
      description: goal.description,
      taskCount: tasks.length,
      ...(goal.url ? { url: goal.url } : {}),
      ...(goalLabel ? { label: goalLabel } : {}),
      timestamp: Date.now(),
    });

    eventBus.emit("goal:decomposed", {
      goalId: goal.id,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, intent: t.intent, source: t.source })),
      timestamp: Date.now(),
    });

    console.log(`    ${cyan(`${tasks.length} tasks planned:`)}`);
    for (const t of tasks) {
      console.log(dim(`      ${t.order}. [${t.intent}] ${t.title || t.description}`));
    }
    console.log("");

    // Helper: register a task in the backend. For GitHub backends,
    // createTask returns the issue number — remap the task ID so all
    // subsequent updateTask calls use the numeric GitHub issue number.
    // WARNING: mutates t.id and t.source in place when remapping occurs.
    const registerTask = async (t: Task): Promise<void> => {
      const oldId = t.id;
      const externalId = await backend.createTask(t);
      if (effectiveBackendType === "github" && externalId !== oldId) {
        t.source = { type: "github", externalId, url: effectiveRepo ? `https://github.com/${effectiveRepo}/issues/${externalId}` : undefined };
        t.id = externalId;
        // Tell the dashboard to merge the old entry with the new ID
        (eventBus as any).emit("task:id_remapped", {
          oldId,
          newId: externalId,
          source: t.source,
          timestamp: Date.now(),
        });
      }
    };

    // Register tasks in the backend BEFORE tracking pending IDs,
    // so that GitHub-remapped IDs are used everywhere.
    // Track old→new ID mappings so we can remap taskCreatesMap keys.
    const idRemaps = new Map<string, string>();
    for (const task of tasks) {
      const oldId = task.id;
      try {
        await registerTask(task);
        if (task.id !== oldId) {
          idRemaps.set(oldId, task.id);
        }
      } catch {
        // Task may already exist from a previous session — that's fine
      }
    }

    // Remap taskCreatesMap keys to match the new (GitHub) task IDs
    if (idRemaps.size > 0) {
      for (const [oldId, newId] of idRemaps) {
        const creates = taskCreatesMap.get(oldId);
        if (creates) {
          taskCreatesMap.delete(oldId);
          taskCreatesMap.set(newId, creates);
        }
      }
    }

    // Track pending task IDs for checkpoint (after registration so IDs are final)
    for (const task of tasks) {
      if (!completedTasks.includes(task.id)) {
        allPendingTaskIds.push(task.id);
      }
    }

    // ---------------------------------------------------------------
    // Claim registration and validation
    // ---------------------------------------------------------------
    const claims = tasks
      .filter(t => !completedTasks.includes(t.id))
      .map(t => ({
        taskId: t.id,
        creates: taskCreatesMap.get(t.id) || [],
        modifies: t.serializedFiles || [],
      }));

    if (claims.some(c => c.creates.length > 0 || c.modifies.length > 0)) {
      claimRegistry.register(claims, goal.id);

      const validation = await claimRegistry.validate();
      if (!validation.valid) {
        console.log(dim(`    Claim validation found issues: ${validation.missingFiles.length} missing files, ${validation.duplicateCreates.length} duplicate creates`));
        console.log(dim(`    Requesting revision from LLM...`));

        try {
          const revisionResult = await swarm.run(
            `Revise file intent declarations for tasks with issues.`,
            {
              input: [
                `## Issues Found`,
                ...(validation.missingFiles.length > 0
                  ? [`Missing files (declared as "modifies" but do not exist): ${validation.missingFiles.join(", ")}`]
                  : []),
                ...(validation.duplicateCreates.length > 0
                  ? [`Duplicate creates (multiple tasks claim to create): ${validation.duplicateCreates.join(", ")}`]
                  : []),
                "",
                `## Current Claims`,
                ...claims.map(c => `- ${c.taskId}: creates=[${c.creates.join(",")}] modifies=[${c.modifies.join(",")}]`),
                "",
                `Please revise the "creates" and "modifies" arrays for the affected tasks.`,
                `Output ONLY a JSON array:`,
                "```json",
                `[{ "task_id": "...", "creates": [...], "modifies": [...] }]`,
                "```",
              ].join("\n"),
              project: projectConfig.project,
              intentOverride: "orchestration",
              workingDirectory: repoRoot,
            },
          );

          // Parse revised claims
          const startIdx = revisionResult.output.indexOf("[");
          if (startIdx !== -1) {
            let depth = 0;
            let jsonStr: string | null = null;
            for (let i = startIdx; i < revisionResult.output.length; i++) {
              if (revisionResult.output[i] === "[") depth++;
              if (revisionResult.output[i] === "]") depth--;
              if (depth === 0) {
                jsonStr = revisionResult.output.slice(startIdx, i + 1);
                break;
              }
            }
            if (jsonStr) {
              const parsed = JSON.parse(jsonStr);
              if (Array.isArray(parsed)) {
                const knownTaskIds = new Set(claims.map(c => c.taskId));
                const revisedClaims = parsed
                  .filter((r: any) => r && typeof r.task_id === "string" && knownTaskIds.has(r.task_id))
                  .map((r: any) => {
                    const creates = Array.isArray(r.creates)
                      ? r.creates.filter((v: unknown) => typeof v === "string")
                      : [];
                    const modifies = Array.isArray(r.modifies)
                      ? r.modifies.filter((v: unknown) => typeof v === "string")
                      : [];
                    return {
                      taskId: r.task_id as string,
                      creates,
                      modifies,
                    };
                  });

                if (revisedClaims.length > 0) {
                  claimRegistry.revise(revisedClaims);

                  for (const r of revisedClaims) {
                    const task = tasks.find(t => t.id === r.taskId);
                    if (task) {
                      task.serializedFiles = r.modifies.length > 0 ? [...r.modifies] : undefined;
                    }
                  }
                }
              }
            }
          }
        } catch {
          console.log(dim(`    Revision failed — proceeding with best-effort claims`));
        }
      }

      // Apply serialization constraints to tasks
      tasks = claimRegistry.applyToTasks(tasks);

      const conflicts = claimRegistry.getConflicts();
      if (conflicts.length > 0) {
        console.log(cyan(`    ${conflicts.length} file conflict(s) detected — tasks will be serialized:`));
        for (const c of conflicts) {
          console.log(dim(`      ${c.file}: ${c.claimants.join(" → ")}`));
        }
        console.log("");
      }
    }

    // ---------------------------------------------------------------
    // Conflict anticipation — detect file overlaps and merge with
    // serialization constraints before the DAG is built
    // ---------------------------------------------------------------
    if (autonomy.merge.conflict_anticipation !== "none") {
      const conflictHistory = autonomy.merge.conflict_anticipation === "learned"
        ? loadConflictHistory(conflictHistoryPath)
        : { files: {} };
      const anticipatedFiles = getAnticipatedSerializations(
        tasks,
        conflictHistory,
        autonomy.merge.conflict_anticipation,
      );

      if (anticipatedFiles.length > 0) {
        console.log(dim(`    Conflict anticipation: serializing ${anticipatedFiles.length} file(s)`));
        for (const f of anticipatedFiles) {
          console.log(dim(`      - ${f}`));
        }

        // Build a goal-scoped serialization_constraints that includes
        // anticipated files. We replace (not mutate) so that anticipated
        // files from goal N don't accumulate into goal N+1's DAG.
        const basePatterns = projectConfig.serialization_constraints?.patterns ?? [];
        projectConfig.serialization_constraints = {
          patterns: [...new Set([...basePatterns, ...anticipatedFiles])],
        };
      }
    }

    // Tokens this goal's task results used: all input (cache included) plus
    // output. goalSpend() adds the goal's sessions outside its tasks.
    let goalTokens = 0;
    const goalSpend = (): number => goalTokens + sessionLedger.runOverhead() - goalOverheadMark;
    let consecutiveApiFailures = 0;
    const MAX_CONSECUTIVE_API_FAILURES = 2;
    let currentBranch: string | null = null;

    // ---------------------------------------------------------------
    // Parallel or sequential dispatch based on max_workers
    // ---------------------------------------------------------------

    // Decide the dispatch mode and, in stack mode, materialize this goal's
    // branch off the resolved stack base (the previous completed goal's
    // branch, else base_branch). This runs for BOTH modes: worktree tasks
    // branch off the goal branch and auto-merge back into it; sequential
    // (max_workers 1 / --no-worktrees) tasks run in the repo root with HEAD
    // switched onto it, and commitLiveRepo commits there. It used to run on
    // the parallel path only, so a single-worker stacked run committed onto
    // base_branch and queued nothing for the push+PR step.
    // Merge-as-you-go: start from the base as merged so far.
    if (mergeManager) {
      try {
        await mergeManager.syncBaseBranch();
      } catch (err) {
        console.log(yellow(`    Merge-as-you-go: could not bring ${projectBaseBranch} up to date (${err instanceof Error ? err.message : String(err)}); this goal starts from the local ${projectBaseBranch}`));
      }
    }
    const goalDispatch = await prepareGoalDispatch({
      maxConcurrency: orchestrator.getMaxConcurrency(),
      hasWorktreeManager: worktreeManager !== null,
      // Merge-as-you-go also gives each goal its own branch, always off the base.
      stackPRs: stackPRs || mergePRs,
      repoRoot,
      branchPrefix: stackBranchPrefix,
      goalId: goal.id,
      projectBaseBranch,
      configuredBaseBranch: projectConfig.base_branch,
      previousGoalBranch: mergePRs ? null : stackLedger.previousGoalBranch,
      log: {
        info: (msg) => console.log(dim(`    ${msg}`)),
        warn: (msg) => console.log(yellow(`    ${msg}`)),
      },
    });
    currentGoalBranch = goalDispatch.goalBranch;

    if (goalDispatch.parallel && worktreeManager) {
      // --- Isolation inference for concurrent workers ---
      if (orchestrator.needsIsolationInference()) {
        console.log(dim("    No isolation config — asking agent to infer from project context..."));
        try {
          const inferResult = await swarm.run(
            `Given this project's tech stack and testing approach, generate an isolation config for concurrent workers.\n` +
            `Each worker runs in a separate git worktree and needs its own test environment.\n` +
            `Respond with ONLY a JSON object: { "setup": "<shell command>", "verify": "<shell command>", "teardown": "<shell command>", "env": { "KEY": "value" } }\n` +
            `Use \${TASK_ID} as a placeholder for the unique worker identifier.\n` +
            `Examples:\n` +
            `  iOS: { "setup": "xcrun simctl clone 'iPhone 16' 'worker-\${TASK_ID}'", "verify": "xcrun simctl list | grep 'worker-\${TASK_ID}'", "teardown": "xcrun simctl delete 'worker-\${TASK_ID}'" }\n` +
            `  Web: { "setup": "createdb test_\${TASK_ID}", "verify": "pg_isready -d test_\${TASK_ID}", "teardown": "dropdb test_\${TASK_ID}" }\n` +
            `  If no isolation is needed (e.g., tests use unique temp dirs by default), respond: { "setup": "true", "verify": "true", "teardown": "true" }`,
            { project: projectConfig.project, intentOverride: "investigation" } as any,
          );
          const parsed = JSON.parse(inferResult.output);
          if (parsed.setup && parsed.verify && parsed.teardown) {
            orchestrator.setIsolationConfig(parsed);
            console.log(dim(`    Isolation inferred: ${parsed.setup.slice(0, 60)}`));

            // Cache in Substrate for future runs
            if (substrateClient) {
              try {
                await substrateClient.mutate("createSwarmConfig", {
                  key: `isolation:${projectConfig.project}`,
                  value: JSON.stringify(parsed),
                  category: "isolation",
                }, { id: true });
              } catch { /* non-fatal */ }
            }
          }
        } catch (err) {
          console.log(dim(`    Isolation inference failed — workers will share the default environment`));
        }
      }

      // --- Parallel dispatch via worker pool ---
      console.log(cyan(`    Dispatching ${tasks.length} tasks (max ${orchestrator.getMaxConcurrency()} workers)...`));
      console.log("");

      // Enrich tasks with createsFiles so the DAG can infer create→modify ordering
      const dispatchTasks = tasks
        .filter(t => !completedTasks.includes(t.id) && !skippedTasks.includes(t.id))
        .map(t => {
          const creates = taskCreatesMap.get(t.id);
          return creates && creates.length > 0
            ? { ...t, createsFiles: creates }
            : t;
        });

      const dispatchResult = await orchestrator.dispatchParallel({
        tasks: dispatchTasks,
        goal,
        project: projectConfig.project,
        workingDirectory: repoRoot,
        worktreeManager,
        baseBranch: goalDispatch.dispatchBaseBranch,
        // Per-call branch context for live-repo commits (stack-PR mode).
        // The orchestrator passes this straight to commitLiveRepo so each
        // goal's commits land on its swarm-worker/goal-N branch.
        goalBranch: currentGoalBranch,
        abortSignal: abortController.signal,
        executeTask: async (task: Task, workingDir: string) => {
          // Complexity estimation and split plan (same pipeline as the
          // sequential path; this path never splits a task before it runs)
          const { complexity, split: splitPlan } = classifyTaskForDispatch(task, complexityThresholds, goalDecomposition);
          task.complexity = complexity;

          eventBus.emit("complexity:estimated", {
            taskId: task.id,
            score: complexity.score,
            band: complexity.band,
            signals: complexity.signals,
            reasoning: complexity.reasoning,
            timestamp: Date.now(),
          });

          const bandLabel = complexity.band === "simple" ? dim(complexity.band)
            : complexity.band === "moderate" ? yellow(complexity.band)
            : red(complexity.band);

          const directive = orchestrator.buildDirective(goal, task);

          console.log(`${ts()}    ${magenta(">")} ${task.description}`);
          console.log(ts() + dim(` complexity: ${bandLabel} ${dim(`(score=${complexity.score})`)}`));
          console.log(dim(`      intent=${task.intent}  review=${directive.directive.review_required ? "yes" : "no"}  dir=${workingDir}`));

          orchestrator.recordEvent("task_dispatched", task.description, {
            goal_id: goal.id,
            task_id: task.id,
            dispatch_directive: directive,
          });

          await backend.updateTask(task.id, { status: "in_progress" });

          eventBus.emit("task:start", {
            taskId: task.id,
            goalId: goal.id,
            title: task.title,
            description: task.description,
            intent: task.intent,
            parentTaskId: task.parentTaskId,
            source: task.source,
            timestamp: Date.now(),
          });

          const taskStartTime = Date.now();

          // Per-task AbortController is now created UNCONDITIONALLY so the
          // tool-call wedge watcher (below) has something to abort on every
          // task, not just moderate-complexity ones. The escalation watcher
          // continues to be moderate-only — its token/turn heuristics aren't
          // useful for simple/complex tasks — and runs only when the goal's
          // decomposition policy allows splitting on failure.
          const taskAbortController = new AbortController();
          const escalationWatcher = splitPlan.armEscalationWatcher
            ? createEscalationWatcher(eventBus, task.id, complexityThresholds, {
                tokenLimit: orchestrator.getTaskTokenLimit(),
                maxTurns: 50,
                timeoutMs: getTimeoutForComplexity(complexity.band),
              })
            : null;

          let escalationInterval: ReturnType<typeof setInterval> | null = null;
          if (escalationWatcher) {
            escalationInterval = setInterval(() => {
              if (escalationWatcher.isTriggered() && !taskAbortController.signal.aborted) {
                const reason = escalationWatcher.getReason()!;
                const detail = escalationWatcher.getDetail();
                console.log(yellow(`      [!] Escalation triggered: ${reason} — ${detail}`));
                eventBus.emit("task:escalated", { taskId: task.id, reason, detail, timestamp: Date.now() });
                taskAbortController.abort();
              }
            }, 1000);
          }

          // Tool-call wedge watcher — fires when a single tool call (e.g.,
          // Bash running `pnpm verify:vercel` that hangs against a stale
          // port-3000 server) exceeds its budget. Fixes the wedge class
          // of workers that look healthy at the
          // process level (active tool call, recent telemetry) but have
          // not made forward progress for many minutes. Combined with
          // the process-group cleanup, the abort reaps the worker
          // subprocess plus every descendant.
          //
          // Multi-worker caveat: progress events flow through the shared
          // backend interactionHandler with no per-task correlation, so
          // every active task's watcher would see every task's events.
          // For max_workers > 1 we disable the watcher rather than fire
          // false positives. Per-task correlation is a follow-up.
          const toolCallTimeoutMs =
            projectConfig.concurrency.max_workers === 1
              ? projectConfig.concurrency.tool_call_timeout_ms ?? 5 * 60 * 1000
              : 0;
          let toolWedgeWatcher: ToolWedgeWatcher | null = null;
          let toolWedgeProgressHandler: ((event: ProgressEvent) => void) | null = null;
          if (toolCallTimeoutMs > 0) {
            toolWedgeWatcher = new ToolWedgeWatcher(
              { progressWindowMs: toolCallTimeoutMs },
              ({ activeCount, elapsedMs, activeTools }) => {
                if (taskAbortController.signal.aborted) return;
                console.log(
                  red(
                    `      [!] Tool wedge: ${activeCount} tool(s) active, ` +
                      `silent for ${(elapsedMs / 1000).toFixed(0)}s ` +
                      `(window: ${(toolCallTimeoutMs / 1000).toFixed(0)}s) — aborting task`,
                  ),
                );
                logActiveToolsSnapshot(activeTools);
                eventBus.emit("task:tool_wedged", {
                  taskId: task.id,
                  activeToolCount: activeCount,
                  elapsedMs,
                  thresholdMs: toolCallTimeoutMs,
                  activeTools,
                  timestamp: Date.now(),
                });
                taskAbortController.abort();
              },
            );
            toolWedgeProgressHandler = (event: ProgressEvent) => {
              toolWedgeWatcher?.onProgress(event);
            };
            eventBus.on("backend:progress", toolWedgeProgressHandler);
            toolWedgeWatcher.start();
          }

          // Force-rejection promise — rejects when wedge fires AND grace
          // period elapses without the worker honoring the abort signal.
          // Promise.race'd against runWithOversight below so the dispatch
          // loop unblocks even when the claude-code SDK ignores
          // taskAbortController.abort() (a known failure mode that
          // motivated the workerHeartbeatMs watchdog — same
          // class of bug here at finer granularity).
          const wedgeForceRejectPromise: Promise<never> = toolWedgeWatcher
            ? toolWedgeWatcher.forceRejectionPromise()
            : new Promise<never>(() => {}); // never resolves when no watcher

          // Mirror the dispatch into the swarm/TaskExecution Substrate entity as a
          // running row, holding its id so the post-worker block can flip it
          // terminal. The start helper awaits its create (the id is needed
          // downstream) but never throws — a Substrate failure yields null and the
          // end call below no-ops. This ADDS a telemetry mirror; the
          // authoritative dispatch state stays the in-memory
          // capturedTaskOutcomes / goal.status tracking, untouched here.
          const taskExecutionId = substrateClient
            ? await mirrorTaskExecutionStart(substrateClient, {
                goalId: goal.id,
                sessionId: orchestrator.getSessionId(),
                status: "running",
                retries: 0,
                startedAt: new Date(taskStartTime).toISOString(),
              })
            : null;

          let result: SwarmOversightRunResult;
          // In the task's scope, so its result counts every session it made.
          const scoped = sessionLedger.startTask(() => swarm.runWithOversight(task.description, {
              input: buildTaskInput(goal, task, directive, null),
              project: projectConfig.project,
              intentOverride: task.intent,
              additionalContext: buildDirectiveContext(directive),
              workingDirectory: workingDir,
              taskTokenLimit: orchestrator.getTaskTokenLimit(),
              abortSignal: taskAbortController.signal,
              reviewRequired: directive.directive.review_required,
              maxTurns: projectConfig.maxTurns,
            }));
          try {
            result = await Promise.race([scoped.result, wedgeForceRejectPromise]);
          } catch (err) {
            // Wedged: what the task spent, and spends from here, goes to the run.
            scoped.abandon();
            throw err;
          } finally {
            if (escalationInterval) clearInterval(escalationInterval);
            escalationWatcher?.dispose();
            toolWedgeWatcher?.stop();
            if (toolWedgeProgressHandler) {
              eventBus.off("backend:progress", toolWedgeProgressHandler);
            }
          }

          const taskLatency = Date.now() - taskStartTime;
          // The dashboard's split. The budget total for pooled tasks is charged
          // by dispatchParallel itself (orchestrator.addTokens per result, which
          // its session and goal checks read before starting the next task),
          // so this adds to the split only — charging here too would double count.
          const taskTokens = spendTokens(result);
          sessionTokens = addTokenBreakdown(sessionTokens, taskTokens);

          eventBus.emit("task:verdict", {
            taskId: task.id,
            verdict: String(result.oversight.verdict),
            latencyMs: taskLatency,
            retryCount: result.oversight.retryCount,
            arbiterInvolved: result.oversight.arbiterInvolved,
            tokens: taskTokens,
            ...verdictDetail(result.oversight),
            timestamp: Date.now(),
          });
          recordTaskOutcome(task, goal.id, result, taskLatency);

          // Flip the mirrored TaskExecution terminal, fire-and-forget. Status is
          // derived from the SAME computeTaskStatus helper that drives the
          // in-memory state, then narrowed to the TaskExecution terminal set so
          // the mirror stays consistent: blocked (humanEscalation), completed
          // (any SUCCESS_TASK_STATUSES verdict — incl. the *_with_notes/_deferrals
          // variants the in-memory success branch also treats as success), else
          // failed. A null id from a failed start makes this a no-op.
          //
          // The WorkerResult id isn't surfaced by Swarm's atomic
          // persistTaskTelemetry flush, so it's unknown at this call site — the
          // terminal flip stamps everything BUT workerResultId. A follow-up
          // best-effort link resolves the WorkerResult by this worker session and
          // stamps its id; it sends only { id, workerResultId } so it's
          // field-disjoint from (and race-safe with) the flip above. Both are
          // fire-and-forget — neither blocks nor throws on the dispatch hot path.
          if (substrateClient && taskExecutionId) {
            const taskStatus = computeTaskStatus(result.oversight);
            const mirrorEndStatus =
              taskStatus === "blocked"
                ? "blocked"
                : SUCCESS_TASK_STATUSES.has(taskStatus)
                  ? "completed"
                  : "failed";
            mirrorTaskExecutionEnd(substrateClient, taskExecutionId, {
              status: mirrorEndStatus,
              completedAt: new Date().toISOString(),
              retries: result.oversight.retryCount,
            });
            linkTaskExecutionWorkerResult(substrateClient, taskExecutionId, result.sessionId);
          }

          emitTokensUpdate();

          const verdict = result.oversight.verdict;
          console.log(`${ts()}      ${bold("Verdict:")}  ${verdictColor(String(verdict))}`);
          console.log(`${ts()}      ${bold("Tokens:")}   ${formatTokens(resultTokens(result))}`);
          console.log(`${ts()}      ${bold("Latency:")}  ${formatDuration(taskLatency)}`);
          console.log("");

          return result;
        },
        onTaskComplete: async (task: Task, result: SwarmOversightRunResult | null, error?: Error) => {
          if (error && loginStop.tripped) {
            // Not the task's failure: it runs again when the run resumes.
            await backend.updateTask(task.id, { status: "pending" });
          } else if (error) {
            await backend.updateTask(task.id, { status: "failed", result: { output: error.message, latency_ms: 0, retry_count: 0 } });
            tasksFailedThisSession++;
            orchestrator.recordEvent("task_failed", error.message, { goal_id: goal.id, task_id: task.id });
          } else if (result) {
            const verdict = result.oversight.verdict;
            const taskStatus = computeTaskStatus(result.oversight);

            if (!result.oversight.humanEscalation) {
              await backend.updateTask(task.id, {
                status: taskStatus,
                result: { output: result.output.slice(0, 500), latency_ms: result.latencyMs, oversight_verdict: String(verdict), retry_count: result.oversight.retryCount, tokens: tokenBreakdown(result.tokensUsed) },
              });
            }

            if (taskStatus === "failed") {
              tasksFailedThisSession++;
            }

            // In parallel mode, interactive prompts are not possible — record the overrun explicitly
            if (result.tokenLimitExceeded) {
              const used = resultTokens(result);
              const line = describeTaskOverrun(task.title ?? task.id, used, orchestrator.getTaskTokenLimit());
              console.log(yellow(`      [!] ${line}`));
              orchestrator.recordEvent("task_token_exceeded", line, {
                goal_id: goal.id, task_id: task.id, tokens: used, cumulative_tokens: orchestrator.getCumulativeTokens(),
              });
            }

            const taskIsSuccess = SUCCESS_TASK_STATUSES.has(taskStatus);
            if (taskIsSuccess) {
              completedTasks.push(task.id);
              const pendingIdx = allPendingTaskIds.indexOf(task.id);
              if (pendingIdx !== -1) allPendingTaskIds.splice(pendingIdx, 1);

              // Intra-goal context reset: create a fresh Swarm instance every 4
              // completed tasks to prevent context overflow within large goals.
              // The orchestrator's token totals and goal summaries are preserved.
              if (completedTasks.length % 4 === 0) {
                swarm = new Swarm(swarmConfig, makeSwarmDeps());
                console.log(ts() + dim(` [context reset after ${completedTasks.length} tasks]`));
              }
            }

            // Compute worktree outcome with claim accuracy
            const mergeOutcome = mergeOutcomes.get(task.id);
            const claimedFiles = [...(taskCreatesMap.get(task.id) || []), ...(task.serializedFiles || [])];
            const actualFiles = mergeOutcome?.filesChanged || [];
            const accuracy = claimedFiles.length > 0 || actualFiles.length > 0
              ? computeClaimAccuracy(claimedFiles, actualFiles)
              : 1;

            const worktreeOutcome = mergeOutcome ? {
              files_actually_changed: actualFiles,
              claim_accuracy: accuracy,
              merge_result: mergeOutcome.mergeResult,
              conflict_files: mergeOutcome.conflictFiles,
            } : undefined;

            orchestrator.recordEvent(
              taskStatus === "completed" ? "task_completed" : "task_failed",
              `${task.description} — ${verdict}`,
              {
                goal_id: goal.id,
                task_id: task.id,
                tokens: resultTokens(result),
                cumulative_tokens: orchestrator.getCumulativeTokens(),
                worktree_outcome: worktreeOutcome,
              },
            );
          }

          // Save checkpoint after each completed task
          await orchestrator.saveCheckpoint({
            session_id: orchestrator.getSessionId(),
            swarm_version: "HEAD",
            project: projectConfig.project,
            current_goal: goal.id,
            current_task: null,
            completed_tasks: [...completedTasks],
            pending_tasks: allPendingTaskIds.filter((id) => !completedTasks.includes(id) && !skippedTasks.includes(id)),
            skipped_tasks: [...skippedTasks],
            blocked: false,
          });
        },
        // SDK-25: Per-task timeout scaled by each task's actual complexity band
        taskTimeoutMs: (task: Task) => {
          const band = task.complexity?.band ?? estimateComplexity(task.description, complexityThresholds).band;
          return getTimeoutForComplexity(band);
        },
        // SDK-25: When a task times out, attempt sub-decomposition — only when
        // the goal's decomposition policy allows splitting on failure.
        // Otherwise a timed-out task fails like any other.
        onTaskTimeout: !goalDecomposition.reactive ? undefined : async (timedOutTask: Task) => {
          console.log(yellow(`    [!] Task "${timedOutTask.title ?? timedOutTask.id}" timed out — attempting decomposition`));
          try {
            // Its sessions are charged to the run as they finish (SessionLedger).
            const decomposition = await subDecompose(swarm, timedOutTask, goal, projectConfig.project);
            if (decomposition.subTasks.length > 0) {
              console.log(cyan(`    Decomposed into ${decomposition.subTasks.length} sub-tasks`));
              for (const sub of decomposition.subTasks) {
                console.log(dim(`      - ${sub.title ?? sub.description}`));
                await registerTask(sub).catch(() => {});
              }
              return decomposition.subTasks;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(red(`    Decomposition failed: ${msg}`));
          }
          return [];
        },
        // Pass the global rate limit gate so all workers pause together
        rateLimitGate,
      });

      goalTokens = dispatchResult.totalTokens;
      totalTasksRun += dispatchResult.completed.length + dispatchResult.failed.length;
      // tasksFailedThisSession already incremented in onTaskComplete callback
      // for each failed task — do not add dispatchResult.failed.length here

      if (dispatchResult.failed.length > 0) {
        console.log(red(`    ${dispatchResult.failed.length} task(s) failed:`));
        for (const f of dispatchResult.failed) {
          console.log(red(`      - ${f.task.description}: ${f.error.message}`));
        }
      }
      if (dispatchResult.skipped.length > 0) {
        console.log(dim(`    ${dispatchResult.skipped.length} task(s) skipped (token/abort limit)`));
        skippedTasks.push(...dispatchResult.skipped.map(t => t.id));
      }

    } else {
      // --- Sequential dispatch (original behavior) ---

      // Queue-based task loop — supports mid-iteration sub-task insertion
      const taskQueue: Task[] = [...tasks];
      // Cache for speculative sub-decomposition results (keyed by task ID)
      const pendingSubDecomps = new Map<string, Promise<SubDecompositionResult>>();

      while (taskQueue.length > 0) {
        if (pauseRequested) break;

        const task = taskQueue.shift()!;

        // Skip already completed tasks
        if (completedTasks.includes(task.id)) {
          console.log(dim(`    Skipping ${task.id} (already completed)`));
          continue;
        }

        // Skip tasks previously skipped for going over their token limit
        if (skippedTasks.includes(task.id)) {
          console.log(dim(`    Skipping ${task.id} (previously skipped — over its token limit)`));
          continue;
        }

        // ---------------------------------------------------------------
        // Budget checks before running the task, in tokens: warn once at
        // 80% of the session limit, pause the moment it is exceeded, and
        // stop the goal once its token limit is exceeded.
        // ---------------------------------------------------------------

        const cumulativeTokens = orchestrator.getCumulativeTokens();

        const budget = evaluateSessionBudget(orchestrator, cumulativeTokens, { tokenWarningIssued });

        if (budget.warnTokens) {
          tokenWarningIssued = true;
          console.log(yellow(`  [!] Token warning: ${cumulativeTokens.toLocaleString()} tokens — approaching session limit`));
          orchestrator.recordEvent("token_warning", `Tokens at ${cumulativeTokens.toLocaleString()}`, {
            cumulative_tokens: cumulativeTokens,
          });
        }

        // Pause once the session token limit is exceeded.
        if (budget.abort) {
          console.log(red(`  [X] Session token limit exceeded: ${cumulativeTokens.toLocaleString()} tokens`));
          console.log(dim("      Pausing execution. Increase the limit or start a new session."));
          orchestrator.recordEvent("token_limit_reached", `Token limit exceeded at ${cumulativeTokens.toLocaleString()}`, {
            cumulative_tokens: cumulativeTokens,
          });
          pauseRequested = true;
          break;
        }

        // Goal token check
        if (orchestrator.isGoalTokenExceeded(goalSpend())) {
          console.log(yellow(`  [!] Goal token limit exceeded: ${goalSpend().toLocaleString()} tokens`));
          console.log(dim("      Skipping remaining tasks for this goal."));
          break;
        }

        // ---------------------------------------------------------------
        // Complexity estimation
        // ---------------------------------------------------------------

        const { complexity, split: splitPlan } = classifyTaskForDispatch(task, complexityThresholds, goalDecomposition);
        task.complexity = complexity;

        eventBus.emit("complexity:estimated", {
          taskId: task.id,
          score: complexity.score,
          band: complexity.band,
          signals: complexity.signals,
          reasoning: complexity.reasoning,
          timestamp: Date.now(),
        });

        const bandLabel = complexity.band === "simple" ? dim(complexity.band)
          : complexity.band === "moderate" ? yellow(complexity.band)
          : red(complexity.band);
        console.log(ts() + dim(` complexity: ${bandLabel} ${dim(`(score=${complexity.score})`)}`));

        // ---------------------------------------------------------------
        // Complexity-based gating, as the goal's decomposition policy allows
        // ---------------------------------------------------------------

        if (complexity.band === "complex" && task.parentTaskId) {
          // Subtasks are never further decomposed regardless of complexity
          console.log(dim(`      Complex subtask — executing as-is (depth limit: subtasks cannot be decomposed)`));
        } else if (complexity.band === "complex" && splitPlan.proactive !== "pre_split") {
          console.log(dim(`      Complex task — executing as-is (decomposition: ${describeDecomposition(goalDecomposition)})`));
        }

        if (splitPlan.proactive === "pre_split") {
          // Decomposition loop detection: if we've already decomposed tasks for
          // this goal but none have completed, we're in a loop. Execute instead.
          const goalTasks = tasks.filter(t => !completedTasks.includes(t.id) && !skippedTasks.includes(t.id));
          const decompositionsWithoutProgress = goalTasks.filter(t => t.subTaskIds && t.subTaskIds.length > 0).length;
          if (decompositionsWithoutProgress > 0) {
            console.log(yellow(`      Decomposition loop detected (${decompositionsWithoutProgress} prior decomposition(s) without completion) — executing as-is`));
            orchestrator.recordEvent("decomposition_loop_detected", `Task ${task.id} would be sub-decomposed but ${decompositionsWithoutProgress} prior decomposition(s) produced no completions`, {
              goal_id: goal.id, task_id: task.id,
            });
          } else {
          // Complex tasks: sub-decompose BEFORE execution (only top-level tasks)
          console.log(yellow(`      Complex task detected — sub-decomposing before execution...`));

          let subResult: SubDecompositionResult;
          try {
            subResult = await subDecompose(swarm, task, goal, projectConfig.project);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(dim(`      Sub-decomposition failed: ${msg} — executing as-is`));
            subResult = { subTasks: [], reasoning: msg };
          }

          if (subResult.subTasks.length > 0) {
            console.log(cyan(`      Split into ${subResult.subTasks.length} sub-tasks:`));
            for (const st of subResult.subTasks) {
              console.log(dim(`        - [${st.intent}] ${st.description}`));
            }

            // Record parent as decomposed, insert sub-tasks at front of queue
            task.subTaskIds = subResult.subTasks.map(st => st.id);
            await backend.updateTask(task.id, { status: "completed" });
            completedTasks.push(task.id);

            eventBus.emit("task:aborted", {
              taskId: task.id,
              reason: "complexity_preemptive",
              subTaskCount: subResult.subTasks.length,
              tokens: spendTokens(subResult),
              timestamp: Date.now(),
            });

            // Register and insert sub-tasks at the front of the queue
            for (const st of subResult.subTasks) {
              try { await registerTask(st); } catch { /* may exist */ }
              allPendingTaskIds.push(st.id);
            }
            taskQueue.unshift(...subResult.subTasks);

            // The split's own sessions were charged to the run, and so to
            // this goal's overhead, as they finished (SessionLedger); the
            // sub-tasks' are charged when they run.
            continue; // Process the first sub-task on next iteration
          }
          // If sub-decomposition returned nothing, fall through and execute normally
          } // end else (no loop detected)
        }

        if (splitPlan.proactive === "speculative") {
          // Moderate tasks: start speculative sub-decomposition concurrently (only top-level tasks)
          console.log(dim(`      Starting concurrent sub-decomposition (speculative)...`));
          pendingSubDecomps.set(
            task.id,
            subDecompose(swarm, task, goal, projectConfig.project).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(dim(`      Speculative sub-decomp failed: ${msg}`));
              return { subTasks: [], reasoning: msg } as SubDecompositionResult;
            }),
          );
        }

        // ---------------------------------------------------------------
        // Build directive and execute
        // ---------------------------------------------------------------

        const directive = orchestrator.buildDirective(goal, task);

        // Sub-tasks add parent context as an additional constraint
        if (task.parentTaskId) {
          directive.directive.constraints.push(
            `This is a sub-task of a larger task that was decomposed due to complexity`,
          );
          directive.directive.escalation_triggers.push(
            `Sub-task scope creep beyond: ${task.description}`,
          );
        }

        console.log(`${ts()}    ${magenta(">")} ${task.description}`);
        console.log(dim(`      intent=${task.intent}  review=${directive.directive.review_required ? "yes" : "no"}`));

        orchestrator.recordEvent("task_dispatched", task.description, {
          goal_id: goal.id,
          task_id: task.id,
          dispatch_directive: directive,
        });

        await backend.updateTask(task.id, { status: "in_progress" });

        eventBus.emit("task:start", {
          taskId: task.id,
          goalId: goal.id,
          title: task.title,
          description: task.description,
          intent: task.intent,
          parentTaskId: task.parentTaskId,
          source: task.source,
          timestamp: Date.now(),
        });

        const taskStartTime = Date.now();
        let result: SwarmOversightRunResult;

        const backendLabel = swarm.getConfiguredBackendType();
        console.log(ts() + dim(` Backend: ${backendLabel} (${projectConfig?.models?.worker ?? "default"}, worker)`));

        // Per-task AbortController is now created UNCONDITIONALLY so the
        // tool-call wedge watcher (below) has something to abort on every
        // task, not just moderate-complexity ones. The escalation watcher
        // continues to be moderate-only — its token/turn heuristics aren't
        // useful for simple/complex tasks — and runs only when the goal's
        // decomposition policy allows splitting on failure, since splitting
        // is its only recovery.
        const taskAbortController = new AbortController();
        const escalationWatcher = splitPlan.armEscalationWatcher
          ? createEscalationWatcher(eventBus, task.id, complexityThresholds, {
              tokenLimit: orchestrator.getTaskTokenLimit(),
              maxTurns: 50,
              timeoutMs: getTimeoutForComplexity(complexity.band),
            })
          : null;

        // Poll escalation watcher periodically for moderate tasks
        let escalationInterval: ReturnType<typeof setInterval> | null = null;
        if (escalationWatcher) {
          escalationInterval = setInterval(() => {
            if (escalationWatcher.isTriggered() && !taskAbortController.signal.aborted) {
              const reason = escalationWatcher.getReason()!;
              const detail = escalationWatcher.getDetail();
              console.log(yellow(`      [!] Escalation triggered: ${reason} — ${detail}`));

              eventBus.emit("task:escalated", {
                taskId: task.id,
                reason,
                detail,
                timestamp: Date.now(),
              });

              taskAbortController.abort();
            }
          }, 1000);
        }

        // Tool-call wedge watcher — see the parallel-dispatch site for the
        // full rationale. Sequential dispatch hits
        // the same wedge mechanism: a Bash tool that backgrounds a
        // long-running process whose ambient stdout keeps Claude Code's
        // bash-tool idle timer alive forever.
        const toolCallTimeoutMs =
          projectConfig.concurrency.max_workers === 1
            ? projectConfig.concurrency.tool_call_timeout_ms ?? 5 * 60 * 1000
            : 0;
        let toolWedgeWatcher: ToolWedgeWatcher | null = null;
        let toolWedgeProgressHandler: ((event: ProgressEvent) => void) | null = null;
        if (toolCallTimeoutMs > 0) {
          toolWedgeWatcher = new ToolWedgeWatcher(
            { progressWindowMs: toolCallTimeoutMs },
            ({ activeCount, elapsedMs, activeTools }) => {
              if (taskAbortController.signal.aborted) return;
              console.log(
                red(
                  `      [!] Tool wedge: ${activeCount} tool(s) active, ` +
                    `silent for ${(elapsedMs / 1000).toFixed(0)}s ` +
                    `(window: ${(toolCallTimeoutMs / 1000).toFixed(0)}s) — aborting task`,
                ),
              );
              logActiveToolsSnapshot(activeTools);
              eventBus.emit("task:tool_wedged", {
                taskId: task.id,
                activeToolCount: activeCount,
                elapsedMs,
                thresholdMs: toolCallTimeoutMs,
                activeTools,
                timestamp: Date.now(),
              });
              taskAbortController.abort();
            },
          );
          toolWedgeProgressHandler = (event: ProgressEvent) => {
            toolWedgeWatcher?.onProgress(event);
          };
          eventBus.on("backend:progress", toolWedgeProgressHandler);
          toolWedgeWatcher.start();
        }

        // Force-rejection promise — see the parallel-dispatch site above
        // for the full rationale. Same pattern: race the task against a
        // wedge-triggered rejection so the dispatch loop unblocks even
        // when the worker subprocess ignores the abort signal.
        const wedgeForceRejectPromise: Promise<never> = toolWedgeWatcher
          ? toolWedgeWatcher.forceRejectionPromise()
          : new Promise<never>(() => {});

        // Mirror the dispatch into the swarm/TaskExecution Substrate entity as a
        // running row, holding its id so the post-worker block can flip it
        // terminal — same pattern as the parallel-pool site above. The start
        // helper awaits its create (the id is needed downstream) but never
        // throws; a Substrate failure yields null and the end call below no-ops.
        // Mirror only — the authoritative dispatch state stays the in-memory
        // capturedTaskOutcomes / goal.status tracking, untouched here.
        const taskExecutionId = substrateClient
          ? await mirrorTaskExecutionStart(substrateClient, {
              goalId: goal.id,
              sessionId: orchestrator.getSessionId(),
              status: "running",
              retries: 0,
              startedAt: new Date(taskStartTime).toISOString(),
            })
          : null;

        // In the task's scope, so its result counts every session it made.
        const scoped = sessionLedger.startTask(() => swarm.runWithOversight(task.description, {
            input: buildTaskInput(goal, task, directive, currentBranch),
            project: projectConfig.project,
            intentOverride: task.intent,
            additionalContext: buildDirectiveContext(directive),
            workingDirectory: repoRoot,
            taskTokenLimit: orchestrator.getTaskTokenLimit(),
            abortSignal: taskAbortController.signal,
            reviewRequired: directive.directive.review_required,
              maxTurns: projectConfig.maxTurns,
          }));
        try {
          result = await Promise.race([scoped.result, wedgeForceRejectPromise]);
        } catch (err) {
          // Failed or wedged: what the task spent, and spends from here, goes to the run.
          scoped.abandon();
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.log(`      ${red("FAILED:")} ${errorMessage}`);

          if (loginStop.tripped) {
            // Not the task's failure: it runs again when the run resumes.
            await backend.updateTask(task.id, { status: "pending" });
            pendingSubDecomps.delete(task.id);
            continue;
          }

          await backend.updateTask(task.id, {
            status: "failed",
            result: {
              output: errorMessage,
              latency_ms: Date.now() - taskStartTime,
              retry_count: 0,
            },
          });
          tasksFailedThisSession++;

          orchestrator.recordEvent("task_failed", errorMessage, {
            goal_id: goal.id,
            task_id: task.id,
          });

          // Detect non-retryable API errors using structured error types
          let isApiError = false;
          try {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            isApiError = err instanceof Anthropic.AuthenticationError ||
              err instanceof Anthropic.PermissionDeniedError ||
              (err instanceof Anthropic.APIError && (err.status === 402 || err.status === 403));
          } catch {
            // SDK not available — fall back to message matching as last resort
            isApiError = errorMessage.includes("credit balance") ||
              errorMessage.includes("authentication_error");
          }

          if (isApiError) {
            consecutiveApiFailures++;
            if (consecutiveApiFailures >= MAX_CONSECUTIVE_API_FAILURES) {
              console.log(red(`\n  [X] ${consecutiveApiFailures} consecutive API failures. Halting execution.`));
              console.log(dim("      Check your API key and billing status."));
              pauseRequested = true;
            }
          } else {
            consecutiveApiFailures = 0;
          }

          // Clean up speculative sub-decomposition on error path
          pendingSubDecomps.delete(task.id);

          continue;
        } finally {
          // Clean up escalation watcher and leaked sub-decomp promises on error
          if (escalationInterval) clearInterval(escalationInterval);
          escalationWatcher?.dispose();
          toolWedgeWatcher?.stop();
          if (toolWedgeProgressHandler) {
            eventBus.off("backend:progress", toolWedgeProgressHandler);
          }
        }

        // ---------------------------------------------------------------
        // Handle escalation-triggered abort for moderate tasks
        // ---------------------------------------------------------------

        if (taskAbortController?.signal.aborted && escalationWatcher?.isTriggered()) {
          const reason = escalationWatcher.getReason()!;
          console.log(yellow(`      Task aborted due to escalation: ${reason}`));

          // Use the speculative sub-plan ("auto"); without one ("on_failure"
          // makes none), split the task now.
          let pendingSplit = pendingSubDecomps.get(task.id);
          if (!pendingSplit && goalDecomposition.reactive && !task.parentTaskId) {
            console.log(dim(`      Sub-decomposing after the escalation...`));
            pendingSplit = subDecompose(swarm, task, goal, projectConfig.project).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(dim(`      Sub-decomposition failed: ${msg}`));
              return { subTasks: [], reasoning: msg } as SubDecompositionResult;
            });
          }
          if (pendingSplit) {
            const subResult = await pendingSplit;
            pendingSubDecomps.delete(task.id);

            if (subResult.subTasks.length > 0) {
              console.log(cyan(`      Dispatching ${subResult.subTasks.length} sub-tasks from the decomposition:`));
              for (const st of subResult.subTasks) {
                console.log(dim(`        - [${st.intent}] ${st.description}`));
              }

              task.subTaskIds = subResult.subTasks.map(st => st.id);

              eventBus.emit("task:aborted", {
                taskId: task.id,
                reason,
                subTaskCount: subResult.subTasks.length,
                tokens: spendTokens(result, subResult),
                timestamp: Date.now(),
              });

              // Mark parent as interrupted, register sub-tasks
              await backend.updateTask(task.id, { status: "interrupted" });
              for (const st of subResult.subTasks) {
                try { await registerTask(st); } catch { /* may exist */ }
                allPendingTaskIds.push(st.id);
              }
              taskQueue.unshift(...subResult.subTasks);

              // The task's result; the split's own sessions were charged to
              // the run as they finished (SessionLedger).
              const splitCharge = chargeSession(orchestrator, sessionTokens, result);
              sessionTokens = splitCharge.sessionTokens;
              goalTokens += tokenBreakdownTotal(splitCharge.tokens);
              totalTasksRun++;

              continue; // Process sub-tasks on next iteration
            }
          }
          // If no sub-tasks available, fall through to normal result processing
        }

        // Discard unused speculative sub-decomposition for tasks that completed successfully
        if (pendingSubDecomps.has(task.id)) {
          pendingSubDecomps.delete(task.id);
        }

        // ---------------------------------------------------------------
        // Process result
        // ---------------------------------------------------------------

        const taskLatency = Date.now() - taskStartTime;
        const taskTokenCount = resultTokens(result);

        // Log actual backend used (may differ from configured if fallback occurred)
        if (result.backendType && result.backendType !== backendLabel) {
          console.log(dim(`      actual backend: ${result.backendType} (fallback=${result.fallbackUsed ?? false})`));
        }

        const charged = chargeSession(orchestrator, sessionTokens, result);
        sessionTokens = charged.sessionTokens;
        const taskTokens = charged.tokens;
        goalTokens += taskTokenCount;
        totalTasksRun++;

        eventBus.emit("task:verdict", {
          taskId: task.id,
          verdict: String(result.oversight.verdict),
          latencyMs: taskLatency,
          retryCount: result.oversight.retryCount,
          arbiterInvolved: result.oversight.arbiterInvolved,
          tokens: taskTokens,
          ...verdictDetail(result.oversight),
          timestamp: Date.now(),
        });
        recordTaskOutcome(task, goal.id, result, taskLatency);

        // Flip the mirrored TaskExecution terminal, fire-and-forget — same
        // pattern as the parallel-pool site. Status derives from the SAME
        // computeTaskStatus helper that drives the in-memory state, narrowed to
        // the TaskExecution terminal set: blocked (humanEscalation), completed
        // (any SUCCESS_TASK_STATUSES verdict), else failed. A null id from a
        // failed start makes this a no-op.
        //
        // workerResultId is unknown at this call site (Swarm's atomic
        // persistTaskTelemetry flush doesn't surface the WorkerResult id), so the
        // flip omits it and a follow-up best-effort link resolves the WorkerResult
        // by this worker session and stamps its id. The link sends only
        // { id, workerResultId } — field-disjoint from and race-safe with the flip
        // — and is fire-and-forget: it never blocks nor throws on the hot path.
        if (substrateClient && taskExecutionId) {
          const mirrorStatus = computeTaskStatus(result.oversight);
          const mirrorEndStatus =
            mirrorStatus === "blocked"
              ? "blocked"
              : SUCCESS_TASK_STATUSES.has(mirrorStatus)
                ? "completed"
                : "failed";
          mirrorTaskExecutionEnd(substrateClient, taskExecutionId, {
            status: mirrorEndStatus,
            completedAt: new Date().toISOString(),
            retries: result.oversight.retryCount,
          });
          linkTaskExecutionWorkerResult(substrateClient, taskExecutionId, result.sessionId);
        }

        emitTokensUpdate();

        // Print result summary
        const verdict = result.oversight.verdict;
        console.log(`${ts()}      ${bold("Verdict:")}  ${verdictColor(String(verdict))}`);
        console.log(`      ${bold("Tokens:")}   ${formatTokens(taskTokenCount)}  ${dim(`(session total: ${formatTokens(orchestrator.getCumulativeTokens())})`)}`);
        console.log(`${ts()}      ${bold("Latency:")}  ${formatDuration(taskLatency)}`);

        if (result.oversight.rejectionReasons.length > 0) {
          console.log(`      ${bold("Reasons:")}  ${result.oversight.rejectionReasons.join("; ")}`);
        }

        if (result.oversight.arbiterInvolved) {
          console.log(`      ${yellow("Arbiter was involved")}`);
        }

        if (result.oversight.humanEscalation) {
          console.log(`      ${red("Escalated to human")}`);
          await backend.escalate(task.id, result.oversight.rejectionReasons.join("; "));
          orchestrator.recordEvent("escalation_triggered", "Human escalation required", {
            goal_id: goal.id,
            task_id: task.id,
            escalation_reason: result.oversight.rejectionReasons.join("; "),
          });
        }

        console.log("");

        // Handle tasks that went over their token limit
        if (result.tokenLimitExceeded) {
          await backend.updateTask(task.id, { status: "token_exceeded" });
          const taskTokenLimit = orchestrator.getTaskTokenLimit();
          console.log("");
          console.log(yellow(`  ${describeTaskOverrun(task.description?.slice(0, 60) ?? task.id, taskTokenCount, taskTokenLimit)}`));
          if (result.oversight?.verdict === "approved") {
            console.log(dim("  The task output was approved by the Reviewer."));
          }

          const overrunChoice = await promptUser(
            "How would you like to proceed?",
            ["increase", "skip", "abort"],
          );
          const overrun = resolveTaskOverrun(overrunChoice, taskTokenCount, taskTokenLimit);

          if (overrun.action === "increase") {
            orchestrator.updateTaskTokenLimit(overrun.newLimit!);
            console.log(green(`  ${overrun.message}`));
            orchestrator.recordEvent(overrun.event!.type, overrun.event!.detail, {
              tokens: overrun.event!.tokens,
              cumulative_tokens: orchestrator.getCumulativeTokens(),
            });
          } else if (overrun.action === "skip") {
            skippedTasks.push(task.id);
            await backend.updateTask(task.id, { status: "skipped_tokens" });
            orchestrator.recordEvent(overrun.event!.type, overrun.event!.detail, {
              task_id: task.id,
              tokens: overrun.event!.tokens,
              cumulative_tokens: orchestrator.getCumulativeTokens(),
            });
            // Save checkpoint so the skip is persisted across restarts
            await orchestrator.saveCheckpoint({
              session_id: orchestrator.getSessionId(),
              swarm_version: "HEAD",
              project: projectConfig.project,
              current_goal: goal.id,
              current_task: null,
              completed_tasks: [...completedTasks],
              pending_tasks: allPendingTaskIds.filter((id) => !completedTasks.includes(id) && !skippedTasks.includes(id)),
              skipped_tasks: [...skippedTasks],
              blocked: false,
            });
            console.log(dim(`  ${overrun.message}`));
            continue;
          } else {
            console.log(dim(`  ${overrun.message}`));
            await orchestrator.saveCheckpoint({
              session_id: orchestrator.getSessionId(),
              swarm_version: "HEAD",
              project: projectConfig.project,
              current_goal: goal.id,
              current_task: task.id,
              completed_tasks: [...completedTasks],
              pending_tasks: allPendingTaskIds.filter((id) => !completedTasks.includes(id)),
              skipped_tasks: [...skippedTasks],
              blocked: false,
            });
            pauseRequested = true;
            break;
          }
        }

        // Update task status (but don't overwrite "blocked" from escalation)
        const taskStatus = computeTaskStatus(result.oversight);

        if (!result.oversight.humanEscalation) {
          await backend.updateTask(task.id, {
            status: taskStatus,
            result: {
              output: result.output.slice(0, 500),
              latency_ms: taskLatency,
              oversight_verdict: String(verdict),
              retry_count: result.oversight.retryCount,
              tokens: taskTokens,
            },
          });
        }

        if (taskStatus === "failed") {
          tasksFailedThisSession++;
        }

        const taskIsSuccess = SUCCESS_TASK_STATUSES.has(taskStatus);
        orchestrator.recordEvent(
          taskIsSuccess ? "task_completed" : "task_failed",
          `${task.description} — ${verdict}`,
          {
            goal_id: goal.id,
            task_id: task.id,
            tokens: taskTokenCount,
            cumulative_tokens: orchestrator.getCumulativeTokens(),
          },
        );

        if (taskIsSuccess) {
          // Match specific git output patterns like:
          //   "Switched to a new branch 'feat/foo'"
          //   "Already on 'main'"
          //   "Switched to branch 'fix/bar'"
          const branchMatch = result.output.match(/(?:Switched to(?: a new)? branch|Already on)\s+['"]([a-zA-Z0-9/_.-]{1,100})['"]/);
          if (branchMatch) {
            currentBranch = branchMatch[1];
          }
          completedTasks.push(task.id);
          // Reset on success: this counter tracks *consecutive* API failures only.
          // A successful task proves the API is working, so the counter resets.
          consecutiveApiFailures = 0;
          // Remove from pending
          const pendingIdx = allPendingTaskIds.indexOf(task.id);
          if (pendingIdx !== -1) allPendingTaskIds.splice(pendingIdx, 1);

          // Live-repo commit. commitLiveRepo was first wired
          // into Orchestrator._dispatchFlat only — but this sequential
          // loop calls swarm.runWithOversight directly, bypassing the
          // orchestrator's dispatch path. On max_workers=1 setups this
          // path runs every task and zero commits ever land. Best-effort:
          // commitLiveRepo emits commit_failed and continues on git error.
          await orchestrator.commitLiveRepo(task, { goalBranch: currentGoalBranch });
        }

        // Task token check (the limit itself is enforced above via tokenLimitExceeded)
        if (orchestrator.isTaskTokenExceeded(taskTokenCount)) {
          console.log(yellow(`      [!] Task used many tokens: ${formatTokens(taskTokenCount)}`));
        }
      }
    } // end sequential/parallel branch

    // -------------------------------------------------------------------
    // Validation-remediation loop
    // -------------------------------------------------------------------
    // After all tasks complete, check if any failed. If so, ask the
    // orchestrator to create remediation tasks (including a new validation
    // task) and execute them. Repeat up to MAX_REMEDIATION_ITERATIONS.
    // -------------------------------------------------------------------

    let remediationIteration = 0;

    // ---------------------------------------------------------------
    // Replan analysis — categorize failures and decide remediation strategy
    // ---------------------------------------------------------------
    const goalTaskIds = tasks.map(t => t.id);
    const replanResults: ReplanTaskResult[] = goalTaskIds.map(id => {
      const task = tasks.find(t => t.id === id)!;
      const isCompleted = completedTasks.includes(id);
      const output = task.result?.output ?? "";
      return {
        taskId: id,
        status: isCompleted ? "completed" as const : "failed" as const,
        failureReason: isCompleted ? undefined : output,
        retryCount: task.result?.retry_count ?? 0,
        output,
      };
    });

    // An expired login is not the tasks' failure: nothing to analyse or remediate.
    const replanDecision: ReturnType<typeof analyzeGoalResults> = loginStop.tripped
      ? { action: "no_action", reason: "the run stopped because the login expired" }
      : analyzeGoalResults(replanResults, remediationIteration, MAX_REMEDIATION_ITERATIONS);

    if (replanDecision.action === "no_action") {
      // All tasks passed — skip remediation
    } else if (replanDecision.action === "fold_into_next_goal") {
      // Merge conflicts need re-sequencing, not retrying
      console.log(yellow(`  Merge conflict(s) detected — folding ${replanDecision.failedTaskIds?.length ?? 0} failed task(s) into next goal for sequential execution`));
      orchestrator.recordEvent("goal_remediation",
        `Merge conflicts folded to next goal: ${replanDecision.reason}`,
        { goal_id: goal.id },
      );
      // Add failure context to the goal summary so the next goal's prompt includes it
      const conflictContext = (replanDecision.failedTaskIds ?? []).map(id => {
        const task = tasks.find(t => t.id === id);
        return task ? `- ${task.title ?? task.description}: merge conflict` : `- ${id}: merge conflict`;
      }).join("\n");
      if (conflictContext) {
        goal.description += `\n\nPrevious merge conflicts (re-sequence these tasks):\n${conflictContext}`;
      }
    } else if (replanDecision.action === "escalate_human") {
      console.log(red(`  Escalating to human: ${replanDecision.reason}`));
      if (replanDecision.escalationMessage) {
        console.log(dim(`    ${replanDecision.escalationMessage}`));
      }
      orchestrator.recordEvent("escalation_triggered",
        replanDecision.escalationMessage ?? replanDecision.reason,
        { goal_id: goal.id, escalation_reason: replanDecision.reason },
      );
      // Skip remediation loop — human intervention needed
      remediationIteration = MAX_REMEDIATION_ITERATIONS;
    } else if (replanDecision.action === "retry_decomposed") {
      console.log(yellow(`  Replanner: retrying with decomposed tasks — ${replanDecision.reason}`));
      // Let the existing remediation loop handle it, but log the decision
      orchestrator.recordEvent("goal_remediation",
        `Retry with decomposition: ${replanDecision.reason}`,
        { goal_id: goal.id },
      );
    }

    const skipRemediation = replanDecision.action === "no_action" || replanDecision.action === "fold_into_next_goal";
    while (!pauseRequested && !skipRemediation && remediationIteration < MAX_REMEDIATION_ITERATIONS) {
      // Check if any tasks in this goal failed
      const goalTaskIds = tasks.map(t => t.id);
      const failedTaskIds = goalTaskIds.filter(id =>
        !completedTasks.includes(id) && !skippedTasks.includes(id) && !blockedTasks.includes(id),
      );

      if (failedTaskIds.length === 0) break; // All tasks passed — no remediation needed

      remediationIteration++;
      console.log(yellow(`\n  Remediation iteration ${remediationIteration}/${MAX_REMEDIATION_ITERATIONS}`));

      orchestrator.recordEvent("goal_remediation",
        `${failedTaskIds.length} tasks failed — creating remediation tasks (iteration ${remediationIteration})`,
        { goal_id: goal.id },
      );

      // Decompose remediation
      let remediationTasks: Task[];
      try {
        remediationTasks = await decomposeRemediation(
          swarm, goal, projectConfig.project,
          failedTaskIds, tasks, remediationIteration,
          repoRoot,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(red(`    Remediation decomposition failed: ${msg}`));
        break;
      }

      if (remediationTasks.length === 0) {
        console.log(dim("    Remediation decomposition returned no tasks — giving up"));
        break;
      }

      console.log(`    ${cyan(`${remediationTasks.length} remediation tasks:`)}`);
      for (const rt of remediationTasks) {
        console.log(dim(`      ${rt.order}. [${rt.intent}] ${rt.title || rt.description}`));
      }
      console.log("");

      // Register remediation tasks in the backend
      for (const rt of remediationTasks) {
        try { await registerTask(rt); } catch { /* may exist */ }
        allPendingTaskIds.push(rt.id);
      }
      tasks.push(...remediationTasks);

      // Execute remediation tasks sequentially
      for (const task of remediationTasks) {
        if (pauseRequested) break;

        // Token limit checks
        const cumulativeTokens = orchestrator.getCumulativeTokens();
        if (orchestrator.isSessionTokenExceeded(cumulativeTokens)) {
          console.log(red(`  [X] Session token limit exceeded during remediation: ${cumulativeTokens.toLocaleString()} tokens`));
          pauseRequested = true;
          break;
        }

        if (orchestrator.isGoalTokenExceeded(goalSpend())) {
          console.log(red(`  [X] Goal token limit exceeded during remediation: ${goalSpend().toLocaleString()} tokens`));
          pauseRequested = true;
          break;
        }

        const directive = orchestrator.buildDirective(goal, task);

        console.log(`${ts()}    ${magenta(">")} ${task.description}`);
        console.log(dim(`      intent=${task.intent}  review=${directive.directive.review_required ? "yes" : "no"}  [remediation]`));

        await backend.updateTask(task.id, { status: "in_progress" });

        eventBus.emit("task:start", {
          taskId: task.id,
          goalId: goal.id,
          title: task.title,
          description: task.description,
          intent: task.intent,
          source: task.source,
          timestamp: Date.now(),
        });

        const taskStartTime = Date.now();
        let result: SwarmOversightRunResult;

        // Mirror the dispatch into the swarm/TaskExecution Substrate entity as a
        // running row, holding its id so the post-worker block can flip it
        // terminal — same pattern as the parallel-pool site above. The start
        // helper awaits its create (the id is needed downstream) but never
        // throws; a Substrate failure yields null and the end call below no-ops.
        // Mirror only — the authoritative dispatch state stays the in-memory
        // capturedTaskOutcomes / goal.status tracking, untouched here.
        const taskExecutionId = substrateClient
          ? await mirrorTaskExecutionStart(substrateClient, {
              goalId: goal.id,
              sessionId: orchestrator.getSessionId(),
              status: "running",
              retries: 0,
              startedAt: new Date(taskStartTime).toISOString(),
            })
          : null;

        try {
          // In the task's scope, so its result counts every session it made; a
          // failure charges what it spent to the run.
          result = await sessionLedger.startTask(() => swarm.runWithOversight(task.description, {
            input: buildTaskInput(goal, task, directive, null),
            project: projectConfig.project,
            intentOverride: task.intent,
            additionalContext: buildDirectiveContext(directive),
            workingDirectory: repoRoot,
            taskTokenLimit: orchestrator.getTaskTokenLimit(),
            reviewRequired: directive.directive.review_required,
              maxTurns: projectConfig.maxTurns,
          })).result;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.log(`      ${red("FAILED:")} ${errorMessage}`);
          if (loginStop.tripped) {
            // Not the task's failure: it runs again when the run resumes.
            await backend.updateTask(task.id, { status: "pending" });
            continue;
          }
          await backend.updateTask(task.id, {
            status: "failed",
            result: { output: errorMessage, latency_ms: Date.now() - taskStartTime, retry_count: 0 },
          });
          tasksFailedThisSession++;
          continue;
        }

        const taskLatency = Date.now() - taskStartTime;
        const taskTokenCount = resultTokens(result);

        const charged = chargeSession(orchestrator, sessionTokens, result);
        sessionTokens = charged.sessionTokens;
        const taskTokens = charged.tokens;
        goalTokens += taskTokenCount;
        totalTasksRun++;

        emitTokensUpdate();

        eventBus.emit("task:verdict", {
          taskId: task.id,
          verdict: String(result.oversight.verdict),
          latencyMs: taskLatency,
          retryCount: result.oversight.retryCount,
          arbiterInvolved: result.oversight.arbiterInvolved,
          tokens: taskTokens,
          ...verdictDetail(result.oversight),
          timestamp: Date.now(),
        });
        recordTaskOutcome(task, goal.id, result, taskLatency);

        // Flip the mirrored TaskExecution terminal, fire-and-forget — same
        // pattern as the parallel-pool site. Status derives from the SAME
        // computeTaskStatus helper that drives the in-memory state, narrowed to
        // the TaskExecution terminal set: blocked (humanEscalation), completed
        // (any SUCCESS_TASK_STATUSES verdict), else failed. A null id from a
        // failed start makes this a no-op.
        //
        // workerResultId is unknown at this call site (Swarm's atomic
        // persistTaskTelemetry flush doesn't surface the WorkerResult id), so the
        // flip omits it and a follow-up best-effort link resolves the WorkerResult
        // by this worker session and stamps its id. The link sends only
        // { id, workerResultId } — field-disjoint from and race-safe with the flip
        // — and is fire-and-forget: it never blocks nor throws on the hot path.
        if (substrateClient && taskExecutionId) {
          const mirrorStatus = computeTaskStatus(result.oversight);
          const mirrorEndStatus =
            mirrorStatus === "blocked"
              ? "blocked"
              : SUCCESS_TASK_STATUSES.has(mirrorStatus)
                ? "completed"
                : "failed";
          mirrorTaskExecutionEnd(substrateClient, taskExecutionId, {
            status: mirrorEndStatus,
            completedAt: new Date().toISOString(),
            retries: result.oversight.retryCount,
          });
          linkTaskExecutionWorkerResult(substrateClient, taskExecutionId, result.sessionId);
        }

        const verdict = result.oversight.verdict;
        console.log(`${ts()}      ${bold("Verdict:")}  ${verdictColor(String(verdict))}`);
        console.log(`      ${bold("Tokens:")}   ${formatTokens(taskTokenCount)}  ${dim(`(session total: ${formatTokens(orchestrator.getCumulativeTokens())})`)}`);
        console.log(`${ts()}      ${bold("Latency:")}  ${formatDuration(taskLatency)}`);
        console.log("");

        const taskStatus = computeTaskStatus(result.oversight);

        await backend.updateTask(task.id, {
          status: taskStatus,
          result: {
            output: result.output.slice(0, 500),
            latency_ms: taskLatency,
            oversight_verdict: String(verdict),
            retry_count: result.oversight.retryCount,
            tokens: taskTokens,
          },
        });

        const taskIsSuccess = SUCCESS_TASK_STATUSES.has(taskStatus);
        if (taskIsSuccess) {
          completedTasks.push(task.id);
          // Live-repo commit. This is the SECOND sequential
          // dispatch loop in run.ts — the remediation path that runs after
          // a goal's primary tasks finish. Same bypass-the-orchestrator
          // shape as the primary sequential loop above; same fix.
          await orchestrator.commitLiveRepo(task, { goalBranch: currentGoalBranch });
        } else if (taskStatus === "failed") {
          tasksFailedThisSession++;
        } else if (taskStatus === "blocked") {
          blockedTasks.push(task.id);
        }
        // Always remove from pending on completion/failure/blocked
        const pendingIdx = allPendingTaskIds.indexOf(task.id);
        if (pendingIdx !== -1) allPendingTaskIds.splice(pendingIdx, 1);

        orchestrator.recordEvent(
          taskStatus === "completed" ? "task_completed" : "task_failed",
          `${task.description} — ${verdict}`,
          {
            goal_id: goal.id,
            task_id: task.id,
            tokens: taskTokenCount,
            cumulative_tokens: orchestrator.getCumulativeTokens(),
          },
        );
      }
    }

    if (remediationIteration >= MAX_REMEDIATION_ITERATIONS) {
      const remainingFailed = tasks.map(t => t.id).filter(id =>
        !completedTasks.includes(id) && !skippedTasks.includes(id) && !blockedTasks.includes(id),
      );
      if (remainingFailed.length > 0) {
        console.log(red(`  Remediation exhausted (${MAX_REMEDIATION_ITERATIONS} iterations). ${remainingFailed.length} task(s) still failed.`));
        orchestrator.recordEvent("remediation_exhausted",
          `${remainingFailed.length} tasks remain failed after ${MAX_REMEDIATION_ITERATIONS} remediation iterations: ${remainingFailed.join(", ")}`,
          { goal_id: goal.id },
        );
      }
    }

    // -------------------------------------------------------------------
    // End validation-remediation loop
    // -------------------------------------------------------------------

    // Save checkpoint after each goal
    await orchestrator.saveCheckpoint({
      session_id: orchestrator.getSessionId(),
      swarm_version: "HEAD",
      project: projectConfig.project,
      current_goal: pauseRequested ? goal.id : null,
      current_task: null,
      completed_tasks: [...completedTasks],
      pending_tasks: allPendingTaskIds.filter((id) => !completedTasks.includes(id)),
      skipped_tasks: [...skippedTasks],
      blocked: false,
    });

    if (!pauseRequested) {
      const goalTaskIds = tasks.map(t => t.id);
      const goalCompletedCount = goalTaskIds.filter(id => completedTasks.includes(id)).length;
      const totalTaskCount = goalTaskIds.length;

      eventBus.emit("goal:completed", {
        goalId: goal.id,
        completedTasks: goalCompletedCount,
        totalTasks: totalTaskCount,
        totalTokens: goalSpend(),
        timestamp: Date.now(),
      });

      // What the reviewers left for a person: on the source item now, and on
      // the goal's PR when it opens.
      const goalLeftForPerson = leftForPersonByGoal.get(goal.id) ?? [];
      if (goalLeftForPerson.length > 0) {
        eventBus.emit("goal:left_for_person", { goalId: goal.id, groups: goalLeftForPerson, timestamp: Date.now() });
        console.log(yellow(`    Left for a person: ${countLeftForPerson(goalLeftForPerson)} item(s); listed on the pull request and the source item`));
      }

      if (goalCompletedCount === 0 && totalTaskCount > 0) {
        orchestrator.recordEvent("goal_blocked", `All tasks failed for: ${goal.description}`, { goal_id: goal.id });
        console.log(red(`  Goal FAILED: ${goal.description}`));
        console.log(dim("    All tasks failed. Review errors above. Re-run to retry."));
      } else if (goalCompletedCount < totalTaskCount) {
        orchestrator.recordEvent("goal_completed", `${goalCompletedCount}/${totalTaskCount} tasks completed: ${goal.description}`, { goal_id: goal.id });
        console.log(yellow(`  Goal partially completed: ${goal.description} (${goalCompletedCount}/${totalTaskCount} tasks)`));
      } else {
        orchestrator.recordEvent("goal_completed", goal.description, { goal_id: goal.id });
        console.log(green(`  Goal completed: ${goal.description}`));
      }

      // Ghost-completion signal: a goal whose tasks all finished successfully
      // but produced zero commits (workers did investigative/refactor work
      // with no staged file changes). The 2026-05-30 swarm-on-swarm run had
      // goal-3 and goal-4 silently no-op this way, which made the DAG
      // resolver look permissive (downstream goals proceeded) when it was
      // actually acting on an honest `completed` status with no work behind
      // it. Surface this so the operator can tell apart "goal did real
      // work" from "goal completed but produced nothing".
      if (isGhostCompletion(totalTaskCount, goalCompletedCount, orchestrator.getCommitsForGoal(goal.id))) {
        console.log(yellow(`    Note: goal completed but produced 0 commits — investigative/no-op work, or workers wrote no files.`));
        orchestrator.recordEvent("goal_completed_no_commits", `Goal "${goal.id}" completed with 0 commits across ${totalTaskCount} task${totalTaskCount === 1 ? "" : "s"}`, { goal_id: goal.id });
      }
      console.log("");

      // SDK-23: Record goal summary and reset context for the next goal.
      // This prevents the orchestrator from accumulating unbounded context
      // across goals, which caused "Prompt is too long" errors in prior runs.
      const goalSkippedCount = goalTaskIds.filter(id => skippedTasks.includes(id)).length;
      const goalFailedCount = goalTaskIds.filter(id =>
        !completedTasks.includes(id) && !skippedTasks.includes(id),
      ).length;

      // Bug#2 (b): the status write-back is IDEMPOTENT — derived purely from
      // THIS run's task outcomes, never from the goal's prior persisted status.
      // A goal that entered as "blocked" (then reset to "pending" at startup)
      // and whose tasks all complete this run flips to "completed".
      let goalStatus: "blocked" | "completed" = determineGoalStatus(goalCompletedCount, totalTaskCount);

      // Ship-readiness gate: before a gated goal is allowed to flip to
      // 'completed', the deploy command must run clean and the smoke endpoints
      // must pass. Presence-triggered — the whole block is skipped when no
      // contract was loaded, keeping non-gated runs byte-identical. We gate
      // only goals that otherwise would have completed; a goal already blocked
      // by failed tasks never reaches the deploy command.
      if (goalStatus === "completed" && shipReadinessContract && gateAppliesToGoal(shipReadinessContract, goal.id)) {
        const goalCompletedTaskIds = goalTaskIds.filter(id => completedTasks.includes(id));
        const gateResult = await runShipReadinessGate({
          contract: shipReadinessContract,
          goalId: goal.id,
          cwd: process.cwd(),
          runCommand: defaultCommandRunner,
          fetch: defaultFetch,
        });

        if (gateResult.outcome !== "passed") {
          // Hold the goal open. Leaving it blocked (not completed) means
          // getExecutableGoals() will not unblock dependents, and a re-run
          // re-attempts the goal after the remediation task below lands.
          goalStatus = "blocked";

          // Distinguish deploy-step failures from smoke failures so the
          // reviewer can tell an env/deploy problem apart from a real bug.
          const stage: "deploy" | "smoke" = gateResult.outcome === "deploy-failed" ? "deploy" : "smoke";
          const detail = gateResult.outcome === "deploy-failed"
            ? `Deploy command exited ${gateResult.deployExitCode}: ${gateResult.deployStderr.trim()}`
            : `Smoke endpoints failed: ${gateResult.failedEndpoints.map(e => `${e.url} (${e.reason})`).join("; ")}`;

          eventBus.emit("task:verification-failed", {
            goalId: goal.id,
            contractPath: shipReadinessContractPath,
            stage,
            detail,
            failedEndpoints: gateResult.outcome === "smoke-failed"
              ? gateResult.failedEndpoints.map(e => e.url)
              : undefined,
            deployExitCode: gateResult.outcome === "deploy-failed"
              ? gateResult.deployExitCode
              : undefined,
            timestamp: new Date().toISOString(),
          });

          orchestrator.recordEvent(
            "ship_readiness_failed",
            `Ship-readiness ${stage} failure for: ${goal.description} — ${detail}`,
            { goal_id: goal.id },
          );

          console.log(red(`  Ship-readiness gate FAILED (${stage}): ${goal.description}`));
          console.log(dim(`    ${detail}`));

          shipReadinessOutcomes.push({ goalId: goal.id, applied: true, status: "failed", detail });

          // Build the remediation follow-up task. Its dependsOn edges point at
          // the goal's completed tasks, so it re-enters the DAG the orchestrator
          // already understands and a subsequent run reworks + re-verifies
          // before this goal can close.
          const followUp = buildShipReadinessFollowUpTask(goal, goalCompletedTaskIds, gateResult);
          try {
            await backend.createTask(followUp);
            console.log(dim(`    Created ship-readiness follow-up task: ${followUp.id}`));
          } catch (err) {
            console.log(red(`    Failed to create ship-readiness follow-up task: ${(err as Error).message}`));
          }
        } else {
          console.log(green(`  Ship-readiness gate passed: ${goal.description}`));
          shipReadinessOutcomes.push({ goalId: goal.id, applied: true, status: "passed" });
        }
      } else {
        // Gate did not run for this goal: no contract loaded, the contract
        // doesn't apply to this goal, or the goal didn't complete. Record a
        // skipped outcome so the run summary renders exactly one
        // ship-readiness line per iterated goal (the 'No contract' line when
        // shipReadinessContract is null).
        shipReadinessOutcomes.push({ goalId: goal.id, applied: false, status: "skipped" });
      }

      // Update the in-memory goal status so getExecutableGoals() can
      // unblock dependent goals (e.g., goal-2 dependsOn goal-1).
      goal.status = goalStatus;

      // Advance the stack pointer, once per completed goal. The next goal in
      // this run bases its worktrees on the most-recently-COMPLETED goal's
      // branch — never on a partial/blocked goal's diff. A non-completed goal
      // therefore RETAINS the previous pointer rather than resetting it to
      // null: resetting to null would rebase the next goal onto
      // projectConfig.base_branch, producing a dispatch chain that disagrees
      // with the push-time chain (which always stacks completed goals
      // consecutively). The mismatch is not cosmetic — materializeGoalBranch
      // at push time would `git branch -f` a goal built off main onto the
      // wrong base and discard the worker's commits. Retaining keeps the
      // dispatch and push chains identical, so every completed goal's branch
      // is handed to onGoalComplete with the correct stack base.
      await recordGoalOutcomeForStack(stackLedger, {
        stackPRs,
        goalBranch: currentGoalBranch,
        goalStatus,
        goal: {
          goalId: goal.id,
          goalDescription: goal.description,
          goalUrl: goal.url,
          base: goalDispatch.stackBase,
          ...(goalLeftForPerson.length > 0 ? { leftForPerson: goalLeftForPerson } : {}),
        },
        commitCount: orchestrator.getCommitsForGoal(goal.id),
        commitsOn: () => whereGoalCommitsLanded(goalDispatch, repoRoot),
      });
      // Recorded for publishing: pushed and given its PR at the end of this
      // run, or by the next run if this one cannot.
      if (stackPushes && goalStatus === "completed" && currentGoalBranch) {
        orchestrator.recordGoalPublication({
          goal_id: goal.id,
          description: goal.description,
          ...(goal.url ? { url: goal.url } : {}),
          mode: "stack",
          branch: currentGoalBranch,
          base: goalDispatch.stackBase,
          ...(goalLeftForPerson.length > 0 ? { left_for_person: goalLeftForPerson } : {}),
          pushed: false,
          merged: false,
        });
        // Saved now, so a run killed before its end-of-run push still
        // leaves the goal for the next run to publish.
        await saveRunCheckpoint(null);
      }

      // Merge-as-you-go: open this goal's PR now and merge it when eligible.
      if (mergeManager && mergePrsConfig?.gate) {
        if (goalStatus === "completed" && currentGoalBranch) {
          const verdicts = goalTaskIds.map((id) => taskVerdicts.get(id) ?? "no verdict this run");
          // Recorded before anything is pushed, so a run that stops part-way
          // leaves the goal for the next run to publish.
          orchestrator.recordGoalPublication({
            goal_id: goal.id,
            description: goal.description,
            ...(goal.url ? { url: goal.url } : {}),
            mode: "merge",
            branch: currentGoalBranch,
            verdicts,
            ...(goal.labels ? { labels: goal.labels } : {}),
            ...(goalLeftForPerson.length > 0 ? { left_for_person: goalLeftForPerson } : {}),
            pushed: false,
            merged: false,
          });
          await saveRunCheckpoint(null);
          const outcome = await mergeGoalSafely(
            mergeManager,
            {
              goalId: goal.id,
              goalDescription: goal.description,
              goalUrl: goal.url,
              branch: currentGoalBranch,
              verdicts,
              labels: goal.labels,
              ...(goalLeftForPerson.length > 0 ? { leftForPerson: goalLeftForPerson } : {}),
            },
            { ...baseMergeOptions(mergePrsConfig.gate), ...(conflictResolver ? { resolveConflict: conflictResolver } : {}) },
            projectBaseBranch,
          );
          await saveRunCheckpoint(null);
          prMergeOutcomes.push(outcome);
          for (const line of formatMergeOutcome(outcome)) console.log(line);
        } else {
          // No PR for a goal that did not complete: its commits stay on its
          // branch, and the next goal starts from the base.
          await mergeManager.restoreBaseBranch();
          if (currentGoalBranch) console.log(dim(`    Merge-as-you-go: goal not completed; its work stays on ${currentGoalBranch}, no PR opened`));
        }
      }

      // Persist goal status to disk so it survives across runs.
      // goal.status mutation above already updates goalsManifest (shared refs).
      await persistGoalStatus(goalsPath, goalsManifest);

      // Update Goal entity status in Substrate (fire-and-forget)
      if (substrateClient) {
        try {
          const storedGoals = await substrateClient.query("Goal", { where: { goalId: { eq: goal.id } } }, { id: true, goalId: true });
          const match = (storedGoals as any[]).find((g: any) => g.goalId === goal.id);
          if (match?.id) {
            await substrateClient.mutate("updateGoal", { id: match.id, status: goalStatus }, { id: true });
          }
        } catch {
          // Non-fatal — Substrate goal status update is best-effort
        }
      }

      orchestrator.addGoalSummary({
        goalId: goal.id,
        description: goal.description,
        status: goalStatus,
        tasksCompleted: goalCompletedCount,
        tasksFailed: goalFailedCount,
        tasksSkipped: goalSkippedCount,
        tokens: goalSpend(),
        durationMs: Date.now() - goalStartTime,
      });

      // Compute aggregate claim accuracy for this goal (feeds into next goal's prompt)
      const allClaimed: string[] = [];
      const allActual: string[] = [];
      for (const tid of goalTaskIds) {
        allClaimed.push(...(taskCreatesMap.get(tid) || []), ...(tasks.find(t => t.id === tid)?.serializedFiles || []));
        const mo = mergeOutcomes.get(tid);
        if (mo) allActual.push(...mo.filesChanged);
      }
      if (allClaimed.length > 0 || allActual.length > 0) {
        // Normalize paths to match computeClaimAccuracy's internal normalization
        const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
        const normalizedClaimed = allClaimed.map(normalizePath);
        const normalizedActual = allActual.map(normalizePath);

        const goalAccuracy = computeClaimAccuracy(normalizedClaimed, normalizedActual);
        const actualSet = new Set(normalizedActual);
        const claimedSet = new Set(normalizedClaimed);
        const missedFiles = [...actualSet].filter(f => !claimedSet.has(f));
        goalClaimAccuracy.set(goal.id, { claimed: normalizedClaimed, actual: normalizedActual, accuracy: goalAccuracy, missedFiles });
        // Evict oldest entries beyond cap
        while (goalClaimAccuracy.size > CLAIM_ACCURACY_CAP) {
          const oldest = goalClaimAccuracy.keys().next().value;
          if (oldest !== undefined) goalClaimAccuracy.delete(oldest);
        }
        console.log(dim(`    Claim accuracy: ${(goalAccuracy * 100).toFixed(0)}% (${missedFiles.length} undeclared files)`));
      }

      // Clear merge outcomes for this goal
      for (const tid of goalTaskIds) {
        mergeOutcomes.delete(tid);
      }

      // Trim orchestrator events to prevent memory/context bloat
      orchestrator.trimEventsForNextGoal();

      // Create a fresh Swarm instance for the next goal to prevent
      // accumulated session history from causing "Prompt is too long"
      swarm = new Swarm(swarmConfig, makeSwarmDeps());

      // The goal's outcome is recorded: it is no longer in flight, even if a
      // stop arrives from here on.
      inFlightGoalId = null;
    }

    claimRegistry.clear();
    // A goal the run stopped in the middle of stays in flight, for the checkpoint.
    if (!pauseRequested) await publishEarlierMerges();
  }
  // However the loop ended, earlier goals still get published, unless a goal
  // was left in flight: its work is in the tree, and publishing would switch
  // branches under it. After a stop, no worker resolves a conflict.
  if (inFlightGoalId === null) await publishEarlierMerges();

  if (mergePRs) {
    for (const line of formatMergeSummary(prMergeOutcomes)) console.log(line);
  }

  // -------------------------------------------------------------------------
  // 10b. Stacked-PR push (bug#1): route EVERY completed goal through the
  // SourceControlManager per-goal push+PR loop. No-op unless stack_prs +
  // remote_pr (gated inside pushCompletedGoalStack). Best-effort — a push/PR
  // failure is logged but never aborts the telemetry / summary steps below.
  // -------------------------------------------------------------------------
  // Gating + construction + push are all delegated to runStackedPrPushStep,
  // which wraps the whole step (ctor included) in try/catch and swallows any
  // failure. This is the load-bearing isolation for bug#4: a throwing push must
  // not skip the session-end capture below. The manager factory is only invoked
  // when the gate passes, so non-stack / non-remote_pr runs touch no git/gh.
  await runStackedPrPushStep(
    () =>
      new SourceControlManager(
        repoRoot,
        {
          strategy: "remote_pr",
          stack_prs: true,
          base_branch: projectBaseBranch,
          branch_prefix: stackBranchPrefix,
          remote: projectConfig.source_control?.remote,
          auto_push: projectConfig.source_control?.auto_push,
          pr_on_goal_complete: projectConfig.source_control?.pr_on_goal_complete,
        },
        eventBus,
        { github: githubCredential },
      ),
    stackPushQueue(earlierStackGoals, stackLedger.completed),
    {
      stackPRs,
      strategy: projectConfig.source_control?.strategy,
      sessionId: runId,
      unstackedGoals: stackLedger.unstacked,
    },
    {
      onUnstacked(goals) {
        for (const line of formatUnstackedGoalsWarning(goals)) console.log(yellow(`  ${line}`));
      },
      onResult(result) {
        if (result) {
          const prCount = result.goals.filter((g) => g.prUrl).length;
          console.log(green(`  Stacked PRs: pushed ${result.goals.length} goal branch(es), opened ${prCount} PR(s).`));
          for (const g of result.goals) {
            console.log(dim(`    ${g.goalId}: ${g.branch} → base ${g.base}${g.prUrl ? `  ${g.prUrl}` : ""}`));
          }
        }
      },
      onError(err, completedCount) {
        console.log(red(`  Stacked-PR push failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log(dim(`    ${completedCount} completed goal branch(es) remain local — the next run pushes the ones still unpublished.`));
      },
    },
  );

  // What was published (and what still is not) goes into the checkpoint,
  // with the goal the run stopped in, if it stopped.
  detachPublicationTracking();
  try {
    await saveRunCheckpoint();
  } catch (err) {
    console.log(yellow(`  Checkpoint could not be saved: ${err instanceof Error ? err.message : String(err)}`));
  }

  // -------------------------------------------------------------------------
  // 11. Telemetry upload (if sharing enabled)
  // -------------------------------------------------------------------------

  if (sharingConfig?.enabled) {
    try {
      const { captureTree } = await import("@mnmal-ai/swarm-telemetry");
      const { assemblePayload, compressPayload, uploadPayload, cacheForRetry } = await import("@mnmal-ai/swarm-telemetry");

      const treeAfter = sharingConfig.share_trees
        ? await captureTree(repoRoot)
        : undefined;

      const goalResults = goals.map(g => {
        const goalTaskIds = completedTasks.filter(t => t.startsWith(`${g.id}-`));
        return goalTaskIds.length > 0;
      });
      const goalsCompletedCount = goalResults.filter(Boolean).length;
      const result = await assemblePayload({
        swarmDir: swarmPath,
        projectDir: repoRoot,
        projectName: projectConfig.project,
        runId,
        identity: sharingConfig.identity ?? { type: "anonymous", telemetry_id: "unknown" },
        consent: {
          logs: sharingConfig.share_logs ?? false,
          trees: sharingConfig.share_trees ?? false,
          context: sharingConfig.share_context ?? false,
          transcripts: sharingConfig.share_transcripts ?? false,
        },
        sdkVersion: VERSION,
        durationMs: Date.now() - startTime,
        totalTokens: orchestrator.getCumulativeTokens(),
        goalsCompleted: goalsCompletedCount,
        goalsTotal: goals.length,
        tasksCompleted: completedTasks.length,
        tasksFailed: tasksFailedThisSession,
        treeBefore,
        treeAfter,
      });

      const tarball = await compressPayload(result.payloadDir);
      const uploaded = await uploadPayload(
        tarball,
        sharingConfig.identity ?? { type: "anonymous", telemetry_id: "unknown" },
        runId,
        {
          project: projectConfig.project,
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          total_tokens: orchestrator.getCumulativeTokens(),
          goals_completed: goalsCompletedCount,
          goals_total: goals.length,
          tasks_completed: completedTasks.length,
          tasks_failed: tasksFailedThisSession,
          swarm_sdk_version: VERSION,
        },
      );

      if (uploaded) {
        console.log(dim("  Run data uploaded."));
        await rm(result.payloadDir, { recursive: true }).catch(() => {});
        await rm(tarball).catch(() => {});
      } else {
        // Cache for retry
        await cacheForRetry(tarball, join(swarmPath, "telemetry", "pending"));
        await rm(result.payloadDir, { recursive: true }).catch(() => {});
        console.log(dim("  Upload failed — cached locally. Will retry on next run."));
      }
    } catch (err) {
      console.log(dim(`  Telemetry upload error: ${err instanceof Error ? err.message : err}`));
    }
  }

  // -------------------------------------------------------------------------
  // 12. Session summary
  // -------------------------------------------------------------------------

  // Cleanup
  process.removeListener("SIGINT", sigintHandler);
  projectClaim.release();
  if (worktreeManager) {
    worktreeManager.stopPolling();
  }
  if (dashboardServer) {
    await dashboardServer.stop();
  }
  unsubTelemetry();
  detachTrelloSync?.();
  eventBus.removeAllListeners();

  const elapsed = Date.now() - startTime;
  const finalTokens = orchestrator.getCumulativeTokens();

  orchestrator.recordEvent("session_completed", `Session finished: ${totalTasksRun} tasks`, {
    tokens: finalTokens,
    cumulative_tokens: finalTokens,
  });

  console.log(dim("  ─────────────────────────────────────"));
  console.log(bold("  Session Summary"));
  console.log(dim("  ─────────────────────────────────────"));
  console.log("");
  for (const line of sessionSummaryLines({
    project: projectConfig.project,
    tasksCompleted: completedTasks.length,
    tasksRun: totalTasksRun,
    tokens: sessionTokens,
    duration: formatDuration(elapsed),
    ...(fnlTotals.total() ? { fnl: fnlTotals.total() as FnlCoverage } : {}),
  })) {
    const labelEnd = line.indexOf(":") + 1;
    console.log(`  ${bold(line.slice(0, labelEnd))}${line.slice(labelEnd)}`);
  }

  const leftForPersonLines = formatLeftForPersonSummary(leftForPersonByGoal, goalLabels);
  if (leftForPersonLines.length > 0) {
    console.log("");
    for (const line of leftForPersonLines) console.log(yellow(`  ${line}`));
  }

  if (loginStop.tripped) {
    for (const line of loginExpiredBanner(loginStop.detail, loginStop.runtime)) console.log(red(line));
    console.log(cyan(`    swarm run --swarm-path ${swarmPath} --project ${projectName}`));
    // Non-zero, so a scheduler or script sees the run did not finish.
    process.exitCode = 1;
  } else if (pauseRequested) {
    console.log("");
    console.log(yellow("  Session paused. Resume with:"));
    console.log(cyan(`    swarm run --swarm-path ${swarmPath} --project ${projectName}`));
  } else {
    const remaining = goals.filter((g) => !completedTasks.some((t) => t.startsWith(`${g.id}-`)));
    if (remaining.length > 0) {
      console.log("");
      console.log(dim(`  ${remaining.length} goal(s) still have pending tasks.`));
    } else {
      console.log("");
      console.log(green("  All goals processed!"));
    }
  }

  console.log("");

  // -------------------------------------------------------------------------
  // 13. Capture learning observations
  // -------------------------------------------------------------------------

  try {
    // Determine goal completion status from task outcomes (not the fragile startsWith heuristic)
    const goalTaskCounts = new Map<string, { total: number; approved: number }>();
    for (const t of capturedTaskOutcomes) {
      const entry = goalTaskCounts.get(t.goalId) ?? { total: 0, approved: 0 };
      entry.total++;
      if (t.verdict === "approved" || t.verdict === "skipped") entry.approved++;
      goalTaskCounts.set(t.goalId, entry);
    }

    // goal-9: prefer the live TaskExecution Substrate mirror for the run summary's
    // task-count axis. Offline / no-Substrate runs skip the read entirely; a Substrate
    // hiccup is swallowed so the read failing leaves taskExecutionCounts
    // undefined and buildObservation falls back to its in-memory taskOutcomes
    // computation. Telemetry parity — never block the run summary on Substrate.
    let taskExecutionCounts: Awaited<ReturnType<typeof readTaskExecutionCounts>> | undefined;
    if (substrateClient) {
      try {
        taskExecutionCounts = await readTaskExecutionCounts(substrateClient, {
          goalIds: goals.map(g => g.id),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(dim(`  Learning: TaskExecution count read failed — ${msg}`));
      }
    }

    // `swarmPath` is the session swarm dir, resolved to an ABSOLUTE path at
    // startup (resolve(--swarm-path) | discoverSwarmPath, never reassigned).
    // capture.ts derives runsDir = <swarmPath>/domains/<project>/learned/runs
    // from it, so the run summary always lands in the real learned/runs/ tree
    // regardless of process.cwd() — never a worktree-relative path even when a
    // prior step left the process chdir'd into a goal worktree.
    captureRunObservation(swarmPath, {
      runId,
      project: projectConfig.project,
      swarmVersion: VERSION,
      workerModel,
      reviewerModel,
      startTime,
      endTime: Date.now(),
      paused: pauseRequested,
      goals: goals.map(g => {
        const counts = goalTaskCounts.get(g.id);
        let status: string;
        if (!counts || counts.total === 0) status = "failed";
        else if (counts.approved === counts.total) status = "completed";
        else if (counts.approved > 0) status = "partial";
        else status = "failed";
        return { id: g.id, description: g.description, status, designs: g.designs };
      }),
      taskOutcomes: capturedTaskOutcomes,
      taskExecutionCounts,
      filesChanged: [...capturedFilesChanged],
      mergeConflicts: [...new Set(capturedConflictFiles)],
      totalTokens: finalTokens,
      shipReadiness: { contractLoaded: shipReadinessContract !== null, goals: shipReadinessOutcomes },
    }, substrateClient);

    console.log(dim(`  Learning: observation captured to learned/runs/${runId}.md`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(dim(`  Learning: capture failed — ${msg}`));
  } finally {
    // Remove learning-specific event listeners to prevent leaks on multi-run processes
    eventBus.off("worktree:merged", onMergedForCapture);
    eventBus.off("worktree:conflict", onConflictForCapture);
    // Detach the postmortem recorder so its ring buffers are eligible
    // for GC and its event listeners don't outlive the run.
    postmortemRecorder.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * What `swarm run` prints when it starts the dashboard: its URL, the LAN URL
 * under --dashboard-lan, and then what serving it on the network exposes.
 */
export function dashboardBanner(port: number, lan: boolean, lanIp: string | null, localOnly: boolean): string[] {
  const lines = [`  ${bold("Dashboard:")}    ${cyan(`http://localhost:${port}`)}`];
  if (lan) {
    if (lanIp) lines.push(`  ${bold("LAN:")}          ${cyan(`http://${lanIp}:${port}`)}`);
    lines.push(...lanWarning(localOnly).map(yellow));
  }
  return lines;
}

function getLanIp(): string | null {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

function trustLevelDisplay(level: string): string {
  switch (level) {
    case "low": return yellow("low");
    case "medium": return cyan("medium");
    case "high": return green("high");
    default: return level;
  }
}

function buildTaskInput(goal: Goal, task: Task, directive: DispatchDirective, currentBranch: string | null): string {
  const lines: string[] = [];

  if (currentBranch) {
    lines.push(`## Previous Work`);
    lines.push(`The previous task committed changes on branch '${currentBranch}'.`);
    lines.push(`You should checkout and continue from that branch: \`git checkout ${currentBranch}\``);
    lines.push(`Prefer continuing on this branch rather than creating a new branch from master.`);
    lines.push("");
  }

  lines.push(`## Goal: ${goal.description}`);
  lines.push("");
  lines.push(`## Task: ${task.description}`);
  lines.push("");

  if (directive.directive.acceptance_criteria.length > 0) {
    lines.push("## Acceptance Criteria");
    for (const criterion of directive.directive.acceptance_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push("");
  }

  if (directive.directive.constraints.length > 0) {
    lines.push("## Constraints");
    for (const constraint of directive.directive.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildDirectiveContext(directive: DispatchDirective): string {
  const lines: string[] = [];
  lines.push("## Dispatch Directive");
  lines.push("");
  lines.push(`Trust level: ${directive.directive.trust_level}`);
  lines.push(`Context depth: ${directive.directive.context_depth}`);
  lines.push(`Skills allowed: ${directive.directive.skills_allowed.join(", ")}`);
  lines.push(`Review required: ${directive.directive.review_required ? "yes" : "no"}`);
  lines.push("");

  if (directive.directive.escalation_triggers.length > 0) {
    lines.push("### Escalation Triggers");
    for (const trigger of directive.directive.escalation_triggers) {
      lines.push(`- ${trigger}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
