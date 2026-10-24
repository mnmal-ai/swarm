import { readGitHeadSha } from "./git-head.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
  SwarmConfig,
  SwarmRunResult,
  SwarmOversightRunResult,
  ISwarmEventBus,
  IWorkerBackend,
  RunOptions,
  WorkerBackendType,
  WorkerTaskOutput,
  TelemetryAdapter,
  OversightRunner,
  TranscriptEntry,
  ClassificationResult,
  ContextRecord,
  DocumentGuard,
  DocumentReads,
  WorkerTaskInput,
} from "@mnmal-ai/swarm-types";
import type {
  SwarmQueryClient,
  IndexedDocument,
  ObserveRequest,
  ObserveResponse,
} from "@mnmal-ai/swarm-substrate";
import { TaskTelemetryBuffer } from "@mnmal-ai/swarm-substrate";

/**
 * Optional capabilities the concrete Telemetry adapter / Oversight runner expose
 * for the buffered atomic-telemetry path but that are NOT on the lean
 * TelemetryAdapter / OversightRunner interfaces. Swarm feature-detects them
 * structurally so the interfaces (and the swarm-types package) stay untouched;
 * adapters that omit them simply fall back to the per-row path.
 */
type BufferableTelemetry = TelemetryAdapter & {
  setTaskBuffer?(buffer?: TaskTelemetryBuffer): void;
  emitTranscript?(entry: TranscriptEntry): Promise<void>;
};
type BufferableOversight = OversightRunner & {
  setTaskBuffer?(buffer?: TaskTelemetryBuffer): void;
};
/**
 * The plane-observation helper lives on SubstrateClient (full database mode) but is
 * deliberately NOT on the lean SwarmQueryClient interface — FileQueryAdapter
 * (file-only mode) has no plane to write to. Swarm feature-detects it
 * structurally, same as BufferableTelemetry/BufferableOversight above, so the
 * interface (and the swarm-types/substrate contract) stay untouched and a client
 * without a plane simply produces no observations.
 */
type ObserveCapable = {
  observe?(request: ObserveRequest): Promise<ObserveResponse | null>;
};
import { Router, FALLBACK_ROUTE } from "./router/index.js";
import { Loader } from "./loader/index.js";
import { createProvider } from "./executor/index.js";
import { getBuiltinTools, executeTool } from "./tools/index.js";
import { type DocumentIndex, displayPath, renderDocumentIndex } from "./document-index.js";
import { createHash } from "node:crypto";
import {
  dropContextFiles,
  parseRuleFile,
  planRules,
  renderRulesBlock,
  rulesRecord,
  type RuleFile,
  type RulePlan,
  type RulesRecord,
} from "./agent-rules.js";

import { RateLimitError, formatTokens, isLoginExpired } from "@mnmal-ai/swarm-types";

/**
 * Tools whose output is the literal contents of a file/notebook.
 * `redactToolOutput` substitutes a length marker for these to keep
 * postmortem artifacts free of `.env`, credential JSONs, key files,
 * and the like. Module-scoped so the Set isn't reallocated on every
 * tool-end emit.
 */
const FILE_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "read_file",
  "NotebookRead",
]);

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { SkillFetcher } from "./skill-fetcher/index.js";

/**
 * Dependencies injected into the Swarm class.
 * `queryClient` is required — Router and Loader use it to query swarm content.
 * It may be a SubstrateClient (full database mode) or a FileQueryAdapter (file-only mode).
 * Other deps are optional — when omitted, Swarm works for basic routing + loading + execution
 * but does not emit telemetry or support oversight.
 */
export interface SwarmDeps {
  queryClient: SwarmQueryClient;
  telemetry?: TelemetryAdapter;
  oversight?: OversightRunner;
  eventBus?: ISwarmEventBus;
  fallbackBackend?: IWorkerBackend | null;
  /**
   * Store the task checkout's documents as sections before its context is
   * assembled. Called with the task's working directory when
   * `config.contextSections` is on. A failure is logged and the task loads
   * whole files.
   */
  syncSections?: (workingDirectory: string) => Promise<void>;
}

/**
 * Sanitize an error for logging/telemetry: strip potential API keys and truncate.
 */
function sanitizeReason(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S{20,}/gi, "Bearer [REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{82}/g, "[REDACTED]")
    .replace(/gh[os]_[A-Za-z0-9]{36}/g, "[REDACTED]")
    .replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]{30,}/g, "[REDACTED]")
    // Redact passwords in postgres connection URLs
    .replace(/postgres(ql)?:\/\/([^:]+):([^@]+)@/gi, "postgres$1://$2:[REDACTED]@")
    .slice(0, 200);
}

/**
 * Normalized output of the run preamble (classify + load + assemble context).
 * Abstracts over the two paths Swarm.run can take to produce it — the single
 * `prepareTask` round trip (Substrate-backed clients) and the per-step
 * Router/Loader fallback (file-only clients) — so the run body consumes one
 * shape regardless of which path produced it.
 */
interface RunPreamble {
  intent: string;
  confidence: ClassificationResult["confidence"];
  matchedKeywords: string[];
  routeDescription: string;
  /** Loaded files without content — feeds the context:loaded event + telemetry. */
  files: Array<{ path: string; tier: string; estimatedTokens: number }>;
  totalTokens: number;
  budgetMax: number;
  budgetUsedPercent: number;
  truncated: string[];
  /** Optional-tier files the budget left out, with their size. */
  omitted: Array<{ path: string; tier: string; estimatedTokens: number }>;
  /** Assembled markdown context blob fed to the model. */
  context: string;
  /** Stored documents the session can read by section, when an index was asked for. */
  documents?: IndexedDocument[];
  /** What ranking did, when context.ranking asked for it. */
  ranking?: ContextRecord["ranking"];
}

/**
 * The session's context record for telemetry: budget, loaded, left out, and
 * (context.pull) the document index it started with and how it read it.
 */
function contextRecord(
  preamble: Pick<RunPreamble, "budgetMax" | "files" | "omitted" | "ranking">,
  index?: DocumentIndex,
  reads?: DocumentReads,
  rules?: { record: RulesRecord; paths: readonly string[] },
): ContextRecord {
  const entry = (f: { path: string; tier: string; estimatedTokens: number }) => ({
    path: f.path,
    tier: f.tier,
    tokens: f.estimatedTokens,
  });
  // Rule files delivered as the rules block are counted under `rules`, not as loaded files.
  const asRules = new Set(rules?.paths ?? []);
  return {
    budgetTokens: preamble.budgetMax,
    loaded: preamble.files.filter((f) => !asRules.has(f.path)).map(entry),
    omitted: preamble.omitted.map(entry),
    ...(index
      ? { index: { documents: index.documents, expanded: index.expanded, folded: index.folded, dropped: index.dropped, tokens: index.tokens } }
      : {}),
    ...(reads ? { reads } : {}),
    ...(rules ? { rules: rules.record } : {}),
    ...(preamble.ranking ? { ranking: preamble.ranking } : {}),
  };
}

export class Swarm {
  private config: SwarmConfig;
  private router: Router;
  private loader: Loader;
  private telemetry?: TelemetryAdapter;
  private swarmCommitSha: string;
  private eventBus?: ISwarmEventBus;
  private fallbackBackend: IWorkerBackend | null = null;
  private readonly syncSections?: (workingDirectory: string) => Promise<void>;
  private skillFetcher: SkillFetcher;
  private oversightRunner?: OversightRunner;
  private queryClient: SwarmQueryClient;

  constructor(config: SwarmConfig, deps: SwarmDeps) {
    this.config = config;
    this.queryClient = deps.queryClient;
    this.router = new Router(deps.queryClient);
    this.loader = new Loader(deps.queryClient);
    this.eventBus = deps.eventBus ?? config.eventBus;
    this.fallbackBackend = deps.fallbackBackend ?? null;
    this.syncSections = deps.syncSections;
    this.skillFetcher = new SkillFetcher(config.swarmPath, this.eventBus);

    // DI: accept telemetry and oversight from deps instead of constructing them
    this.telemetry = deps.telemetry;
    this.oversightRunner = deps.oversight;

    this.swarmCommitSha = this.getSwarmCommitSha();
  }

