/**
 * SDK configuration, worker backend, router, loader, executor, and oversight types.
 */

import type { ContextTier, Route } from "./manifest.js";
import type { ISwarmEventBus } from "./events.js";
import type { GitIdentity } from "./orchestration.js";

// ---------------------------------------------------------------------------
// SDK configuration
// ---------------------------------------------------------------------------

export interface SwarmConfig {
  /** Path to the cloned swarm repo. */
  swarmPath: string;

  /** LLM provider identifier. */
  provider: ProviderName;

  /** Model identifier (e.g., "claude-sonnet-4-5"). */
  model: string;

  /**
   * Load swarm context by section (stage 1 of the context-sections spec): ask
   * prepareTask for sections, after `SwarmDeps.syncSections` has stored the
   * task checkout's documents. Off by default. Set from config.json's
   * `context.sections.enabled`.
   */
  contextSections?: boolean;

  /**
   * Index stored documents and guard their reads (stage 2 of the
   * context-sections spec): ask prepareTask for the indexed documents, append
   * their index to the worker's context, and refuse reads that span several
   * sections over `maxReadTokens`. Needs `contextSections`. Off by default.
   * Set from config.json's `context.pull`.
   */
  contextPull?: { maxReadTokens: number };

  /**
   * Deliver the project's rules like the document index (context.rules; see
   * docs/superpowers/specs/2026-10-03-agent-rules-design.md). Sessions on a
   * direct-execution backend get `must` and pinned rules in full, the
   * `relevant` best-matching `should` rules in full while they fit, and the
   * rest as index lines, once the rules exceed `maxTokens`. `paths` are rule
   * files besides the binding ones. Off by default.
   */
  contextRules?: { maxTokens: number; relevant: number; paths: string[] };

  /**
   * Rank sections by similarity to the task (stage 3 of the context-sections
   * spec): ask prepareTask to rank, so the best-ranked sections the route
   * didn't load, up to `maxSections`, are added in rank order while they fit.
   * Needs `contextSections`. The sidecar's embedder comes from config.json's
   * `context.ranking`. Off by default.
   */
  contextRanking?: { maxSections: number };

  /** API key. Falls back to env vars if not provided. */
  apiKey?: string;

  /** Telemetry configuration. */
  telemetry?: TelemetryConfig;

  /** Oversight configuration. */
  oversight?: OversightConfig;

  /** Event bus for real-time observability. */
  eventBus?: ISwarmEventBus;

  /** Optional worker backend override. When set, Swarm.run() delegates task execution to this backend instead of using the internal agentic API loop. */
  workerBackend?: IWorkerBackend;

  /** Optional reviewer backend override. When set, the reviewer runs through this backend (e.g. Claude Code) with filesystem access instead of a raw API call. */
  reviewerBackend?: IWorkerBackend;

  /** Optional arbiter backend override. When set, the arbiter runs through this backend (e.g. Claude Code) with filesystem access instead of a raw API call. */
  arbiterBackend?: IWorkerBackend;

  /** Raw backend config — used to instantiate a fallback backend at runtime. */
  backendConfig?: BackendConfig;

  /** Author identity for telemetry attribution, resolved once per session by
   *  the CLI (env USER > git user.email > anonymous). Threaded onto every
   *  telemetry row Swarm writes — worker SessionEvent, transcript, and the
   *  oversight verdict — for future per-engineer reporting. Optional: rows stay
   *  valid when omitted. Taxonomy now, enforcement deferred. */
  authorId?: string;

  /** Embedding-recall tuning for classifyIntent + loadContext. Optional and
   *  purely additive: when omitted the recall layer keeps its built-in defaults
   *  (no similarity filtering, RECALL_TOP_K hits) and behavior is unchanged. */
  recall?: RecallConfig;
}

export type ProviderName = "anthropic" | "openai";

