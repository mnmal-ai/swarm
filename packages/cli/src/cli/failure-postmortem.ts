// Failure postmortem recorder.
//
// On task failure (wedge OR oversight rejection OR arbiter escalation),
// the orchestrator runs out of structured signal at exactly the moment
// it needs more: the retry decision happens with only the failure event
// payload, the task's history is in tasks.json (but the per-turn detail
// is not), and the worker session transcripts live in scattered jsonl
// files.
//
// This module subscribes to the live event bus and maintains tight ring
// buffers of recent tool calls + transcript turns + task verdicts,
// keyed by taskId/sessionId. When a failure event fires, it assembles a
// structured postmortem and persists it as a `FailurePostmortem` Substrate
// entity (per AGENTS.md / CLAUDE.md, telemetry events are store entities,
// not append-only JSONL files). Consumers (the
// dashboard's `failureReason` chip, the future Stage 2 diagnosis
// routine, swarm operators triaging by hand) read via the standard
// Substrate `getFailurePostmortem` / `listFailurePostmortems` queries.
//
// When no Substrate client is provided (e.g., unit tests in isolation, or
// run modes that intentionally skip Substrate), the recorder is a no-op for
// the persistence side but continues to maintain ring buffers and emit
// the `task:postmortem_written` event — the dashboard still gets a
// signal, just without a queryable entity to dereference.
//
// SCOPE (Stage 1): data plane only. No decision logic — the recorder
// captures evidence, period. Whether to retry, decompose, escalate to
// arbiter, or escalate to human is the Stage 2 follow-up (`on_task_
// failed` orchestrator hook that consumes these Substrate entities).