  /**
   * Run a task with swarm context. No oversight.
   *
   * When the provider supports tool use, runs an agentic loop that lets the
   * model call built-in tools (read_file, write_file, list_directory,
   * run_command) until it produces a final text response or reaches maxTurns.
   * Falls back to single-shot execution if the provider does not implement
   * executeWithTools().
   */
  async run(task: string, options: RunOptions): Promise<SwarmRunResult> {
    const sessionId = `sess-${uuidv4()}`;
    // Defer API provider creation — only needed for the agentic loop fallback
    // and single-shot API path. When claude-code is the primary backend,
    // this may never be called, so don't require ANTHROPIC_API_KEY upfront.
    let _cachedProvider: ReturnType<typeof createProvider> | undefined;
    const getProvider = () => {
      if (!_cachedProvider) {
        _cachedProvider = createProvider(this.config.provider, this.resolveApiKey());
      }
      return _cachedProvider;
    };

    // Emit session:start and agent:role
    this.eventBus?.emit("session:start", {
      sessionId,
      swarmPath: basename(this.config.swarmPath),
      provider: this.config.provider,
      model: this.config.model,
      role: "worker",
      swarmVersion: this.swarmCommitSha,
      project: options.project,
      timestamp: Date.now(),
    });
    this.eventBus?.emit("agent:role", {
      sessionId,
      role: "worker",
      model: this.config.model,
      provider: this.config.provider,
      timestamp: Date.now(),
    });

    // 1-3. Classify intent → load swarm files → score complexity → assemble
    // context. On a Substrate-backed client this is ONE `prepareTask` round trip
    // (the resolver composes classifyIntent + loadContext + complexity
    // server-side); file-only clients that omit the resolver fall back to the
    // per-step Router/Loader path inside preparePreamble(). The events and the
    // assembled context below are identical on both paths.
    if (this.config.contextSections && this.syncSections) {
      try {
        await this.syncSections(options.workingDirectory ?? process.cwd());
      } catch (err) {
        console.warn(`[swarm] sections not synced, so this task loads whole files: ${sanitizeReason(err)}`);
      }
    }
    const preamble = await this.preparePreamble(task, options);

    // LoadResult/Classification-shaped views so the telemetry + return code
    // downstream stays untouched. Only the fields it reads are reconstructed:
    // classification.intent, loadResult.files[].path, loadResult.totalTokens.
    const classification = { intent: preamble.intent };
    const loadResult = {
      files: preamble.files,
      totalTokens: preamble.totalTokens,
    };

    this.eventBus?.emit("intent:classified", {
      sessionId,
      intent: preamble.intent,
      confidence: preamble.confidence,
      matchedKeywords: preamble.matchedKeywords,
      routeDescription: preamble.routeDescription,
      timestamp: Date.now(),
    });
    // High signal: the chosen mode/route shapes everything downstream.
    this.observePlane("intent:classified", `intent ${preamble.intent}`, 75);

    this.eventBus?.emit("context:loaded", {
      sessionId,
      files: preamble.files,
      totalTokens: preamble.totalTokens,
      budgetMax: preamble.budgetMax,
      budgetUsedPercent: preamble.budgetUsedPercent,
      truncated: preamble.truncated,
      omitted: preamble.omitted,
      timestamp: Date.now(),
    });
    // Medium signal: which swarm files were in scope for this run.
    this.observePlane(
      "context:loaded",
      `context ${preamble.files.length} files ${preamble.totalTokens} tok`,
      40,
    );

    // 3. Assemble context (already assembled server-side on the prepareTask
    // path; assembled from the loaded files on the fallback path).
    let context = preamble.context;
    if (options.additionalContext) {
      context = `${options.additionalContext}\n\n${context}`;
    }

    // 4. Build prompt (with pre-read for investigation/orchestration)
    let prompt = options.input
      ? `${task}\n\n${options.input}`
      : task;

    const isInvestigation = classification.intent === "investigation";
    const isOrchestration = classification.intent === "orchestration";

    // 5. Get tools
    const tools = getBuiltinTools();
    const workingDirectory = options.workingDirectory ?? process.cwd();
    let maxTurns = options.maxTurns ?? 50;

    // Stage 2 of the context-sections spec (context.pull): list the stored
    // documents the session can read by section after its swarm context, and
    // guard their reads so a large one is read a section at a time. Only a
    // direct-execution backend gets them: its Read takes a line range and runs
    // the guard. The API loop's read_file reads whole files, so its context
    // stays as it was.
    const pull = this.config.contextSections ? this.config.contextPull : undefined;
    let documentIndex: DocumentIndex | undefined;
    let guard: DocumentGuard | undefined;
    let directContext = context;
    // context.rules: over budget, a direct-execution session gets the rules
    // block (must and pinned rules in full, the most relevant should rules,
    // the rest by line range) in place of the rule files in its context.
    let rules: RulesDelivery | null = null;
    if (this.config.contextRules && this.config.workerBackend?.supportsDirectExecution) {
      const delivery = await this.rulesDelivery(prompt, options.project);
      if (delivery) {
        const kept = dropContextFiles(preamble.context, preamble.files, delivery.files.map((f) => f.path));
        if (kept === null) {
          console.warn("[swarm] rules: the context did not split by file, so this session gets its rules in full");
        } else {
          rules = delivery;
          const rest = options.additionalContext ? [options.additionalContext, kept].filter((t) => t !== "").join("\n\n") : kept;
          directContext = rest !== "" ? `${delivery.block}\n\n${rest}` : delivery.block;
        }
      }
    }
    const rulePaths = new Set(rules?.files.map((f) => f.path) ?? []);
    const indexedDocuments = rules ? preamble.documents?.filter((d) => !(d.source === "swarm" && rulePaths.has(d.path))) : preamble.documents;
    if (pull && this.config.workerBackend?.supportsDirectExecution && indexedDocuments && indexedDocuments.length > 0) {
      const roots = { swarm: resolve(this.config.swarmPath), project: resolve(workingDirectory) };
      const rendered = renderDocumentIndex({
        documents: indexedDocuments,
        budgetTokens: preamble.budgetMax,
        taskText: prompt,
        roots,
        maxReadTokens: pull.maxReadTokens,
      });
      if (rendered.text !== "") {
        documentIndex = rendered;
        directContext = directContext ? `${directContext}\n\n${rendered.text}` : rendered.text;
        guard = {
          maxReadTokens: pull.maxReadTokens,
          documents: indexedDocuments.map((d) => ({
            absolutePath: resolve(d.source === "swarm" ? roots.swarm : roots.project, d.path),
            displayPath: displayPath(d, roots),
            contentHash: d.contentHash,
            sections: d.sections.map(({ startLine, endLine, headingPath, synopsis, tokens }) => ({ startLine, endLine, headingPath, synopsis, tokens })),
          })),
        };
      }
    }
    // A rule file with index lines joins the read guard, so a whole read of a
    // large rules file is refused with its outline (context.pull).
    if (rules && pull) {
      const ruleDocs = rules.files
        .filter((f) => f.absolutePath !== null && rules?.plan.indexed.some((s) => s.path === f.path))
        .map((f) => ({
          absolutePath: f.absolutePath as string,
          displayPath: f.absolutePath as string,
          contentHash: createHash("sha256").update(f.content).digest("hex"),
          sections: parseRuleFile(f).map(({ startLine, endLine, headingPath, synopsis, tokens }) => ({ startLine, endLine, headingPath, synopsis, tokens })),
        }));
      if (ruleDocs.length > 0) {
        guard = guard ? { ...guard, documents: [...guard.documents, ...ruleDocs] } : { maxReadTokens: pull.maxReadTokens, documents: ruleDocs };
      }
    }
    const rulesForRecord = rules ? { record: rules.record, paths: [...rulePaths] } : undefined;
    // What the run reports about its documents: the index, the guard, and how the session read them.
    const documentsResult = (reads?: DocumentReads) =>
      guard && documentIndex ? { documents: { index: documentIndex.text, guard, ...(reads ? { reads } : {}) } } : {};

    // Pre-read optimization: for investigation and orchestration tasks on the
    // API loop, pre-read the source files so the model has codebase context
    // without a read_file round trip per file. A backend that reads files
    // itself (direct execution) is pointed at the checkout instead: the
    // pre-read put up to 500 KB in a prompt that is sent again on every call,
    // and such a session can read just the files it needs.
    if ((isInvestigation || isOrchestration) && workingDirectory) {
      const readsFiles = this.config.workerBackend?.supportsDirectExecution === true;
      const preReadContent = readsFiles ? "" : await this.preReadSourceFiles(workingDirectory);
      const preReadConfig = resolvePreReadConfig(
        classification.intent,
        preReadContent.length > 0,
        maxTurns, // Always pass the resolved maxTurns (user config or default 50)
      );
      maxTurns = preReadConfig.maxTurns;

      if (preReadConfig.preReadApplied) {
        prompt = `${prompt}\n\n## Pre-loaded Source Files\n\nThe following source files have been pre-read from the project directory. Use this content to ${isInvestigation ? "answer the investigation without calling read_file unless you need files not shown here" : "understand the codebase structure and produce an informed task decomposition"}.\n\n${preReadContent}`;
      } else if (readsFiles) {
        prompt = `${prompt}\n\n## Source files\n\nThe project's source is in your working directory. Read the files you need to ${isInvestigation ? "answer the investigation" : "plan the tasks"} with Glob, Grep and Read (by line range for a large file), rather than reading everything.`;
      }
    }

    // Every direct-execution attempt below, primary, retry or fallback, gets the same input.
    const execInput: WorkerTaskInput = {
      task: prompt,
      workingDirectory,
      swarmContext: directContext,
      maxTurns,
      ...(guard ? { documents: guard } : {}),
    };

    // CLI backend dispatch: if a backend with direct execution support is configured, use it.
    // If the primary backend fails and the fallback also supports direct execution, use the
    // fallback. If the fallback does NOT support direct execution (e.g., API backend), fall
    // through to the agentic loop below instead of calling execute() on it.
    if (this.config.workerBackend?.supportsDirectExecution) {
      const backend = this.config.workerBackend;

      let cliResult: WorkerTaskOutput | null = null;
      let actualBackendType: IWorkerBackend["type"] = backend.type;
      let fallbackUsed = false;

      // Per-task availability check
      const backendAvailable = await backend.isAvailable();
      if (!backendAvailable && this.fallbackBackend) {
        if (this.fallbackBackend.supportsDirectExecution) {
          console.warn(`[swarm] Primary backend "${backend.type}" unavailable. Using fallback.`);
          this.eventBus?.emit("backend:fallback", {
            from: backend.type,
            to: this.fallbackBackend.type,
            reason: "isAvailable() returned false",
            timestamp: Date.now(),
          });
          cliResult = await this.fallbackBackend.execute(execInput);
          actualBackendType = this.fallbackBackend.type;
          fallbackUsed = true;
        } else {
          console.warn(`[swarm] Primary backend "${backend.type}" unavailable. Fallback "${this.fallbackBackend.type}" does not support direct execution — using agentic loop.`);
          this.eventBus?.emit("backend:fallback", {
            from: backend.type,
            to: this.fallbackBackend.type,
            reason: "isAvailable() returned false; fallback uses agentic loop",
            timestamp: Date.now(),
          });
        }
      } else {
        try {
          cliResult = await backend.execute(execInput);
        } catch (err) {
          // An expired login fails every session, here and on any fallback:
          // no retry, and never a switch to another backend or an API key.
          if (isLoginExpired(err)) throw err;
          // Helper: pause for a rate limit, emit events, return after sleeping.
          const pauseForRateLimit = async (rlErr: { waitMs: number; resetAt: Date; message: string }) => {
            const waitMinutes = Math.ceil(rlErr.waitMs / 60_000);
            console.warn(`[swarm] ${rlErr.message}`);
            console.warn(`[swarm] Pausing for ${waitMinutes} minute(s) until rate limit resets...`);

            this.eventBus?.emit("backend:rate-limited", {
              backend: backend.type,
              sessionId,
              waitingSince: Date.now(),
              estimatedWaitMs: rlErr.waitMs,
              resetAt: rlErr.resetAt.toISOString(),
              timestamp: Date.now(),
            });

            const MAX_WAIT_MS = 2 * 60 * 60 * 1000; // 2 hours
            if (rlErr.waitMs > MAX_WAIT_MS) {
              throw new Error(
                `[swarm] Rate limit wait of ${Math.ceil(rlErr.waitMs / 60_000)} minutes exceeds 2-hour cap. Not sleeping.`,
              );
            }
            await sleep(rlErr.waitMs);

            console.log(`[swarm] Rate limit should be cleared. Resuming execution...`);
            this.eventBus?.emit("backend:rate-limit-cleared", {
              backend: backend.type,
              sessionId,
              waitedMs: rlErr.waitMs,
              timestamp: Date.now(),
            });
          };

          // Helper: execute on the primary backend with post-failure fallback.
          // Returns { executed: true, result, backendType } when a backend produced output,
          // or { executed: false } when no direct-execution backend was available (agentic loop fallback).
          const executeWithFallback = async (failureContext: string): Promise<
            | { executed: true; result: WorkerTaskOutput; backendType: IWorkerBackend["type"]; fallback: boolean }
            | { executed: false }
          > => {
            try {
              const result = await backend.execute(execInput);
              console.log(`[swarm] Primary backend "${backend.type}" succeeded after ${failureContext}.`);
              return { executed: true, result, backendType: backend.type, fallback: false };
            } catch (postErr) {
              if (isLoginExpired(postErr)) throw postErr;
              const postReason = sanitizeReason(postErr);
              console.warn(`[swarm] Backend still failed after ${failureContext}: ${postReason}. Proceeding to fallback.`);
              if (this.fallbackBackend?.supportsDirectExecution) {
                this.eventBus?.emit("backend:fallback", {
                  from: backend.type,
                  to: this.fallbackBackend.type,
                  reason: `${failureContext} failed: ${postReason}`,
                  timestamp: Date.now(),
                });
                const result = await this.fallbackBackend.execute(execInput);

                // SDK-05: Validate fallback output is non-empty before accepting it.
                if (!result.output || result.output.trim().length === 0 ||
                    result.tokensUsed.output === 0) {
                  console.error(`[swarm] Fallback backend "${this.fallbackBackend.type}" produced empty/zero-token output. Result may be unusable.`);
                }

                return { executed: true, result, backendType: this.fallbackBackend.type, fallback: true };
              } else if (this.fallbackBackend) {
                this.eventBus?.emit("backend:fallback", {
                  from: backend.type,
                  to: this.fallbackBackend.type,
                  reason: `${failureContext} failed: ${postReason}; fallback uses agentic loop`,
                  timestamp: Date.now(),
                });
                return { executed: false };
              } else {
                throw postErr;
              }
            }
          };

          // Helper: apply the result from executeWithFallback to the outer variables.
          const applyFallbackResult = (
            outcome: Awaited<ReturnType<typeof executeWithFallback>>,
          ) => {
            if (outcome.executed) {
              cliResult = outcome.result;
              actualBackendType = outcome.backendType;
              fallbackUsed = outcome.fallback;
            }
            // When !outcome.executed, cliResult stays null → falls through to agentic loop.
          };

          // Rate limit: sleep until the reset time, then retry.
          if (err instanceof RateLimitError) {
            await pauseForRateLimit(err);
            applyFallbackResult(await executeWithFallback("rate limit pause"));
          } else {
            const reason = sanitizeReason(err);

            // SDK-05: Retry the primary backend once before falling back.
            console.warn(`[swarm] Backend "${backend.type}" failed: ${reason}. Retrying primary once before fallback.`);
            try {
              cliResult = await backend.execute(execInput);
              console.log(`[swarm] Primary backend "${backend.type}" succeeded on retry.`);
            } catch (retryErr) {
              if (isLoginExpired(retryErr)) throw retryErr;
              // Rate limit on retry: pause instead of falling back
              if (retryErr instanceof RateLimitError) {
                await pauseForRateLimit(retryErr);
                applyFallbackResult(await executeWithFallback("rate limit pause (retry)"));
              } else {
                const retryReason = sanitizeReason(retryErr);
                console.warn(`[swarm] Primary backend "${backend.type}" retry also failed: ${retryReason}. Proceeding to fallback.`);

                if (this.fallbackBackend?.supportsDirectExecution) {
                  console.warn(`[swarm] Using fallback backend "${this.fallbackBackend.type}".`);
                  this.eventBus?.emit("backend:fallback", {
                    from: backend.type,
                    to: this.fallbackBackend.type,
                    reason: `primary: ${reason}; retry: ${retryReason}`,
                    timestamp: Date.now(),
                  });
                  cliResult = await this.fallbackBackend.execute(execInput);

                  // SDK-05: Validate fallback output is non-empty before accepting it.
                  if (!cliResult.output || cliResult.output.trim().length === 0 ||
                      cliResult.tokensUsed.output === 0) {
                    console.error(`[swarm] Fallback backend "${this.fallbackBackend.type}" produced empty/zero-token output. Result may be unusable.`);
                  }

                  actualBackendType = this.fallbackBackend.type;
                  fallbackUsed = true;
                } else if (this.fallbackBackend) {
                  console.warn(`[swarm] Backend "${backend.type}" failed after retry: ${retryReason}. Fallback "${this.fallbackBackend.type}" does not support direct execution — using agentic loop.`);
                  this.eventBus?.emit("backend:fallback", {
                    from: backend.type,
                    to: this.fallbackBackend.type,
                    reason: `primary: ${reason}; retry: ${retryReason}; fallback uses agentic loop`,
                    timestamp: Date.now(),
                  });
                } else {
                  throw retryErr;
                }
              }
            }
          }
        }
      }

      // If we got a CLI result, emit telemetry and return it.
      // If cliResult is null, the fallback doesn't support direct execution
      // and we fall through to the agentic loop below.
      if (cliResult !== null) {
        console.log(`[swarm] Using ${actualBackendType} backend${fallbackUsed ? " (fallback)" : ""}`);

        // Emit transcript for CLI backend path
        const cliTranscript: TranscriptEntry = {
          sessionId,
          role: "worker" as const,
          timestamp: new Date().toISOString(),
          prompt: `## Task\n${prompt}\n\n## Swarm Context\n${context}`,
          response: cliResult.output,
          tokens: { input: cliResult.tokensUsed.input, output: cliResult.tokensUsed.output },
          backend: actualBackendType,
          authorId: this.config.authorId,
        };
        this.eventBus?.emit("transcript", cliTranscript);
        await this.persistWorkerTranscript(cliTranscript);

        if (this.telemetry) {
          const event = this.telemetry.buildEvent({
            sessionId,
            role: "worker",
            provider: actualBackendType,
            modelId: `${actualBackendType}-cli`,
            swarmCommitSha: this.swarmCommitSha,
            intent: classification.intent,
            filesLoaded: loadResult.files.map((f) => f.path),
            contextTokensUsed: loadResult.totalTokens,
            context: contextRecord(preamble, documentIndex, cliResult.documentReads, rulesForRecord),
            ...(cliResult.fnlCoverage ? { fnlCoverage: cliResult.fnlCoverage } : {}),
            inputTokens: cliResult.tokensUsed.input,
            outputTokens: cliResult.tokensUsed.output,
            latencyMs: cliResult.latencyMs,
            inputSummary: task.slice(0, 200),
            outputSummary: cliResult.output.slice(0, 200),
            authorId: this.config.authorId,
          });
          await this.telemetry.emit(event);
        }

        // Check the per-task token limit for the CLI backend — consistent
        // with the agentic loop's break-at-limit behavior. CLI backends can't
        // be interrupted mid-execution, so we flag the result instead. Counts
        // all input (cache reads and writes included) plus output.
        const taskTokenLimit = options.taskTokenLimit ?? 0;
        const cliTokens = cliResult.tokensUsed.input + cliResult.tokensUsed.output;
        const tokenLimitExceeded = taskTokenLimit > 0 && cliTokens >= taskTokenLimit;
        if (tokenLimitExceeded) {
          console.warn(`[swarm] CLI task token limit reached: ${formatTokens(cliTokens)} >= ${formatTokens(taskTokenLimit)} tokens`);
        }

        this.eventBus?.emit("session:end", {
          sessionId,
          role: "worker",
          totalInputTokens: cliResult.tokensUsed.input,
          totalOutputTokens: cliResult.tokensUsed.output,
          totalTurns: 1,
          latencyMs: cliResult.latencyMs,
          maxTurnsReached: false,
          tokenLimitExceeded,
          backendType: actualBackendType,
          ...(cliResult.fnlCoverage ? { fnl: cliResult.fnlCoverage } : {}),
          ...(cliResult.documentReads ? { docs: cliResult.documentReads } : {}),
          timestamp: Date.now(),
        });
        // High signal: terminal outcome of the worker session.
        this.observePlane(
          "session:end",
          `session end ${actualBackendType}${tokenLimitExceeded ? " token-capped" : ""}`,
          75,
        );

        return {
          output: cliResult.output,
          intent: classification.intent,
          filesLoaded: loadResult.files.map((f) => f.path),
          tokensUsed: {
            context: loadResult.totalTokens,
            input: cliResult.tokensUsed.input,
            output: cliResult.tokensUsed.output,
            // The prompt-cache share of `input`, when the backend reports it —
            // the dashboard shows fresh input apart from cached input.
            ...(cliResult.tokensUsed.cacheRead !== undefined ? { cacheRead: cliResult.tokensUsed.cacheRead } : {}),
            ...(cliResult.tokensUsed.cacheWrite !== undefined ? { cacheWrite: cliResult.tokensUsed.cacheWrite } : {}),
          },
          latencyMs: cliResult.latencyMs,
          sessionId,
          telemetryEventId: undefined,
          tokenLimitExceeded,
          fallbackUsed,
          backendType: actualBackendType,
          ...documentsResult(cliResult.documentReads),
        };
      }
    }

    // 6. Execute — agentic loop or single-shot fallback
    const apiProvider = getProvider();
    if (!apiProvider.executeWithTools) {
      // Fallback for providers without tool support
      const result = await apiProvider.execute(
        { systemContext: context, prompt },
        this.config.model,
      );

      // Emit transcript for single-shot API path
      const singleShotTranscript: TranscriptEntry = {
        sessionId,
        role: "worker" as const,
        timestamp: new Date().toISOString(),
        prompt: `## Task\n${prompt}\n\n## Swarm Context\n${context}`,
        response: result.output,
        tokens: { input: result.tokens.input, output: result.tokens.output },
        backend: this.config.provider,
        authorId: this.config.authorId,
      };
      this.eventBus?.emit("transcript", singleShotTranscript);
      await this.persistWorkerTranscript(singleShotTranscript);

      if (this.telemetry) {
        const event = this.telemetry.buildEvent({
          sessionId,
          role: "worker",
          provider: this.config.provider,
          modelId: this.config.model,
          swarmCommitSha: this.swarmCommitSha,
          intent: classification.intent,
          filesLoaded: loadResult.files.map((f) => f.path),
          contextTokensUsed: loadResult.totalTokens,
          context: contextRecord(preamble),
          inputTokens: result.tokens.input,
          outputTokens: result.tokens.output,
          latencyMs: result.latencyMs,
          inputSummary: task.slice(0, 200),
          outputSummary: result.output.slice(0, 200),
          authorId: this.config.authorId,
        });
        await this.telemetry.emit(event);
      }

      return {
        output: result.output,
        intent: classification.intent,
        filesLoaded: loadResult.files.map((f) => f.path),
        tokensUsed: {
          context: loadResult.totalTokens,
          input: result.tokens.input,
          output: result.tokens.output,
        },
        latencyMs: result.latencyMs,
        sessionId,
      };
    }

    // Agentic loop
    const messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> = [
      { role: "user", content: prompt },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalOutput = "";
    let maxTurnsReached = false;
    let tokenLimitExceeded = false;
    let lastTurn = 0;
    const taskTokenLimit = options.taskTokenLimit ?? 0;
    const startTime = Date.now();

    for (let turn = 0; turn < maxTurns; turn++) {
      // Check external abort signal at the top of each turn
      if (options.abortSignal?.aborted) {
        console.warn(`[swarm] Task aborted via abortSignal before turn ${turn + 1}.`);
        maxTurnsReached = false;
        break;
      }

      this.eventBus?.emit("turn:start", {
        turn,
        messageCount: messages.length,
        timestamp: Date.now(),
      });

      const result = await apiProvider.executeWithTools!(
        context,
        messages,
        tools,
        this.config.model,
      );

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;

      if (result.toolUseBlocks.length === 0 || result.stopReason === "end_turn") {
        // Model is done — collect final text
        finalOutput = result.outputText;
        lastTurn = turn;
        this.eventBus?.emit("turn:end", {
          turn,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          toolCallCount: 0,
          timestamp: Date.now(),
        });
        break;
      }

      // Model wants to use tools — execute them
      messages.push(result.assistantMessage);

      // Execute each tool and build tool results
      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];

      for (const toolUse of result.toolUseBlocks) {
        this.eventBus?.emit("tool:start", {
          turn,
          toolName: toolUse.name,
          toolInput: this.redactToolInput(toolUse.name, toolUse.input),
          toolUseId: toolUse.id,
          // taskId/sessionId injected by the orchestrator via the
          // session→task mapping it owns — the swarm core doesn't
          // know its own task/session attribution.
          timestamp: Date.now(),
        });
        // Low signal: routine tool invocation, one per call.
        this.observePlane("tool:start", `tool start ${toolUse.name}`, 15);

        const toolStartTime = Date.now();
        const toolResult = await executeTool(
          toolUse.name,
          toolUse.input,
          workingDirectory,
          {
            gitIdentity: this.config.backendConfig?.gitIdentity,
            ghConfigDir: this.config.backendConfig?.ghConfigDir,
          },
        );

        // Output capture policy: redact secrets + file contents FIRST,
        // then apply size cap. 16KB cap on success so well-behaved tool
        // returns don't bloat telemetry; full output on failure so the
        // postmortem has the complete diagnostic trail. The
        // orchestrator's postmortem writer reads `toolOutput` directly
        // and never re-fetches; downstream telemetry shippers may
        // redact further before forwarding, but the primary scrubbing
        // happens here so the eventbus + the Substrate entity never carry
        // a raw `.env`, AWS key, or Bearer token.
        const isError = toolResult.is_error ?? false;
        const SUCCESS_OUTPUT_CAP = 16 * 1024;
        const redactedOutput = this.redactToolOutput(toolUse.name, toolResult.content);
        const toolOutput = isError
          ? redactedOutput
          : redactedOutput.length > SUCCESS_OUTPUT_CAP
            ? redactedOutput.slice(0, SUCCESS_OUTPUT_CAP)
            : redactedOutput;
        const toolOutputTruncated = !isError && redactedOutput.length > SUCCESS_OUTPUT_CAP;

        this.eventBus?.emit("tool:end", {
          turn,
          toolName: toolUse.name,
          durationMs: Date.now() - toolStartTime,
          isError,
          toolUseId: toolUse.id,
          toolOutput,
          toolOutputTruncated,
          errorPreview: isError ? redactedOutput.slice(0, 200) : undefined,
          timestamp: Date.now(),
        });
        // Tool failures carry more signal than clean completions.
        this.observePlane(
          "tool:end",
          `tool end ${toolUse.name} ${isError ? "error" : "ok"}`,
          isError ? 45 : 30,
          isError ? "concern" : "lifecycle",
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: toolResult.content,
          is_error: toolResult.is_error,
        });
      }

      // Add tool results as user message
      messages.push({ role: "user", content: toolResults });

      lastTurn = turn;
      this.eventBus?.emit("turn:end", {
        turn,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCallCount: result.toolUseBlocks.length,
        timestamp: Date.now(),
      });

      // Enforce the per-task token limit (all input plus output so far)
      const taskTokens = totalInputTokens + totalOutputTokens;
      if (taskTokenLimit > 0 && taskTokens >= taskTokenLimit) {
        console.warn(`[swarm] Task token limit reached: ${formatTokens(taskTokens)} >= ${formatTokens(taskTokenLimit)} tokens`);
        tokenLimitExceeded = true;
        break;
      }

      // Check abort signal after tool execution
      if (options.abortSignal?.aborted) {
        console.warn(`[swarm] Task aborted via abortSignal after turn ${turn + 1}.`);
        break;
      }

      // If model produced text alongside tool calls, capture it
      if (result.outputText) {
        finalOutput = result.outputText;
      }

      // Compress history every 10 turns for non-investigation intents
      if (!isInvestigation && turn > 0 && turn % 10 === 0) {
        const compressed = this.compressHistory(messages);
        messages.length = 0;
        messages.push(...compressed);
      }

      // Check if we hit the max turns limit
      if (turn === maxTurns - 1) {
        maxTurnsReached = true;
        console.warn(`[swarm] Warning: agentic loop reached maxTurns limit (${maxTurns}).`);
      }
    }