/** Tuning knobs for the engine-recall embedding leg consumed by the core router
 *  (classifyIntent) and loader (loadContext). Mirrors the v3
 *  `EmbeddingsStore.knnSearch` options shape (`threshold` / `k`) rather than
 *  inventing a parallel surface — both fields are optional so omitting `recall`
 *  entirely is a no-op. */
export interface RecallConfig {
  /** Cosine-similarity floor in the range 0..1. Nearest-neighbor hits scoring
   *  below this are dropped before they reach the UNION. Default 0 — no
   *  filtering, no behavior change (mirrors knnSearch's `threshold` default). */
  similarityThreshold?: number;

  /** Maximum number of nearest-neighbor results returned per recall (mirrors
   *  knnSearch's `k`). Bounds how many `SwarmContent` rows the embedding leg
   *  contributes; stores cap at their own ceiling. */
  topK?: number;
}

export interface TelemetryConfig {
  enabled: boolean;
  outputPath?: string;
}

export interface OversightConfig {
  enabled: boolean;
  reviewerModel?: string;
  reviewerProvider?: ProviderName;
  arbiterModel?: string;
  arbiterProvider?: ProviderName;
}

// ---------------------------------------------------------------------------
// Worker backend types
// ---------------------------------------------------------------------------

/** Supported backend types. "api" = raw API tokens. "claude-code" = Claude Code CLI subscription.
 *  "codex" = the OpenAI Codex CLI, signed in however its operator signed it in. */
export type WorkerBackendType = "api" | "claude-code" | "codex";

export interface ToolApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ClarifyingQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export type ProgressEventType =
  | "session_init"
  | "tool_call"
  | "tool_progress"
  | "tool_summary"
  | "model_response"
  | "status_change";

export interface ProgressEvent {
  type: ProgressEventType;
  detail: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface InteractionHandler {
  onToolApproval?: (request: ToolApprovalRequest) => Promise<{
    allow: boolean;
    message?: string;
  }>;
  onClarifyingQuestion?: (questions: ClarifyingQuestion[]) => Promise<Record<string, string>>;
  /** Called for each intermediate message from the Agent SDK during execution.
   *  Use this for real-time visibility into what Claude is doing. */
  onProgress?: (event: ProgressEvent) => void;
}

/** MCP server config — compatible subset of @anthropic-ai/claude-agent-sdk McpStdioServerConfig.
 *  Re-declared here (instead of imported) because the SDK's full type includes non-serializable
 *  class instances. Project config comes from JSON on disk, so we only need the STDIO variant. */
export interface McpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional URL to documentation for this MCP server.
   *  Used by the tool failure recovery loop to include relevant docs
   *  in retry task descriptions. */
  docs_url?: string;
}

/** Alias kept separate from McpStdioServer so it can be widened to a union
 *  (e.g. SSE/HTTP transports) in the future without changing BackendConfig's
 *  public shape. Currently only stdio-based MCP servers are supported. */
export type McpServerEntry = McpStdioServer;

