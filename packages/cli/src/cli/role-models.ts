/**
 * Per-role model selection and reporting for `swarm run`.
 *
 * `models.worker` / `models.reviewer` / `models.arbiter` in config.json name a
 * model per role. Without this, those names were telemetry labels only:
 * nothing reached the backend, so every role ran on whatever the operator's
 * runtime defaulted to. Here each role's backend asks for its model, and every
 * session reports — from the runtime, not from config — which models served it.
 */

import type {
  BackendConfig,
  BackendFnlCoverageEvent,
  BackendModelReportEvent,
  FnlBackendConfig,
  ProjectConfig,
  IWorkerBackend,
  ModelReport,
  WorkerTaskInput,
  WorkerTaskOutput,
} from "@mnmal-ai/swarm-types";
import { DEFAULT_WORKER_TOOLS, DEFAULT_REVIEW_TOOLS } from "@mnmal-ai/swarm-worker-backends";

export type AgentRole = BackendModelReportEvent["role"];
export type RoleModelReport = BackendModelReportEvent;

/**
 * The backend config for a role: the project's model for that role, unless
 * the backend block names one itself. A project that names no model for the
 * role gets no model key, and so keeps the runtime's default as before.
 */
export function roleBackendConfig<T extends BackendConfig>(config: T, roleModel: string | undefined): T {
  if (config.model !== undefined || roleModel === undefined) return config;
  return { ...config, model: roleModel };
}

/**
 * The backend config run.ts hands each role: the role's backend block (API when
 * absent) with its model, plus source_control.git_identity when set, so commits
 * the agent makes itself — a Claude Code worker's `git commit`, or one made
 * through the API agentic loop's run_command — are authored and committed as
 * that identity. No identity → no gitIdentity key, behaviour unchanged.
 *
 * `run.ghConfigDir` is the run's empty GH_CONFIG_DIR: every role gets it, so no
 * agent's gh has a login (workers get no GitHub access).
 *
 * A role that runs Claude Code, as its backend or its fallback, and lists no
 * `tools` gets its role's built-in tools: the worker reads, edits and runs
 * commands; the reviewer and arbiter, told not to modify files, read and run
 * commands. Every tool a session defines is re-sent on each API call, so the
 * others are left out. A fallback keeps its primary's tools, so an API role
 * with a Claude Code fallback carries the set for that fallback.
 *
 * `run.fnl` is the fnl swarm run found for the project's `fnl` block: every
 * role that runs Claude Code with the Bash tool gets it, so its Bash commands
 * go through fnl's worker hook.
 */
export function roleBackendConfigs(
  projectConfig: Pick<ProjectConfig, "backends" | "models" | "source_control">,
  run: { ghConfigDir?: string; fnl?: FnlBackendConfig; codexHookCommand?: string } = {},
): Record<AgentRole, BackendConfig> {
  const identity = projectConfig.source_control?.git_identity;
  const build = (role: AgentRole): BackendConfig => {
    const config = roleBackendConfig(projectConfig.backends?.[role] ?? { type: "api" as const }, projectConfig.models?.[role]);
    const roleTools = role === "worker" ? DEFAULT_WORKER_TOOLS : DEFAULT_REVIEW_TOOLS;
    const runsClaudeCode = config.type === "claude-code" || config.fallback === "claude-code";
    const runsCodex = config.type === "codex" || config.fallback === "codex";
    // Both agent runtimes get the role's tools and fnl; a codex role's hook enforces them.
    const getsRoleTools = runsClaudeCode || runsCodex;
    const tools = config.tools ?? (getsRoleTools ? [...roleTools] : undefined);
    return {
      ...config,
      ...(getsRoleTools && config.tools === undefined ? { tools } : {}),
      ...(identity ? { gitIdentity: identity } : {}),
      ...(run.ghConfigDir ? { ghConfigDir: run.ghConfigDir } : {}),
      ...(run.fnl && getsRoleTools && tools?.includes("Bash")
        ? { fnl: { bin: run.fnl.bin, wrap: [...run.fnl.wrap], ...(run.fnl.json !== undefined ? { json: run.fnl.json } : {}) } }
        : {}),
      ...(runsCodex && run.codexHookCommand ? { codexHookCommand: run.codexHookCommand } : {}),
    };
  };
  return { worker: build("worker"), reviewer: build("reviewer"), arbiter: build("arbiter") };
}

/**
 * Wrap a backend so each session it runs reports its models, tagged with the
 * role, and its tokens. Everything else passes through unchanged.
 */
export function withModelReporting(
  backend: IWorkerBackend,
  role: AgentRole,
  onReport: (report: RoleModelReport) => void,
  /** Every session's tokens, report or not, so the run counts each one (see SessionLedger). */
  onSpend?: (spent: WorkerTaskOutput["tokensUsed"]) => void,
  /** Each session's fnl coverage, when it counted any (see FnlCoverage). */
  onFnlCoverage?: (report: BackendFnlCoverageEvent) => void,
): IWorkerBackend {
  return {
    type: backend.type,
    model: backend.model,
    supportsDirectExecution: backend.supportsDirectExecution,
    isAvailable: () => backend.isAvailable(),
    async execute(input: WorkerTaskInput): Promise<WorkerTaskOutput> {
      const output = await backend.execute(input);
      if (output.modelReport) onReport({ role, report: output.modelReport, timestamp: Date.now() });
      if (output.fnlCoverage) onFnlCoverage?.({ role, coverage: output.fnlCoverage, timestamp: Date.now() });
      onSpend?.(output.tokensUsed);
      return output;
    },
  };
}

/**
 * Why a session did not run on the model asked for, or null if it did (or if
 * nothing was asked for). The session must start on the requested model, and if
 * it produced any responses, at least one must come from that model. Side
 * responses from other models are allowed — a runtime may hand small chores to
 * a smaller model. A session that reported no model at all, neither a session
 * model nor any response, is a mismatch: no evidence is not a pass.
 */
export function modelMismatch(report: ModelReport): string | null {
  const { requested, sessionModel, responses } = report;
  if (!requested) return null;
  if (!sessionModel && Object.keys(responses).length === 0) {
    return `asked for ${requested}, but the runtime reported no model for this session`;
  }
  if (sessionModel && sessionModel !== requested) {
    return `asked for ${requested}, but the session started on ${sessionModel}`;
  }
  if (Object.keys(responses).length > 0 && !responses[requested]) {
    return `asked for ${requested}, but there was no response from ${requested} (got ${Object.keys(responses).join(", ")})`;
  }
  return null;
}

/** One log line: role, model asked for, session model, responses, tokens. */
export function describeModelReport({ role, report }: RoleModelReport): string {
  const responses = Object.entries(report.responses).map(([m, n]) => `${m}×${n}`).join(", ") || "none";
  const tokens = Object.entries(report.usage).map(([m, u]) => `${m} ${u.input}in/${u.output}out`).join(", ") || "none";
  return `${role}: asked ${report.requested ?? "(runtime default)"}, session ${report.sessionModel ?? "?"}; responses ${responses}; tokens ${tokens}`;
}