    const latencyMs = Date.now() - startTime;

    // Emit transcript for agentic loop path
    const agenticTranscript: TranscriptEntry = {
      sessionId,
      role: "worker" as const,
      timestamp: new Date().toISOString(),
      prompt: `## Task\n${prompt}\n\n## Swarm Context\n${context}`,
      response: finalOutput,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      backend: this.config.provider,
      authorId: this.config.authorId,
    };
    this.eventBus?.emit("transcript", agenticTranscript);
    await this.persistWorkerTranscript(agenticTranscript);

    // Emit session:end
    this.eventBus?.emit("session:end", {
      sessionId,
      role: "worker",
      totalInputTokens,
      totalOutputTokens,
      totalTurns: lastTurn + 1,
      latencyMs,
      maxTurnsReached,
      tokenLimitExceeded,
      backendType: "api",
      timestamp: Date.now(),
    });
    // High signal: terminal outcome of the worker session.
    this.observePlane(
      "session:end",
      `session end api ${lastTurn + 1} turns${maxTurnsReached ? " max-turns" : ""}${tokenLimitExceeded ? " token-capped" : ""}`,
      75,
    );

    // Emit telemetry
    if (this.telemetry) {
      const event = this.telemetry.buildEvent({
        sessionId,
        role: "worker",
        provider: this.config.provider,
        modelId: this.config.model,
        swarmCommitSha: this.swarmCommitSha,
        intent: classification.intent,
        filesLoaded: loadResult.files.map((f) => f.path),
        contextTokensUsed: loadResult.totalTokens,
        context: contextRecord(preamble),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs,
        inputSummary: task.slice(0, 200),
        outputSummary: finalOutput.slice(0, 200),
        authorId: this.config.authorId,
      });
      await this.telemetry.emit(event);
    }