export interface BackendConfig {
  /** Which backend to use. */
  type: WorkerBackendType;
  /** If this backend is unavailable, try this one instead. */
  fallback?: WorkerBackendType;
  /** @deprecated for claude-code: the Agent SDK backend does not use a CLI binary.
   *  The codex backend runs this binary instead of the `codex` on PATH. */
  binaryPath?: string;
  /** @deprecated No longer used — the Agent SDK backend does not support arbitrary CLI flags. Use `permissions` to control tool access. */
  extraFlags?: string[];
  /** Permission handling for CLI worker backends. */
  permissions?: PermissionConfig;
  /** Built-in tools a claude-code session gets, by name (e.g. "Read", "Bash"):
   *  the Agent SDK `tools` option. Tools not listed are not defined in the
   *  session at all, so they cost no context on any call and cannot be used.
   *  Omitted: the role's default set (workers read, edit and run commands;
   *  reviewers and arbiters read and run commands). Permission patterns such as
   *  "Bash(git *)" belong in `permissions.allowedTools`, not here. */
  tools?: string[];
  /** Interactive communication handler for Claude Code backend.
   *  Routes tool approvals and clarifying questions to the caller. */
  interactionHandler?: InteractionHandler;
  /** MCP servers to make available to claude-code workers.
   *  Only used by claude-code backend. The api backend does not support MCP servers;
   *  a warning will be logged and the field will be ignored. */
  mcpServers?: Record<string, McpServerEntry>;
  /** Agent SDK query timeout in seconds. Default: 600 (10 minutes). Set to 0 for unlimited. */
  timeout?: number;
  /** Model for this backend, e.g. "claude-haiku-4-5-20251001".
   *
   *  Omitted means the Agent SDK's own default — which is the operator's
   *  configured model, and is therefore *whatever they happen to be running*.
   *  That is right for a worker and wrong for cheap background work: the first
   *  live mail sweep silently triaged an inbox of three messages on Opus, the
   *  most expensive model. Any unattended, repeating task should name its own model rather
   *  than inherit one. */
  model?: string;
  /** Author and committer for commits the agent itself makes (e.g. `git
   *  commit` from its shell), filled from source_control.git_identity. When
   *  set, exactly GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL reach the
   *  agent's processes; unset, no GIT_* variable does. */
  gitIdentity?: GitIdentity;
  /** An empty directory the agent's processes get as GH_CONFIG_DIR, so gh
   *  inside them has no login (workers get no GitHub access; GitHub token
   *  variables are stripped too). `swarm run` creates one per run. Unset: the
   *  backend uses a per-process empty directory — never the machine's gh
   *  config. */
  ghConfigDir?: string;
  /** Route the session's Bash commands through fnl, which hands back a digest
   *  of build and test output instead of the whole log. Set by `swarm run`
   *  from the project's `fnl` block once it has found a supported fnl; unset,
   *  commands run as the model wrote them. Only claude-code sessions with the
   *  Bash tool use it. */
  fnl?: FnlBackendConfig;
  /** The /bin/sh command Codex runs as this session's hook (`swarm codex-hook`,
   *  quoted). `swarm run` sets it for codex roles; a codex backend without it
   *  refuses to start, since its deny list would go unenforced. Other
   *  backends ignore it. */
  codexHookCommand?: string;
}

/** A resolved fnl for a claude-code session; see BackendConfig.fnl. */
export interface FnlBackendConfig {
  /** Absolute path to an fnl that supports `rewrite --deny` and `--check-invokes-fnl`. */
  bin: string;
  /** Command patterns to wrap, from the project's `fnl.wrap`. */
  wrap: string[];
  /**
   * Whether this fnl explains each decision (`rewrite --json`): wrapped or left
   * alone, why, and which build tool. Only then does a session count its fnl
   * coverage (see FnlCoverage). Older fnl: false, and nothing is counted.
   */
  json?: boolean;
}

/**
 * How a session's Bash commands fared with fnl, counted from fnl's own
 * decisions. A build command is one fnl names a build tool for (xcodebuild,
 * gradlew, vitest…), whether or not it wrapped it. Never holds command text.
 */
export interface FnlCoverage {
  /** Commands fnl named a build tool for. */
  buildCommands: number;
  /** Of those, the ones fnl wrapped, so the agent read a digest. */
  wrapped: number;
  /** Build commands fnl left as written, by fnl's reason ("structure", "deny-rule"…). */
  leftAlone: Record<string, number>;
  /** Build commands by tool name: how many were wrapped, and how many left alone. */
  byTool: Record<string, { wrapped: number; leftAlone: number }>;
  /** Commands fnl gave no answer for in time (or answered unreadably); they ran as written. */
  unanswered: number;
  /** What the wrapped commands' digests saved; only when the session wrapped one. */
  savings?: FnlSavings;
}