import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import type {
  ActiveToolSnapshot,
  ISwarmEventBus,
  TaskStartEvent,
  TaskToolWedgedEvent,
  TaskVerdictEvent,
  TokenBreakdown,
  ToolEndEvent,
  ToolStartEvent,
  TranscriptEntry,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Public types — the artifact schema
// ---------------------------------------------------------------------------

/** Stable failure category enum. Used by the Stage 2 diagnosis routine
 *  to cluster failures across tasks (`Systemic failure detected: all 3
 *  failed task(s) have the same failure category`). Open-set so future
 *  categories can be added without consumer breakage. */
export type FailureCategory =
  | "tool_wedge"
  | "oversight_rejected"
  | "token_limit_exceeded"
  | "turn_limit_exceeded"
  | "session_timeout"
  | "task_aborted"
  | "empty_output"
  | "unknown";

export interface CapturedToolCall {
  toolUseId: string;
  toolName: string;
  /** Full input (no truncation). Sourced from `tool:start.toolInput`. */
  toolInput: Record<string, unknown> | null;
  startedAt: number;
  /** ms-since-epoch of completion, or null if still in flight (e.g.,
   *  captured at wedge time before tool:end fired). */
  endedAt: number | null;
  /** Duration when ended, else null. */
  durationMs: number | null;
  /** Final outcome: `ok` / `error` / `in_flight` (at wedge). */
  outcome: "ok" | "error" | "in_flight";
  /** Tool output. 16KB cap on success, full on failure — same policy as
   *  ToolEndEvent. `null` for in-flight calls. */
  toolOutput: string | null;
  /** True when `toolOutput` was truncated. */
  toolOutputTruncated: boolean;
}

export interface CapturedTranscriptTurn {
  sessionId: string;
  role: string;
  promptHead: string;
  responseHead: string;
  /** Both head fields are capped at 4KB regardless of failure mode to
   *  bound the artifact size — full transcripts live in the
   *  per-session jsonl files under `~/.claude/projects/`. */
  promptTruncated: boolean;
  responseTruncated: boolean;
  tokens: number | null;
  timestamp: number;
}

export interface CapturedTaskVerdict {
  verdict: string;
  /** The task's tokens: fresh input, cache reads, cache writes, output. */
  tokens: TokenBreakdown | null;
  latencyMs: number;
  retryCount: number;
  arbiterInvolved: boolean;
  failureReason: string | null;
  timestamp: number;
}

export interface LineageNode {
  taskId: string;
  intent: string | null;
  description: string | null;
  parentTaskId: string | null;
}

export interface FailurePostmortem {
  /** Schema version — bumps when fields are removed/renamed (not added). */
  schemaVersion: 1;
  runId: string;
  taskId: string;
  goalId: string | null;
  failureCategory: FailureCategory;
  /** Wall-clock when the postmortem was assembled. */
  writtenAt: number;
  /** The failure event payload, verbatim, for whichever event triggered
   *  this postmortem (TaskToolWedgedEvent for wedges, TaskVerdictEvent
   *  for oversight rejections, etc.). */
  failureEvent: Record<string, unknown>;
  /** Most-recent N (default 10) tool calls observed for this task,
   *  oldest-first. Includes in-flight calls if the wedge fired before
   *  they completed. */
  recentToolCalls: CapturedToolCall[];
  /** Most-recent K (default 3) worker transcript turns, oldest-first. */
  recentTranscriptTurns: CapturedTranscriptTurn[];
  /** Most-recent task verdict (oversight outcome) for this taskId, or
   *  null if none observed yet. */
  taskVerdict: CapturedTaskVerdict | null;
  /** Snapshot of in-flight tools at the moment the wedge fired. Empty
   *  for non-wedge failures. */
  activeToolsAtFailure: ActiveToolSnapshot[];
  /** Decomposition lineage walked from this task up to its root,
   *  oldest-ancestor-first. The first element is the root task. */
  lineage: LineageNode[];
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Resolves a task's decomposition lineage. The recorder doesn't own
 * the task store, so the caller injects this. Should return the chain
 * walked from root → leaf, oldest-ancestor-first. Return `[{ taskId }]`
 * for tasks with no parent (top-level). Async because the local task
 * backend reads from disk.
 */
export type TaskLineageResolver = (taskId: string) => Promise<LineageNode[]>;

/**
 * Resolves a task's goalId. Injected for the same reason as
 * TaskLineageResolver — recorder doesn't read tasks.json directly.
 */
export type TaskGoalResolver = (taskId: string) => Promise<string | null>;

export interface FailurePostmortemOptions {
  runId: string;
  eventBus: ISwarmEventBus;
  /** Substrate client for persisting `FailurePostmortem` entities. When
   *  omitted (e.g., run mode that intentionally skips Substrate, or tests
   *  in isolation), the recorder still maintains ring buffers and
   *  emits `task:postmortem_written`, but skips persistence. */
  substrateClient?: SubstrateClient;
  resolveLineage: TaskLineageResolver;
  resolveGoalId: TaskGoalResolver;
  /** Max recent tool calls captured per task. Default 10. */
  toolRingSize?: number;
  /** Max recent transcript turns captured per task. Default 3. */
  transcriptRingSize?: number;
}

const DEFAULT_TOOL_RING_SIZE = 10;
const DEFAULT_TRANSCRIPT_RING_SIZE = 3;
const TRANSCRIPT_HEAD_CAP = 4 * 1024;

export class FailurePostmortemRecorder {
  private readonly runId: string;
  private readonly eventBus: ISwarmEventBus;
  private readonly substrateClient: SubstrateClient | undefined;
  private readonly resolveLineage: TaskLineageResolver;
  private readonly resolveGoalId: TaskGoalResolver;
  private readonly toolRingSize: number;
  private readonly transcriptRingSize: number;

  /** taskId → ordered ring of recent tool calls. */
  private readonly toolBuffers = new Map<string, CapturedToolCall[]>();
  /** toolUseId → the partial CapturedToolCall populated by tool:start,
   *  awaiting tool:end. Used to merge end-event data (output, duration)
   *  into the buffered entry. */
  private readonly pendingTools = new Map<string, CapturedToolCall>();
  /** taskId → ordered ring of recent transcript turns. */
  private readonly transcriptBuffers = new Map<string, CapturedTranscriptTurn[]>();
  /** taskId → most recent verdict observed. */
  private readonly latestVerdicts = new Map<string, CapturedTaskVerdict>();
  /** Currently-active taskId for transcript attribution. transcript
   *  events don't carry a taskId; we infer from the most recent
   *  task:start that hasn't yet seen a task:verdict. */
  private activeTaskId: string | null = null;

  // Bound handlers — kept on the instance so stop() can unsubscribe
  // exactly what start() subscribed.
  private readonly handlers: Array<{ event: string; fn: (e: unknown) => void }> = [];

  constructor(opts: FailurePostmortemOptions) {
    this.runId = opts.runId;
    this.eventBus = opts.eventBus;
    this.substrateClient = opts.substrateClient;
    this.resolveLineage = opts.resolveLineage;
    this.resolveGoalId = opts.resolveGoalId;
    this.toolRingSize = opts.toolRingSize ?? DEFAULT_TOOL_RING_SIZE;
    this.transcriptRingSize = opts.transcriptRingSize ?? DEFAULT_TRANSCRIPT_RING_SIZE;
  }

  start(): void {
    const onTaskStart = (e: TaskStartEvent) => {
      this.activeTaskId = e.taskId;
      // Don't pre-allocate buffers — let them spring into existence on
      // first observed event. Empty buffers are fine.
    };
    const onToolStart = (e: ToolStartEvent) => {
      const taskId = e.taskId ?? this.activeTaskId;
      if (!taskId) return;
      const entry: CapturedToolCall = {
        toolUseId: e.toolUseId ?? "",
        toolName: e.toolName,
        toolInput: (e.toolInput ?? null) as Record<string, unknown> | null,
        startedAt: e.timestamp,
        endedAt: null,
        durationMs: null,
        outcome: "in_flight",
        toolOutput: null,
        toolOutputTruncated: false,
      };
      this.appendToolCall(taskId, entry);
      if (entry.toolUseId) this.pendingTools.set(entry.toolUseId, entry);
    };
    const onToolEnd = (e: ToolEndEvent) => {
      const id = e.toolUseId ?? "";
      const pending = id ? this.pendingTools.get(id) : null;
      if (!pending) return;
      pending.endedAt = e.timestamp;
      pending.durationMs = e.durationMs;
      pending.outcome = e.isError ? "error" : "ok";
      pending.toolOutput = e.toolOutput ?? null;
      pending.toolOutputTruncated = e.toolOutputTruncated ?? false;
      this.pendingTools.delete(id);
    };
    const onTranscript = (e: TranscriptEntry) => {
      // TranscriptEntry carries an optional taskId. When present, use it
      // directly; otherwise fall back to the active task heuristic
      // (last task:start hasn't seen its verdict yet).
      const taskId = e.taskId ?? this.activeTaskId;
      if (!taskId) return;
      const promptHead = (e.prompt ?? "").slice(0, TRANSCRIPT_HEAD_CAP);
      const responseHead = (e.response ?? "").slice(0, TRANSCRIPT_HEAD_CAP);
      // TranscriptEntry.timestamp is an ISO string; parse to epoch ms
      // for uniform handling with the rest of the postmortem schema.
      const parsedTs = Date.parse(e.timestamp);
      const captured: CapturedTranscriptTurn = {
        sessionId: e.sessionId,
        role: e.role,
        promptHead,
        responseHead,
        promptTruncated: (e.prompt ?? "").length > TRANSCRIPT_HEAD_CAP,
        responseTruncated: (e.response ?? "").length > TRANSCRIPT_HEAD_CAP,
        tokens: typeof e.tokens === "number" ? e.tokens : null,
        timestamp: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
      };
      this.appendTranscript(taskId, captured);
    };
    const onVerdict = (e: TaskVerdictEvent) => {
      this.latestVerdicts.set(e.taskId, {
        verdict: e.verdict,
        tokens: e.tokens ?? null,
        latencyMs: e.latencyMs,
        retryCount: e.retryCount,
        arbiterInvolved: e.arbiterInvolved ?? false,
        failureReason: e.failureReason ?? null,
        timestamp: e.timestamp,
      });
      // If this verdict is a rejection, fire a postmortem write — but
      // fire-and-forget so the dispatcher isn't blocked on disk I/O.
      if (isRejectedVerdict(e.verdict)) {
        void this.writePostmortem(e.taskId, "oversight_rejected", {
          ...(e as unknown as Record<string, unknown>),
        });
      }
    };
    const onWedge = (e: TaskToolWedgedEvent) => {
      void this.writePostmortem(e.taskId, "tool_wedge", {
        ...(e as unknown as Record<string, unknown>),
      });
    };

    // Claude Code backend emits `backend:progress` with type=tool_call
    // / tool_summary INSTEAD of tool:start/tool:end (the API backend is
    // the only one emitting those today — see audit notes in the PR
    // body). Synthesize CapturedToolCall entries from the progress
    // stream so the postmortem's `recentToolCalls` is populated in
    // both modes. Synthesized entries lack `toolOutput` because
    // Claude Code SDK doesn't echo tool results to swarm — the model
    // consumes them internally — so those rows show `toolOutput:
    // null` and `outcome: "in_flight"` even after the call completes.
    // That's accurate: swarm genuinely doesn't see the output.
    const onBackendProgress = (e: { type: string; timestamp: number; meta?: Record<string, unknown> }) => {
      const taskId = this.activeTaskId;
      if (!taskId) return;
      if (e.type === "tool_call") {
        const meta = e.meta ?? {};
        const names = Array.isArray(meta.tools) ? (meta.tools as unknown[]) : [];
        const ids = Array.isArray(meta.toolUseIds) ? (meta.toolUseIds as unknown[]) : [];
        const inputs = Array.isArray(meta.inputs) ? (meta.inputs as unknown[]) : [];
        const count = typeof meta.count === "number" ? meta.count : names.length;
        for (let i = 0; i < count; i++) {
          const entry: CapturedToolCall = {
            toolUseId: typeof ids[i] === "string" ? (ids[i] as string) : "",
            toolName: typeof names[i] === "string" ? (names[i] as string) : "unknown",
            // Claude Code progress events carry truncated input
            // previews, not the full input — capture what's there.
            toolInput:
              typeof inputs[i] === "object" && inputs[i] !== null
                ? (inputs[i] as Record<string, unknown>)
                : null,
            startedAt: e.timestamp,
            endedAt: null,
            durationMs: null,
            outcome: "in_flight",
            toolOutput: null,
            toolOutputTruncated: false,
          };
          this.appendToolCall(taskId, entry);
          if (entry.toolUseId) this.pendingTools.set(entry.toolUseId, entry);
        }
      } else if (e.type === "tool_summary") {
        // Claude Code's tool_summary doesn't carry a tool_use_id. We
        // can't match it back to a specific pending entry, so leave
        // the synthesized rows as-is — the wedge snapshot uses
        // session age, not per-call duration, so the loss is
        // bounded. See pendingTools comment for FIFO heuristic.
      }
    };

    this.subscribe("task:start", onTaskStart as (e: unknown) => void);
    this.subscribe("tool:start", onToolStart as (e: unknown) => void);
    this.subscribe("tool:end", onToolEnd as (e: unknown) => void);
    this.subscribe("backend:progress", onBackendProgress as (e: unknown) => void);
    this.subscribe("transcript", onTranscript as (e: unknown) => void);
    this.subscribe("task:verdict", onVerdict as (e: unknown) => void);
    this.subscribe("task:tool_wedged", onWedge as (e: unknown) => void);
  }

  stop(): void {
    for (const { event, fn } of this.handlers) {
      // SwarmEventBus's `off` accepts (event, listener); the cast
      // matches the subscribe-side cast.
      (this.eventBus as unknown as { off: (event: string, fn: (e: unknown) => void) => void }).off(
        event,
        fn,
      );
    }
    this.handlers.length = 0;
    this.toolBuffers.clear();
    this.pendingTools.clear();
    this.transcriptBuffers.clear();
    this.latestVerdicts.clear();
    this.activeTaskId = null;
  }

  private subscribe(event: string, fn: (e: unknown) => void): void {
    // Cast through unknown — SwarmEventMap is heavily typed but the
    // recorder is a generic subscriber that handles erased event types.
    (this.eventBus as unknown as { on: (event: string, fn: (e: unknown) => void) => void }).on(
      event,
      fn,
    );
    this.handlers.push({ event, fn });
  }

  private appendToolCall(taskId: string, entry: CapturedToolCall): void {
    const buf = this.toolBuffers.get(taskId) ?? [];
    buf.push(entry);
    while (buf.length > this.toolRingSize) buf.shift();
    this.toolBuffers.set(taskId, buf);
  }

  private appendTranscript(taskId: string, entry: CapturedTranscriptTurn): void {
    const buf = this.transcriptBuffers.get(taskId) ?? [];
    buf.push(entry);
    while (buf.length > this.transcriptRingSize) buf.shift();
    this.transcriptBuffers.set(taskId, buf);
  }

  /**
   * Assemble + write the postmortem JSON. Fire-and-forget from the
   * event handlers; errors are swallowed (and printed to stderr) so a
   * disk hiccup never crashes the orchestrator's failure path.
   */
  private async writePostmortem(
    taskId: string,
    category: FailureCategory,
    failureEvent: Record<string, unknown>,
  ): Promise<void> {
    try {
      const recentToolCalls = (this.toolBuffers.get(taskId) ?? []).slice();
      const recentTranscriptTurns = (this.transcriptBuffers.get(taskId) ?? []).slice();
      const taskVerdict = this.latestVerdicts.get(taskId) ?? null;
      const lineage = await safeResolveAsync(this.resolveLineage, taskId, [
        { taskId, intent: null, description: null, parentTaskId: null },
      ]);
      const goalId = await safeResolveAsync(this.resolveGoalId, taskId, null);

      const activeToolsAtFailure =
        category === "tool_wedge" && Array.isArray(failureEvent.activeTools)
          ? (failureEvent.activeTools as ActiveToolSnapshot[])
          : [];

      const writtenAt = Date.now();
      let postmortemId = "";

      // Persist to Substrate when a client is available. Composite payloads
      // are JSON-serialized into string fields per the entity definition
      // in packages/substrate-plugin/src/types/swarm-types.ts. The CLI prints raw verdicts to
      // the terminal but Substrate is the durable source of truth for the
      // Stage 2 diagnosis routine.
      if (this.substrateClient) {
        const result = await this.substrateClient.mutate<{ id: string }>(
          "createFailurePostmortem",
          {
            runId: this.runId,
            taskId,
            goalId: goalId ?? null,
            failureCategory: category,
            schemaVersion: 1,
            writtenAt: new Date(writtenAt).toISOString(),
            failureEvent: JSON.stringify(failureEvent),
            recentToolCalls: JSON.stringify(recentToolCalls),
            recentTranscriptTurns: JSON.stringify(recentTranscriptTurns),
            taskVerdict: taskVerdict ? JSON.stringify(taskVerdict) : null,
            activeToolsAtFailure: JSON.stringify(activeToolsAtFailure),
            lineage: JSON.stringify(lineage),
          },
          { id: true },
        );
        postmortemId = result?.id ?? "";
      }

      this.eventBus.emit("task:postmortem_written", {
        taskId,
        postmortemId,
        failureCategory: category,
        toolCallsCaptured: recentToolCalls.length,
        transcriptTurnsCaptured: recentTranscriptTurns.length,
        timestamp: writtenAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Postmortem writer must never crash the dispatcher. Stderr
      // surfaces the issue without affecting the run.
      process.stderr.write(
        `[postmortem] failed to persist artifact for ${taskId}: ${msg}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRejectedVerdict(verdict: string): boolean {
  // Swarm's canonical verdict enum from packages/oversight/src/index.ts
  // is `"approved" | "rejected" | "escalate"`. `escalate` marks
  // arbiter handoff — the human-escalation path documented in
  // packages/oversight/src/index.ts:697 (`humanEscalation: arbiterResult.
  // verdict === "escalate"`). From the postmortem's perspective every
  // non-approval is a failure event, so invert the check: write a
  // postmortem unless the verdict is `approved`. `fail` / `failed` are
  // kept as legacy aliases for older event producers; they were never
  // canonical but appeared in some older paths.
  const v = verdict.toLowerCase();
  if (v === "approved") return false;
  return v === "rejected" || v === "escalate" || v === "fail" || v === "failed";
}

async function safeResolveAsync<T>(
  fn: ((id: string) => Promise<T>) | undefined,
  id: string,
  fallback: T,
): Promise<T> {
  try {
    if (!fn) return fallback;
    const out = await fn(id);
    return out ?? fallback;
  } catch {
    return fallback;
  }
}