    return {
      output: finalOutput,
      intent: classification.intent,
      filesLoaded: loadResult.files.map((f) => f.path),
      tokensUsed: {
        context: loadResult.totalTokens,
        input: totalInputTokens,
        output: totalOutputTokens,
      },
      latencyMs,
      sessionId,
      telemetryEventId: undefined,
      ...(maxTurnsReached ? { maxTurnsReached: true } : {}),
      tokenLimitExceeded,
      backendType: "api",
    };
  }

  /**
   * Classify the task, load swarm context, and assemble it — the run preamble.
   *
   * Prefers the server-side `prepareTask` resolver: ONE round trip that composes
   * classifyIntent + loadContext + a complexity score, returning the assembled
   * context blob ready for the model. Only Substrate-backed clients expose it;
   * FileQueryAdapter (file-only mode) and mock transports omit it, so we
   * feature-detect and fall back to the per-step Router.classify → skill
   * prefetch → Loader.load path. Both paths return the same classification, the
   * byte-identical assembled context, and feed the same events in run().
   *
   * Note on remote skills (`https://` URLs in `SwarmRoute.contentPaths`): the
   * fallback path calls `SkillFetcher.prefetch` which fetches the URL and
   * caches it locally before the Loader runs. The prepareTask path has no
   * equivalent server-side hook — the resolver matches SwarmContent entities
   * by stored path and the assembler filters `https://` URLs out before that
   * match, so a remote URL is only included if a SwarmContent entity has been
   * pre-seeded under that exact URL as its `path`. Any URL that isn't pre-
   * seeded surfaces in the `truncated` field of the response (we forward it
   * here verbatim) — callers see it in the `context:loaded` event payload
   * rather than getting silent absence. To eliminate this asymmetry entirely,
   * either pre-seed every remote skill into Substrate before invoking prepareTask
   * or add a server-side prefetch step to the `loadContext` resolver.
   */
  private async preparePreamble(
    task: string,
    options: RunOptions,
  ): Promise<RunPreamble> {
    if (typeof this.queryClient.prepareTask === "function") {
      const prepared = await this.queryClient.prepareTask({
        prompt: task,
        projectId: options.project ?? "",
        modelId: this.config.model,
        intentOverride: options.intentOverride,
        ...(this.config.contextSections ? { sections: true } : {}),
        ...(this.config.contextSections && this.config.contextPull ? { index: true } : {}),
        ...(this.config.contextSections && this.config.contextRanking
          ? { rank: true, rankLimit: this.config.contextRanking.maxSections }
          : {}),
      });
      return {
        intent: prepared.intent,
        confidence: prepared.confidence,
        matchedKeywords: prepared.matchedKeywords,
        // routeMatched is null only for the synthetic fallback intent; mirror
        // Router.classify's FALLBACK_ROUTE description so the intent:classified
        // payload is identical to the file-only path.
        routeDescription:
          prepared.routeMatched?.description ?? FALLBACK_ROUTE.description,
        files: prepared.filesIncluded.map((f) => ({
          path: f.path,
          tier: f.tier,
          estimatedTokens: f.tokens,
        })),
        totalTokens: prepared.tokensUsed,
        budgetMax: prepared.budgetTokens,
        budgetUsedPercent:
          prepared.budgetTokens > 0
            ? (prepared.tokensUsed / prepared.budgetTokens) * 100
            : 0,
        // Budget-truncated optional content + unseeded remote `https://`
        // URLs surface in `prepared.truncated` — mirrors the file-only
        // path's `loadResult.truncated` shape so the `context:loaded` event
        // payload reads the same regardless of which path produced it. Hard
        // failures (required-tier overflow, genuinely missing required
        // files) still throw inside the resolver.
        truncated: prepared.truncated,
        omitted: (prepared.omitted ?? []).map((f) => ({
          path: f.path,
          tier: f.tier,
          estimatedTokens: f.tokens,
        })),
        context: prepared.content,
        ...(prepared.documents ? { documents: prepared.documents } : {}),
        ...(prepared.ranking ? { ranking: prepared.ranking } : {}),
      };
    }

    // Fallback (file-only mode / mock transports): per-step Router/Loader path.
    // Mirrors the previous inline preamble exactly, including calling
    // loader.load WITHOUT a modelId so it takes the per-tier assembly path.
    const classification = await this.router.classify(
      task,
      options.intentOverride,
      options.project,
    );
    const resolvedRoute = await this.skillFetcher.prefetch(classification.route);
    const budget = await this.router.getBudget(this.config.model);
    const priority = await this.router.getLoadingPriority();
    const loadResult = await this.loader.load(
      resolvedRoute,
      budget,
      priority,
      options.project,
    );
    return {
      intent: classification.intent,
      confidence: classification.confidence,
      matchedKeywords: classification.matchedKeywords,
      // Mirror the prepareTask path's `?? FALLBACK_ROUTE.description` guard:
      // a `SwarmRoute` entity in Substrate is allowed to carry an empty
      // `description` (the schema is a plain string field). Coalescing to the
      // FALLBACK_ROUTE description here keeps the `intent:classified` event
      // payload non-empty so monitoring consumers don't see an empty string
      // and assume the event itself is broken.
      routeDescription: classification.route.description || FALLBACK_ROUTE.description,
      files: loadResult.files.map((f) => ({
        path: f.path,
        tier: f.tier,
        estimatedTokens: f.estimatedTokens,
      })),
      totalTokens: loadResult.totalTokens,
      budgetMax: loadResult.budgetMax,
      budgetUsedPercent: loadResult.budgetUsedPercent,
      truncated: loadResult.truncated,
      omitted: (loadResult.omitted ?? []).map((f) => ({
        path: f.path,
        tier: f.tier,
        estimatedTokens: f.estimatedTokens,
      })),
      context: this.loader.assembleContext(loadResult.files),
    };
  }

  /**
   * The project's rules as a rules block (context.rules), or null when the
   * setting is off, the rules fit the budget, or the block can't be built.
   * The rules come from the store, the runtime truth. A rule file's copy in
   * the swarm folder is used only to point sessions at it: when it matches the
   * stored copy, its rules can be listed by line range; when it differs or is
   * missing, that file's rules go in full, so no range can drift from the
   * stored text.
   */
  private async rulesDelivery(task: string, project: string | undefined): Promise<RulesDelivery | null> {
    const cfg = this.config.contextRules;
    if (!cfg) return null;
    try {
      const stored = await this.loader.loadByPaths(ruleFilePaths(project, cfg.paths), project);
      const files: RuleFile[] = [];
      for (const f of stored) {
        const absolutePath = resolve(this.config.swarmPath, f.path);
        let onDisk: string | null = null;
        try {
          onDisk = await readFile(absolutePath, "utf-8");
        } catch {
          onDisk = null;
        }
        files.push({ path: f.path, content: f.content, absolutePath: onDisk === f.content ? absolutePath : null });
      }
      const sections = files.flatMap(parseRuleFile);
      for (const s of sections) {
        if (s.markerError === undefined) continue;
        const key = `${s.path}\u0000${s.headingPath.join("\u0000")}\u0000${s.markerError}`;
        if (warnedRuleMarkers.has(key)) continue;
        warnedRuleMarkers.add(key);
        console.warn(`[swarm] rules: ${s.path} › ${s.headingPath.join(" › ")} has an unknown marker "${s.markerError}"; treating it as must`);
      }
      const plan = planRules(sections, { task, maxTokens: cfg.maxTokens, relevant: cfg.relevant });
      if (!plan.overBudget) return null;
      const block = renderRulesBlock(plan, files);
      return { files, plan, block, record: rulesRecord(plan, block) };
    } catch (err) {
      console.warn(`[swarm] rules: could not build the rules block, so this session gets its rules in full: ${sanitizeReason(err)}`);
      return null;
    }
  }

  /**
   * Run a task with swarm context AND oversight (reviewer/arbiter chain).
   *
   * Wraps the core flow with the per-task telemetry buffer lifecycle: when the
   * query client exposes the atomic `persistTaskTelemetry` resolver (and the
   * telemetry adapter supports buffering), the worker's SessionEvent +
   * TranscriptEntry and the WorkerResult (+ final ReviewVerdict) are buffered
   * during the run and flushed in ONE atomic call at the task boundary. When the
   * resolver is absent, no buffer is attached and every row is written via the
   * existing per-row mutate path (or JSONL when there is no Substrate client) —
   * unchanged behavior. The flush is non-blocking and warns on failure.
   */
  async runWithOversight(
    task: string,
    options: RunOptions,
  ): Promise<SwarmOversightRunResult> {
    const oversightConfig = this.config.oversight;
    const willRunOversight =
      Boolean(oversightConfig?.enabled) && options.reviewRequired !== false;
    const taskBuffer = this.beginTaskTelemetryBuffer(willRunOversight);
    try {
      return await this.runWithOversightCore(task, options);
    } finally {
      await this.endTaskTelemetryBuffer(taskBuffer);
    }
  }

  private async runWithOversightCore(
    task: string,
    options: RunOptions,
  ): Promise<SwarmOversightRunResult> {
    // First, run the worker. The worker-role plane observations (intent,
    // context, tool start/end, session end) are emitted inside run(), so the
    // oversight path inherits the full observation trace without re-emitting —
    // reviewer/arbiter-role observations are a separate sub-task.
    const workerResult = await this.run(task, options);

    // Track the latest worker result — updated by onRetry when the reviewer rejects
    let latestWorkerResult = workerResult;

    const oversightConfig = this.config.oversight;
    if (!oversightConfig?.enabled) {
      return {
        ...latestWorkerResult,
        oversight: {
          verdict: "skipped",
          retryCount: 0,
          arbiterInvolved: false,
          humanEscalation: false,
          rejectionReasons: [],
          totalResolutionTimeMs: 0,
        },
      };
    }

    // Skip oversight when trust level indicates review is not required
    if (options.reviewRequired === false) {
      if (this.telemetry) {
        await this.telemetry.emitOversightEvent({
          session_id: latestWorkerResult.sessionId,
          worker_event_id: latestWorkerResult.telemetryEventId ?? `evt-worker-${latestWorkerResult.sessionId}`,
          reviewer_verdict: "skipped",
          rejection_reasons: [],
          retry_count: 0,
          arbiter_involved: false,
          human_escalation: false,
          total_resolution_time_ms: 0,
          review_skipped_reason: "trust_level",
        });
      }

      this.eventBus?.emit("oversight:verdict", {
        sessionId: latestWorkerResult.sessionId,
        verdict: "skipped",
        arbiterInvolved: false,
        retryCount: 0,
        durationMs: 0,
        timestamp: Date.now(),
      });

      return {
        ...latestWorkerResult,
        oversight: {
          verdict: "skipped",
          retryCount: 0,
          arbiterInvolved: false,
          humanEscalation: false,
          rejectionReasons: [],
          totalResolutionTimeMs: 0,
        },
      };
    }

    // Require oversight runner for the actual chain execution
    if (!this.oversightRunner) {
      throw new Error("Swarm.runWithOversight requires an OversightRunner — pass one via deps.oversight");
    }

    // Load review policy
    const classification = await this.router.classify(
      task,
      options.intentOverride,
      options.project,
    );

    // Prefetch remote skills for the reviewer's route
    const resolvedRoute = await this.skillFetcher.prefetch(classification.route);

    // Load context for the reviewer
    const priority = await this.router.getLoadingPriority();
    const budget = await this.router.getBudget(this.config.model);
    const loadResult = await this.loader.load(
      resolvedRoute,
      budget,
      priority,
      options.project,
    );
    // Reviewer gets mode + domain + oversight context — not just mode.
    // Domain files let the Reviewer catch constraint violations (e.g., "you changed
    // the storage format without migration"). Oversight files let it know its own policy.
    // The project's binding rules, by path rather than by route, so the
    // reviewer and the arbiter always judge the work against them in full.
    // If they can't be read, the review goes ahead with the context it had
    // before reviewers got them (the route's domain files, constraints
    // included), and the run says so.
    let ruleFiles: Array<{ path: string; content: string }> = [];
    try {
      ruleFiles = await this.loader.loadByPaths(ruleFilePaths(options.project, this.config.contextRules?.paths), options.project);
    } catch (err) {
      console.warn(
        `[swarm] could not read the project's binding rules for review: ${err instanceof Error ? err.message : String(err)}. Reviewing with the route's context only.`,
      );
    }
    const bindingRules = formatBindingRules(ruleFiles);
    const reviewerContext = selectReviewerFiles(loadResult.files, ruleFiles.map((f) => f.path));
    // context.rules: over budget, a reviewer or arbiter on a backend gets the
    // rules block; one on the API path keeps the rules in full.
    const rulesForReview = this.config.contextRules
      ? await this.rulesDelivery(options.input ? `${task}\n\n${options.input}` : task, options.project)
      : null;

    // Build onRetry: re-run the worker with reviewer feedback injected.
    // latestRetryContext accumulates feedback across retries so attempt 2
    // sees the feedback from attempt 1 (not just the original context).
    let latestRetryContext = options.additionalContext ?? "";

    const onRetry = async (reasons: string[], attempt: number): Promise<string> => {
      const feedbackPrompt = [
        `## Reviewer Feedback (attempt ${attempt})`,
        "",
        "Your previous output was rejected for these reasons:",
        ...reasons.map(r => `- ${r}`),
        "",
        "Please revise your output to address ALL of these issues.",
      ].join("\n");

      latestRetryContext = [
        latestRetryContext,
        feedbackPrompt,
      ].filter(Boolean).join("\n\n");

      const retryOptions: RunOptions = {
        ...options,
        additionalContext: latestRetryContext,
      };

      // Re-run the worker with feedback — updates latestWorkerResult for the final return
      latestWorkerResult = await this.run(task, retryOptions);
      return latestWorkerResult.output;
    };

    // context.pull: the reviewer gets the worker's document index, headed by
    // the sections the worker read. Read from the latest worker result, so a
    // review after a retry sees that attempt's reads.
    const documentIndex = (): string => {
      const docs = latestWorkerResult.documents;
      if (!docs) return "";
      const read = [...new Set((docs.reads?.ranges ?? []).map((r) => `- ${r.path} L${r.startLine}–${r.endLine}`))];
      return [...(read.length > 0 ? ["## Sections the worker read", ...read, ""] : []), docs.index].join("\n");
    };

    // Run the oversight chain via injected runner
    const oversightResult = await this.oversightRunner.runFullChain({
      modeContext: reviewerContext,
      bindingRules,
      ...(rulesForReview ? { bindingRulesIndexed: rulesForReview.block } : {}),
      originalTask: options.input ? `${task}\n\n${options.input}` : task,
      workerOutput: latestWorkerResult.output,
      maxRetries: 2,
      sessionId: latestWorkerResult.sessionId,
      onRetry,
      reviewerBackend: this.config.reviewerBackend,
      arbiterBackend: this.config.arbiterBackend,
      workingDirectory: options.workingDirectory ?? process.cwd(),
      authorId: this.config.authorId,
      ...(latestWorkerResult.documents ? { documentIndex, documentGuard: latestWorkerResult.documents.guard } : {}),
    });

    // Emit oversight event via telemetry adapter
    if (this.telemetry) {
      await this.telemetry.emitOversightEvent({
        session_id: latestWorkerResult.sessionId,
        worker_event_id: latestWorkerResult.telemetryEventId ?? `evt-worker-${latestWorkerResult.sessionId}`,
        reviewer_verdict:
          oversightResult.verdict === "approved" ||
          oversightResult.verdict === "rejected"
            ? oversightResult.verdict
            : "rejected",
        rejection_reasons: oversightResult.rejectionReasons,
        retry_count: oversightResult.retryCount,
        arbiter_involved: oversightResult.arbiterInvolved,
        arbiter_verdict: oversightResult.arbiterInvolved
          ? (oversightResult.verdict as "approved" | "rejected" | "escalate")
          : undefined,
        human_escalation: oversightResult.humanEscalation,
        total_resolution_time_ms: oversightResult.totalResolutionTimeMs,
      });
    }

    return {
      ...latestWorkerResult,
      oversight: oversightResult,
    };
  }

  /**
   * Emit a cheap, fire-and-forget plane Observation tagged with the worker role.
   * Mirrors the lifecycle points already instrumented for events (intent
   * classified, context loaded, tool start/end, session end) so a scheduled
   * drainstop can later promote high-signal entries into the durable claude
   * store. Three guarantees keep this off the task's critical path:
   *
   *   1. No-op when the client has no plane (FileQueryAdapter / file-only mode).
   *   2. Not awaited — the promise is kicked off and its rejection swallowed, so
   *      a slow or failing plane write never blocks or fails the task.
   *   3. observe() already degrades gracefully (logs + returns null on transport
   *      error); the extra .catch + try guards a missing helper or sync throw.
   *
   * Confidence reflects signal strength: high for intent/session boundaries,
   * low for routine tool starts. Content is kept short — no heavy payloads.
   */
  private observePlane(
    event: string,
    content: string,
    confidence: number,
    kind = "lifecycle",
  ): void {
    const client = this.queryClient as ObserveCapable;
    if (typeof client.observe !== "function") return;
    try {
      void client
        .observe({ kind, content, confidence, tags: ["worker", event] })
        .catch(() => {
          // Observations are best-effort; swallow rejections.
        });
    } catch {
      // Never let an observation break the task.
    }
  }

  /**
   * Persist a worker TranscriptEntry through the telemetry adapter (which scrubs
   * + truncates, then either buffers it for the atomic flush or writes it
   * per-row). Swarm owns worker-transcript persistence so the orchestrator's
   * transcript event subscriber can skip the worker role and avoid a duplicate
   * row. No-op when the adapter does not implement emitTranscript. Non-blocking:
   * a failure warns and is swallowed so it never breaks the run.
   */
  private async persistWorkerTranscript(entry: TranscriptEntry): Promise<void> {
    const tele = this.telemetry as BufferableTelemetry | undefined;
    if (!tele?.emitTranscript) return;
    try {
      await tele.emitTranscript(entry);
    } catch (err) {
      console.warn(
        `[swarm] worker transcript persist failed (non-blocking): ${sanitizeReason(err)}`,
      );
    }
  }

  /**
   * Open a per-task telemetry buffer when the atomic path is available, attaching
   * it to the telemetry adapter and oversight runner so they buffer their rows
   * instead of writing each immediately. Returns the buffer (or undefined when
   * the atomic path is unavailable — caller then gets unchanged per-row behavior).
   */
  private beginTaskTelemetryBuffer(
    willRunOversight: boolean,
  ): TaskTelemetryBuffer | undefined {
    if (!willRunOversight) return undefined;
    const tele = this.telemetry as BufferableTelemetry | undefined;
    // Atomic path requires BOTH the server resolver and a buffer-capable adapter.
    if (
      typeof this.queryClient.persistTaskTelemetry !== "function" ||
      !tele?.setTaskBuffer
    ) {
      return undefined;
    }
    const buffer = new TaskTelemetryBuffer();
    tele.setTaskBuffer(buffer);
    (this.oversightRunner as BufferableOversight | undefined)?.setTaskBuffer?.(
      buffer,
    );
    return buffer;
  }

  /**
   * Detach the per-task buffer and flush it in one atomic
   * `persistTaskTelemetry` call. Detaching FIRST ensures any late writes go
   * per-row rather than into a buffer that is about to be flushed. Non-blocking:
   * a flush failure warns and is swallowed (matching the per-row path's
   * warn-on-failure contract). No-op when no buffer was opened.
   */
  private async endTaskTelemetryBuffer(
    buffer?: TaskTelemetryBuffer,
  ): Promise<void> {
    if (!buffer) return;
    (this.telemetry as BufferableTelemetry | undefined)?.setTaskBuffer?.(
      undefined,
    );
    (this.oversightRunner as BufferableOversight | undefined)?.setTaskBuffer?.(
      undefined,
    );

    if (!buffer.hasRequiredRows()) return; // nothing to flush atomically
    if (typeof this.queryClient.persistTaskTelemetry !== "function") return;
    try {
      await this.queryClient.persistTaskTelemetry(buffer.toRequest());
    } catch (err) {
      console.warn(
        `[swarm] persistTaskTelemetry failed (non-blocking): ${sanitizeReason(err)}`,
      );
    }
  }

  /**
   * Pre-read source files for investigation optimization.
   * Walks the working directory, reads source files, and returns concatenated
   * content with path headers. Respects a 500KB size limit.
   */
  private async preReadSourceFiles(workingDirectory: string): Promise<string> {
    const SOURCE_EXTENSIONS = new Set([
      ".swift", ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs",
      ".java", ".kt", ".c", ".h", ".cpp", ".cs", ".m", ".mm",
    ]);
    const SKIP_DIRS = new Set([
      "node_modules", ".git", "dist", "build", "out", "__pycache__",
      ".next", ".nuxt", ".cache", "coverage", ".venv", "venv",
      "vendor", "target", "Pods", ".build", "DerivedData", ".gradle",
    ]);
    const MAX_BYTES = 500 * 1024; // 500KB

    const files: Array<{ path: string; content: string }> = [];
    let totalBytes = 0;

    const walk = async (dir: string): Promise<void> => {
      if (totalBytes >= MAX_BYTES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (totalBytes >= MAX_BYTES) return;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(fullPath);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          try {
            const s = await stat(fullPath);
            if (s.size > 100 * 1024) continue; // skip files > 100KB
            const content = await readFile(fullPath, "utf-8");
            const relativePath = fullPath.slice(workingDirectory.length + 1);
            files.push({ path: relativePath, content });
            totalBytes += content.length;
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    await walk(workingDirectory);

    return files
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");
  }

  /**
   * Compress conversation history for long-running agentic loops.
   * Keeps the first message (task description) and last 4 messages (recent context),
   * collapses middle messages to a compact summary of tool names and success/failure.
   */
  private compressHistory(
    messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
  ): Array<{ role: string; content: unknown; tool_calls?: unknown }> {
    if (messages.length <= 6) return messages;

    const first = messages[0];
    const last4 = messages.slice(-4);
    const middle = messages.slice(1, -4);

    // Build a compact summary of the middle messages
    const summaryParts: string[] = [];
    for (const msg of middle) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolNames = (msg.content as Array<{ type?: string; name?: string }>)
          .filter((b) => b.type === "tool_use")
          .map((b) => b.name ?? "unknown");
        if (toolNames.length > 0) {
          summaryParts.push(`tools: ${toolNames.join(", ")}`);
        }
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        const results = (msg.content as Array<{ type?: string; is_error?: boolean }>)
          .filter((b) => b.type === "tool_result");
        const errors = results.filter((r) => r.is_error).length;
        const ok = results.length - errors;
        if (results.length > 0) {
          summaryParts.push(`results: ${ok} ok, ${errors} errors`);
        }
      }
    }

    const summaryText = `[Compressed ${middle.length} messages: ${summaryParts.join(" | ")}]`;

    return [
      first,
      { role: "user", content: summaryText },
      ...last4,
    ];
  }

  /** Redact large/sensitive fields from tool input before emitting events. */
  private redactToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName === "write_file" && typeof input.content === "string") {
      return { ...input, content: `<${input.content.length} chars>` };
    }
    if (toolName === "run_command" && typeof input.command === "string" && input.command.length > 200) {
      return { ...input, command: input.command.slice(0, 200) + "..." };
    }
    return input;
  }

  /**
   * Redact secrets + size-bound tool output before it lands in
   * `tool:end.toolOutput` (and from there in failure postmortems and
   * the wedge telemetry stream). Mirrors redactToolInput on the
   * symmetric side. Three guarantees:
   *
   *   1. Tools that return file contents (Read, read_file) get their
   *      output replaced with a length marker. Operators can still see
   *      that the file was read; the postmortem doesn't carry a copy
   *      of `.env` or a credential JSON.
   *   2. Shell tools (run_command, Bash) get common secret patterns
   *      masked — sk-, Bearer ..., x-api-key=..., AKIA*, GitHub
   *      personal access tokens. Mirrors the redactSecrets in
   *      packages/worker-backends/src/claude-code.ts so both backends
   *      apply the same scrubbing.
   *   3. Output is capped per the caller's policy — 16KB on success,
   *      uncapped on failure — but the redaction runs FIRST, so even
   *      uncapped failure output is scrubbed before persistence.
   */
  private redactToolOutput(toolName: string, output: string): string {
    if (!output) return output;

    // Tools that pure-return file contents — substitute a length marker.
    // Whole-content tools are the highest-risk surface; anything else
    // gets pattern-level scrubbing in case it's an `ls` of /etc or a
    // ripgrep that bumped into a key file.
    if (FILE_CONTENT_TOOLS.has(toolName)) {
      return `<file content, ${output.length} chars (redacted)>`;
    }

    return output
      .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-***")
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
      .replace(/AKIA[0-9A-Z]{16}/g, "AKIA***")
      .replace(/gh[ps]_[A-Za-z0-9_]{36,}/g, "ghX_***")
      .replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]{20,}/gi, "$1***")
      .replace(/(x-api-key[=: ]+["']?)[A-Za-z0-9_-]{20,}/gi, "$1***")
      .replace(/(?<=key[=:" ]+["']?)[a-zA-Z0-9_-]{20,}/gi, "***");
  }

  private resolveApiKey(): string {
    if (this.config.apiKey) return this.config.apiKey;

    const envVars: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
    };

    const envVar = envVars[this.config.provider];
    const key = envVar ? process.env[envVar] : undefined;

    if (!key) {
      throw new Error(
        `No API key provided. Set config.apiKey or the ${envVar} environment variable.`,
      );
    }

    return key;
  }

  /**
   * Returns the cached routes and budget configs from Substrate.
   * Replaces the former getManifest() — there is no single swarm.json manifest
   * anymore; routes and config are Substrate entities.
   */
  async getManifest(): Promise<{ routes: import("@mnmal-ai/swarm-types").Route[]; budgetConfigs: Array<{ key: string; value: string; category: string }> }> {
    return this.router.load();
  }

  /**
   * Returns the configured primary backend type (e.g. "api" or "claude-code").
   * Note: this reflects the static configuration, not the runtime backend —
   * if a fallback was used during execution, this still returns the primary type.
   */
  getConfiguredBackendType(): WorkerBackendType {
    return this.config.workerBackend?.type ?? "api";
  }

  private getSwarmCommitSha(): string {
    return readGitHeadSha(this.config.swarmPath);
  }
}

/**
 * Pure helper: resolve maxTurns cap and whether pre-read should fire,
 * based on intent and pre-read content availability.
 * Exported so tests can validate the real logic.
 */
export function resolvePreReadConfig(
  intent: string,
  hasPreReadContent: boolean,
  userMaxTurns?: number,
): { maxTurns: number; preReadApplied: boolean } {
  const isInvestigation = intent === "investigation";
  const isOrchestration = intent === "orchestration";
  let maxTurns = userMaxTurns ?? 50;
  let preReadApplied = false;

  if (isInvestigation || isOrchestration) {
    if (hasPreReadContent) {
      preReadApplied = true;
      // Pre-read content reduces the need for file-reading tool calls,
      // but don't cap below the user's configured maxTurns — MCP tasks
      // and other multi-step workflows need their full turn allowance.
      if (!userMaxTurns) {
        // Only apply default caps when the user hasn't set a preference
        if (isInvestigation) {
          maxTurns = Math.min(maxTurns, 25);
        } else {
          maxTurns = Math.min(maxTurns, 10);
        }
      }
    } else if (!userMaxTurns) {
      maxTurns = Math.min(maxTurns, 20);
    }
  }

  return { maxTurns, preReadApplied };
}

/**
 * The files that hold a project's binding rules: swarm's core rules, which
 * workers always load as a required tier, and the project's constraints file.
 * The reviewer and the arbiter get them in full, whatever the route or budget.
 */
export function bindingRulePaths(project: string | undefined): string[] {
  return ["core/rules.md", ...(project ? [`domains/${project}/constraints.md`] : [])];
}

/**
 * The rule files context.rules delivers: the binding rules, then any files
 * the project adds, each once.
 */
export function ruleFilePaths(project: string | undefined, extra: readonly string[] = []): string[] {
  return [...new Set([...bindingRulePaths(project), ...extra])];
}

/** Unknown rule markers already warned about, so each is reported once per process. */
const warnedRuleMarkers = new Set<string>();

/** The rules block a session gets, with what built it. */
interface RulesDelivery {
  files: RuleFile[];
  plan: RulePlan;
  block: string;
  record: RulesRecord;
}

/** Binding-rule files as one block, each under its path; empty when there are none. */
export function formatBindingRules(files: Array<{ path: string; content: string }>): string {
  return files
    .filter((f) => f.content.trim() !== "")
    .map((f) => `--- ${f.path} ---\n${f.content.trim()}`)
    .join("\n\n");
}

/**
 * Pure helper: select and format swarm files for the Reviewer.
 * Includes mode, domain, and oversight tiers, less any file the reviewer
 * already gets in full as a binding rule (`deliveredAsRules`, the paths
 * loadByPaths actually returned), so nothing is sent twice and nothing is
 * lost when the rules can't be read. Exported so tests validate the real logic.
 */
export function selectReviewerFiles(
  files: Array<{ path: string; tier: string; content: string }>,
  deliveredAsRules: readonly string[] = [],
): string {
  const reviewerTiers = new Set(["mode", "domain", "oversight"]);
  const asRules = new Set(deliveredAsRules);
  const reviewerFiles = files.filter((f) => reviewerTiers.has(f.tier) && !asRules.has(f.path));
  return reviewerFiles
    .map((f) => `--- ${f.path} (${f.tier}) ---\n${f.content}`)
    .join("\n\n");
}