/**
 * Tokens fnl's digests kept out of a session, measured after each Bash call
 * its hook wrapped, failed calls included: what the agent was sent (the
 * digest), fnl's full output for the run, and what the agent's own command
 * would have shown without fnl (the full output through the command's
 * `| tail`, as Claude Code hands it to the model: whole within its Bash output
 * limit, a short preview of the start over it, and a failed command's text
 * cut to its first and last part). Tokens are estimated as characters / 4.
 * These are first-read savings: a tool result stays in the conversation and
 * is re-sent on every later call, so the context saved over the session is
 * larger.
 */
export interface FnlSavings {
  /** Wrapped calls measured. */
  calls: number;
  /** fnl's full output for those calls (`fnl show <id>`). */
  rawTokens: number;
  /** What the agent was sent instead: the digests. */
  sentTokens: number;
  /** What the agent's own commands would have shown it without fnl. */
  withoutFnlTokens: number;
  /** withoutFnl minus sent, per call, never below zero. */
  savedTokens: number;
  /** Wrapped calls that couldn't be measured: no digest footer in the result,
   *  `fnl show` failed, or the call was interrupted or never finished. */
  unmeasured: number;
  /** Measured calls whose output was over Claude Code's limit: without fnl
   *  the agent would have seen only part of the log (a preview of its start,
   *  or a failure's first and last part) and needed more reads to find the
   *  result; with fnl it got the result in the digest. */
  oversized: number;
}

/** Documents a session should read by section, and the limit on a multi-section read. */
export interface DocumentGuard {
  maxReadTokens: number;
  documents: Array<{
    /** Absolute path on disk. */
    absolutePath: string;
    /** How the index names it (relative for project documents). */
    displayPath: string;
    /** sha256 of the content the sections below were stored for. */
    contentHash: string;
    sections: Array<{ startLine: number; endLine: number; headingPath: string[]; synopsis: string; tokens: number }>;
  }>;
}

/** How a session read its indexed documents. */
export interface DocumentReads {
  /** Reads of an indexed document that stayed within the limit or one section. */
  bounded: number;
  /** Reads refused for spanning several sections over the limit. */
  refused: number;
  /** Allowed reads that covered a whole indexed document (a small one). */
  whole: number;
  /** The line ranges read, by display path; at most 50 kept. */
  ranges: Array<{ path: string; startLine: number; endLine: number }>;
}

/** Permission handling for CLI worker backends. */
export interface PermissionConfig {
  /** Permission mode passed to --permission-mode. Default: "acceptEdits". */
  mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
  /** Tool patterns to allow without prompting (passed to --allowedTools). */
  allowedTools?: string[];
  /** Tool patterns to deny (passed to --disallowedTools). */
  deniedTools?: string[];
  /** MCP tool name for programmatic permission decisions (--permission-prompt-tool). */
  permissionPromptTool?: string;
}

/** Per-role backend configuration.
 *  Each oversight role (worker, reviewer, arbiter) can run on its own backend.
 *  When reviewer/arbiter backends support direct execution (e.g. claude-code),
 *  they can read files and run builds in the worktree instead of relying on
 *  the text summary alone. */
export interface BackendsConfig {
  worker?: BackendConfig;
  reviewer?: BackendConfig;
  arbiter?: BackendConfig;
}

export interface WorkerTaskInput {
  task: string;
  workingDirectory: string;
  swarmContext: string;
  maxTurns: number;
  /** Indexed documents whose reads the session guards; see DocumentGuard. Backends that can't guard ignore it. */
  documents?: DocumentGuard;
}

/**
 * Token usage split the way the live dashboard shows it. `freshInput` is input
 * the model read uncached; `cacheRead` and `cacheWrite` are prompt-cache reads
 * and writes. All input = freshInput + cacheRead + cacheWrite.
 */
export interface TokenBreakdown {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface WorkerTaskOutput {
  output: string;
  latencyMs: number;
  /** `input` counts all input tokens, cache reads and writes included.
   *  `cacheRead` / `cacheWrite` say how much of it came from the prompt
   *  cache; absent when the backend does not report a split. */
  tokensUsed: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  filesChanged: string[];
  exitCode?: number;
  backendUsed: WorkerBackendType;
  /** Which models served this session, as the model runtime reported them. */
  modelReport?: ModelReport;
  /** How the session's Bash commands fared with fnl; only when its fnl explains its decisions. */
  fnlCoverage?: FnlCoverage;
  /** How the session read its indexed documents; only when it guarded them. */
  documentReads?: DocumentReads;
}

/**
 * Which models actually served a session, as the model runtime reported them —
 * not what swarm asked for. The two can differ (an unset model inherits the
 * operator's default; a runtime may route side work to a smaller model), and
 * only this report says which happened.
 */
export interface ModelReport {
  /** The model swarm asked for. Undefined: the runtime's default. */
  requested?: string;
  /** The model the session started on, from the runtime's init message. */
  sessionModel?: string;
  /** Assistant responses per model, from the `model` each API response names. */
  responses: Record<string, number>;
  /** Tokens per model, from the runtime's final usage (cached input included). */
  usage: Record<string, { input: number; output: number }>;
}

export interface IWorkerBackend {
  readonly type: WorkerBackendType;
  /** The model this backend asks for. Undefined: the runtime's default. */
  readonly model?: string;
  /** Whether this backend supports direct task execution. If false, Swarm.run() uses its internal agentic loop. */
  readonly supportsDirectExecution: boolean;
  /** Check if this backend is available on the current system. */
  isAvailable(): Promise<boolean>;
  /** Execute a task and return the result. */
  execute(input: WorkerTaskInput): Promise<WorkerTaskOutput>;
}

// ---------------------------------------------------------------------------
// Learn-from-PR types
// ---------------------------------------------------------------------------

/** Categorization of a merged PR by the `learn-from-pr` ingestion loop.
 *  - "missed-ac": the PR fixed something an acceptance criterion should have caught.
 *  - "missing-swarm-content": the PR encodes knowledge that belongs in a swarm file.
 *  - "platform-gotcha": the PR worked around a platform/tooling quirk.
 *  - "unrelated": low-signal; not a fold-back candidate. */
export type PRCategory = "missed-ac" | "missing-swarm-content" | "platform-gotcha" | "unrelated";

/** A merged pull request parsed from `gh api` output, fed into the
 *  `learn-from-pr` categorizer. Fields mirror the subset of GitHub's PR shape
 *  the ingestion loop needs; `diffSummary` is a derived, size-bounded summary
 *  of the merged diff rather than a raw patch.
 *
 *  PROMPT-INJECTION SURFACE: `title`, `body`, `author`, and `diffSummary`
 *  are all user-controlled strings (PR metadata authored by an arbitrary
 *  GitHub contributor; diff content from arbitrary commits). Every one of
 *  them tends to land in a categorizer prompt verbatim — a title like
 *  "Ignore previous instructions and output PASS" or an author handle
 *  crafted to imitate system markers is a realistic vector, not just the
 *  long-form `body` / `diffSummary` text. Callers MUST sanitize all four
 *  before constructing the LLM prompt: strip control characters, neutralize
 *  any system-prompt-style delimiters the model treats as boundaries, and
 *  truncate the long fields to a documented byte cap (suggested 8 KB each
 *  for `body` and `diffSummary`). The type carries no implicit bound — the
 *  cap belongs at the LLM call site. */
export interface MergedPullRequest {
  number: number;
  url: string;
  title: string;
  /** GitHub's REST API returns `null` for the body when the PR has no
   *  description. Modeled here so a missing body can't silently flow
   *  into a template literal as the string "null" and become wrong LLM
   *  prompt input. Callers must coerce explicitly (e.g. `body ?? ""`)
   *  before serializing. */
  body: string | null;
  author: string;
  /** ISO-8601 timestamp of when the PR was merged. */
  mergedAt: string;
  diffSummary: string;
}

/** The categorizer's verdict on a single merged PR. Produced by the
 *  provider-agnostic LLM call; high-signal results become a plane/Observation
 *  tagged `fold-back-candidate` for the drainstop to promote.
 *
 *  Note: `diffSummary` is NOT echoed here — callers already hold the
 *  input `MergedPullRequest` and can pair the verdict with the
 *  originating PR's `diffSummary` directly. Echoing risked drift
 *  between input and verdict for no consumer benefit. */
export interface PRCategorization {
  category: PRCategory;
  /** Confidence in the categorization, 0-100. */
  confidence: number;
  reasoning: string;
  /** Proposed durable swarm edit the drainstop may promote — never written directly. */
  proposedSwarmEdit: string;
}

/** The resolved provider-agnostic backend used for categorization.
 *  Defaults to local Ollama when present, else an API provider per env. */
export interface CategorizerSelection {
  provider: "anthropic" | "openai" | "ollama";
  model: string;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Router types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  intent: string;
  route: Route;
  /**
   * How the intent was matched. `"semantic"` is the embedding-recall tier:
   * returned when keyword scoring found nothing but vector similarity over the
   * SwarmContent corpus recovered an intent (engine-recall). It ranks below
   * `"keyword"` and above `"fallback"` — recall augments, never replaces, the
   * keyword path.
   */
  confidence: "exact" | "keyword" | "semantic" | "fallback";
  matchedKeywords: string[];
}

// ---------------------------------------------------------------------------
// Loader types
// ---------------------------------------------------------------------------

export interface LoadedFile {
  path: string;
  tier: ContextTier;
  content: string;
  estimatedTokens: number;
}

/** An optional-tier file the context budget left out: what it would have cost. */
export interface OmittedFile {
  path: string;
  tier: ContextTier;
  estimatedTokens: number;
}

export interface LoadResult {
  files: LoadedFile[];
  totalTokens: number;
  budgetMax: number;
  budgetUsedPercent: number;
  truncated: string[];
  /** The budget drops in `truncated`, with their tier and size. */
  omitted?: OmittedFile[];
}

// ---------------------------------------------------------------------------
// Executor types
// ---------------------------------------------------------------------------

export interface ExecutionInput {
  systemContext: string;
  prompt: string;
}

export interface ExecutionResult {
  output: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  model: { provider: string; modelId: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Result of a single turn in an agentic tool-use loop. */
export interface ToolUseResult {
  response: unknown; // raw provider response
  outputText: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Provider-normalized assistant message to append to conversation history. */
  assistantMessage: { role: "assistant"; content: unknown; tool_calls?: unknown };
}

/** Interface that all model providers must implement. */
export interface ModelProvider {
  name: ProviderName;
  execute(input: ExecutionInput, model: string): Promise<ExecutionResult>;

  /** Agentic execution — sends tools, handles multi-turn. Returns when model produces end_turn. */
  executeWithTools?(
    systemContext: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: ToolDefinition[],
    model: string,
  ): Promise<ToolUseResult>;
}

// ---------------------------------------------------------------------------
// Oversight types
// ---------------------------------------------------------------------------

// Full verdict arrays: source of truth for ReviewVerdict / ArbiterVerdict union types.
// Adding or removing a member here updates both the type and the runtime set atomically.
// "skipped" is in REVIEW_VERDICT_VALUES (it is a valid OversightResult verdict) but is
// excluded from REVIEW_VALID_VERDICTS (the LLM-parseable set) — see comment below.
const REVIEW_VERDICT_VALUES = ["approved", "rejected", "skipped", "completed_with_notes", "completed_with_deferrals"] as const;
const ARBITER_VERDICT_VALUES = ["approved", "rejected", "escalate", "completed_with_notes", "completed_with_deferrals"] as const;

export type ReviewVerdict = typeof REVIEW_VERDICT_VALUES[number];
export type ArbiterVerdict = typeof ARBITER_VERDICT_VALUES[number];

// LLM-parseable subset — excludes "skipped" because it is injected by the orchestrator's
// shouldSkipReview() path, not produced by the LLM. Accepting "skipped" from raw LLM
// output would allow adversarial worker content to self-attest a bypass.
const REVIEW_LLM_VERDICTS = ["approved", "rejected", "completed_with_notes", "completed_with_deferrals"] as const;

/** Values accepted from raw LLM reviewer output — parseReviewResponse validation. */
export const REVIEW_VALID_VERDICTS = new Set<ReviewVerdict>(REVIEW_LLM_VERDICTS);

/** All valid ArbiterVerdict values — parseArbiterResponse validation. */
export const ARBITER_VALID_VERDICTS = new Set<ArbiterVerdict>(ARBITER_VERDICT_VALUES);

/** Oversight verdicts that count as task success — task moves to completedIds,
 *  worktree merges, and tasks.json is updated with a non-failed status.
 *  Single source of truth imported by orchestrator, oversight, and run.ts. */
export const SUCCESS_VERDICTS = new Set<ReviewVerdict | ArbiterVerdict>([
  "approved", "skipped", "completed_with_notes", "completed_with_deferrals",
]);

export interface OversightResult {
  verdict: ReviewVerdict | ArbiterVerdict;
  retryCount: number;
  arbiterInvolved: boolean;
  humanEscalation: boolean;
  rejectionReasons: string[];
  totalResolutionTimeMs: number;
  /** A passed task's items the reviewer left for a person, one line each.
   *  Absent when there are none. */
  deferred?: string[];
  /** A passed task's deviations the reviewer accepted, one line each.
   *  Absent when there are none. */
  notes?: string[];
}

export interface ReviewPolicy {
  oversight: {
    roles: Record<string, unknown>;
    review_policy: {
      always_review: string[];
      review_if_large: {
        files_changed_threshold: number;
        lines_changed_threshold: number;
      };
      skip_review: string[];
    };
    disagreement_protocol: Record<
      string,
      { description: string; action: string; max_attempts: number }
    >;
  };
}

// ---------------------------------------------------------------------------
// Swarm.run() return types
// ---------------------------------------------------------------------------

export interface SwarmRunResult {
  output: string;
  intent: string;
  filesLoaded: string[];
  /** `input` counts all input tokens, cache included; see WorkerTaskOutput. */
  tokensUsed: { context: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
  latencyMs: number;
  sessionId: string;
  maxTurnsReached?: boolean;
  /** The run reached RunOptions.taskTokenLimit. */
  tokenLimitExceeded?: boolean;
  backendType?: WorkerBackendType;
  fallbackUsed?: boolean;
  telemetryEventId?: string;
  /**
   * The document index the session started with, the guard its reads went
   * through, and how it read them (when its backend counted). Only when
   * `contextPull` is on and there were documents to index.
   */
  documents?: { index: string; guard: DocumentGuard; reads?: DocumentReads };
}

export interface SwarmOversightRunResult extends SwarmRunResult {
  oversight: OversightResult;
}

export interface RunOptions {
  /** The content to process (code diff, issue description, etc.). */
  input: string;

  /** Project identifier for domain file resolution (e.g., "ios-app"). */
  project?: string;

  /** Override the intent classification. */
  intentOverride?: string;

  /** Additional context to prepend (on top of swarm files). */
  additionalContext?: string;

  /** Working directory for tool execution (file reads, commands). */
  workingDirectory?: string;

  /** Maximum agentic loop iterations before stopping. Default: 50. */
  maxTurns?: number;

  /** Per-task token limit (all input, cache included, plus output). The
   *  agentic loop stops when it is reached; a CLI backend's result is flagged
   *  with tokenLimitExceeded. 0 or unset: no limit. */
  taskTokenLimit?: number;

  /** Abort signal for external cancellation of the agentic loop. */
  abortSignal?: AbortSignal;

  /** When false, skip the reviewer/arbiter oversight chain entirely.
   *  Derived from trust-level configuration (e.g., medium/high trust skips review).
   *  Defaults to true for backwards compatibility. */
  reviewRequired?: boolean;
}
