import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SwarmEvent, ContextRecord, FnlCoverage, OversightEvent, TranscriptEntry } from "@mnmal-ai/swarm-types";
import type {
  SubstrateClient,
  SessionEventInput,
  TranscriptEntryInput,
  TaskTelemetryBuffer,
} from "@mnmal-ai/swarm-substrate";
import { scrubContent } from "./scrub.js";

export class Telemetry {
  private outputPath: string;
  private enabled: boolean;
  private eventCounter = 0;
  private runId: string | undefined;
  private substrateClient?: SubstrateClient;
  private taskBuffer?: TaskTelemetryBuffer;

  constructor(outputPath: string, enabled = true, substrateClient?: SubstrateClient) {
    this.outputPath = outputPath;
    this.enabled = enabled;
    this.substrateClient = substrateClient;
  }

  /**
   * Set a run ID that will be stamped on every emitted event.
   */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  /**
   * Attach (or detach with `undefined`) a per-task buffer. While a buffer is
   * attached, `emitEvent` and `emitTranscript` accumulate their row into it
   * instead of writing immediately, so the coordinator can flush the whole task
   * atomically via `persistTaskTelemetry`. Detaching restores the immediate
   * per-row (Substrate) / JSONL behavior — the only behavior tests exercise when no
   * buffer is set. The coordinator owns the buffer lifecycle (one per task).
   */
  setTaskBuffer(buffer?: TaskTelemetryBuffer): void {
    this.taskBuffer = buffer;
  }

  /**
   * Generate a unique event ID.
   */
  generateEventId(): string {
    this.eventCounter++;
    const date = new Date().toISOString().slice(0, 10);
    // Include a 4-char random suffix to ensure uniqueness across Swarm
    // instances (e.g. when the orchestrator creates fresh instances per goal)
    const suffix = randomUUID().slice(0, 8);
    return `evt-${date}-${String(this.eventCounter).padStart(4, "0")}-${suffix}`;
  }

  /**
   * Fire-and-forget Substrate mutation. If the client is not configured or
   * the mutation fails, log a warning but never block telemetry emission.
   */
  private async substrateMutate<T>(
    mutationName: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.substrateClient) return null;
    try {
      return await this.substrateClient.mutate<T>(mutationName, params, { id: true });
    } catch (err) {
      console.warn(
        `[swarm] Substrate ${mutationName} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Emit a SwarmEvent.
   *
   * When a SubstrateClient is available, creates a SessionEvent entity via Substrate
   * and skips the JSONL write. Otherwise falls back to appending to the daily
   * JSONL file.
   */
  async emitEvent(event: SwarmEvent): Promise<void> {
    if (!this.enabled) return;

    // Buffered mode: stash the SessionEvent for the atomic task flush instead of
    // writing it now. The coordinator persists it via persistTaskTelemetry.
    if (this.taskBuffer) {
      this.taskBuffer.setSessionEvent(toSessionEventInput(event));
      return;
    }

    if (this.substrateClient) {
      await this.substrateMutate("createSessionEvent", toSessionEventFields(event));
      return;
    }

    await this.appendToDaily(event);
  }

  /**
   * Emit an OversightEvent to the daily JSONL file.
   */
  async emitOversightEvent(event: OversightEvent): Promise<void> {
    if (!this.enabled) return;
    await this.appendToDaily(event);
  }

  /**
   * Build a SwarmEvent from execution data.
   */
  buildEvent(params: {
    sessionId: string;
    role: SwarmEvent["role"];
    provider: string;
    modelId: string;
    swarmCommitSha: string;
    swarmTag?: string;
    intent: string;
    filesLoaded: string[];
    contextTokensUsed: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    inputSummary?: string;
    outputSummary?: string;
    authorId?: string;
    context?: ContextRecord;
    /** How the session's Bash commands fared with fnl, when it counted them. */
    fnlCoverage?: FnlCoverage;
  }): SwarmEvent {
    return {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      session_id: params.sessionId,
      role: params.role,
      model: { provider: params.provider, model_id: params.modelId },
      swarm_version: {
        commit_sha: params.swarmCommitSha,
        tag: params.swarmTag,
      },
      intent: params.intent,
      swarm_files_loaded: params.filesLoaded,
      context_tokens_used: params.contextTokensUsed,
      tokens: { input: params.inputTokens, output: params.outputTokens },
      latency_ms: params.latencyMs,
      input_summary: params.inputSummary,
      output_summary: params.outputSummary,
      authorId: params.authorId,
      ...(params.context ? { context_detail: params.context } : {}),
      ...(params.fnlCoverage ? { fnl_coverage: params.fnlCoverage } : {}),
    };
  }

  /**
   * Emit a generic event bus event to the daily JSONL file.
   */
  async emitGenericEvent(eventType: string, payload: unknown): Promise<void> {
    if (!this.enabled) return;
    await this.appendToDaily({
      _type: "bus_event",
      event: eventType,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  /** Write a transcript entry.
   *
   * When a SubstrateClient is available, creates a TranscriptEntry entity via
   * Substrate and skips the JSONL write. Otherwise falls back to appending to
   * the transcripts JSONL file (sibling of events/).
   */
  async emitTranscript(entry: TranscriptEntry): Promise<void> {
    if (!this.enabled) return;

    const MAX_TRANSCRIPT_CHARS = 500_000; // ~500 KB for ASCII content

    const scrubbedPrompt = scrubContent(entry.prompt);
    const scrubbedResponse = scrubContent(entry.response);

    const truncatedPrompt = scrubbedPrompt.length > MAX_TRANSCRIPT_CHARS
      ? scrubbedPrompt.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[truncated]"
      : scrubbedPrompt;
    const truncatedResponse = scrubbedResponse.length > MAX_TRANSCRIPT_CHARS
      ? scrubbedResponse.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[truncated]"
      : scrubbedResponse;

    // Buffered mode: stash the (scrubbed, truncated) TranscriptEntry for the
    // atomic task flush instead of writing it now.
    if (this.taskBuffer) {
      this.taskBuffer.setTranscript(
        toTranscriptEntryInput(entry, truncatedPrompt, truncatedResponse),
      );
      return;
    }

    if (this.substrateClient) {
      // prompt and response fields are marked indexed:false in the schema,
      // so no btree limit issue. Write directly.
      await this.substrateMutate(
        "createTranscriptEntry",
        toTranscriptEntryFields(entry, truncatedPrompt, truncatedResponse),
      );
      return;
    }

    const scrubbed = {
      ...entry,
      prompt: truncatedPrompt,
      response: truncatedResponse,
      runId: this.runId,
    };

    const date = new Date().toISOString().slice(0, 10);
    // Write to telemetry/transcripts/ (sibling of events/), not events/transcripts/
    const transcriptsDir = path.join(this.outputPath, "..", "transcripts");
    await fs.mkdir(transcriptsDir, { recursive: true });
    const filePath = path.join(transcriptsDir, `${date}.jsonl`);
    const line = JSON.stringify(scrubbed) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }

  /**
   * Append a JSON record to today's JSONL file.
   */
  private async appendToDaily(record: unknown): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.outputPath, `${date}.jsonl`);

    // Ensure directory exists
    await fs.mkdir(this.outputPath, { recursive: true });

    const stamped = this.runId
      ? { ...(record as Record<string, unknown>), runId: this.runId }
      : record;
    const line = JSON.stringify(stamped) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Row mappers (module-scoped pure functions)
//
// Two shapes per row, kept in lock-step:
//   - `*Fields`  → the params the autoCRUD `create<Type>` mutation is called
//     with (the immediate per-row path).
//   - `*Input`   → the typed SessionEventInput / TranscriptEntryInput the
//     buffered atomic path carries.
// Numeric fields are numbers in both: Substrate's `field.number()` refuses a
// string. Mapping both from the same source guarantees the buffered and
// per-row paths persist identical values.
// ---------------------------------------------------------------------------

/** `createSessionEvent` params — the per-row path. */
function toSessionEventFields(event: SwarmEvent): Record<string, unknown> {
  return {
    eventId: event.id,
    sessionId: event.session_id,
    role: event.role,
    provider: event.model?.provider ?? "",
    modelId: event.model?.model_id ?? "",
    intent: event.intent ?? "",
    swarmFilesLoaded: JSON.stringify(event.swarm_files_loaded ?? []),
    contextTokensUsed: event.context_tokens_used ?? 0,
    inputTokens: event.tokens?.input ?? 0,
    outputTokens: event.tokens?.output ?? 0,
    latencyMs: event.latency_ms ?? 0,
    timestamp: event.timestamp,
    ...contextDetailField(event),
    ...fnlCoverageField(event),
  };
}

/**
 * The session's context record as the SessionEvent's `contextDetail` JSON, or
 * nothing when the session loaded no swarm context (so the row, and a sidecar
 * older than the field, sees no new key).
 */
function contextDetailField(event: SwarmEvent): { contextDetail?: string } {
  return event.context_detail ? { contextDetail: JSON.stringify(event.context_detail) } : {};
}

/**
 * The session's fnl coverage as the SessionEvent's `fnlCoverage` JSON, or
 * nothing when the session didn't count it (so an older sidecar sees no new
 * key from sessions without it).
 */
function fnlCoverageField(event: SwarmEvent): { fnlCoverage?: string } {
  return event.fnl_coverage ? { fnlCoverage: JSON.stringify(event.fnl_coverage) } : {};
}

/** Typed SessionEventInput — the buffered atomic path. */
function toSessionEventInput(event: SwarmEvent): SessionEventInput {
  return {
    eventId: event.id,
    sessionId: event.session_id,
    role: event.role,
    provider: event.model?.provider ?? "",
    modelId: event.model?.model_id ?? "",
    intent: event.intent ?? "",
    swarmFilesLoaded: JSON.stringify(event.swarm_files_loaded ?? []),
    contextTokensUsed: event.context_tokens_used ?? 0,
    inputTokens: event.tokens?.input ?? 0,
    outputTokens: event.tokens?.output ?? 0,
    latencyMs: event.latency_ms ?? 0,
    timestamp: event.timestamp,
    authorId: event.authorId,
    ...contextDetailField(event),
    ...fnlCoverageField(event),
  };
}

/** `createTranscriptEntry` params — the per-row path. */
function toTranscriptEntryFields(
  entry: TranscriptEntry,
  prompt: string,
  response: string,
): Record<string, unknown> {
  return {
    sessionId: entry.sessionId,
    role: entry.role,
    prompt,
    response,
    inputTokens: entry.tokens?.input ?? 0,
    outputTokens: entry.tokens?.output ?? 0,
    backend: entry.backend,
    timestamp: entry.timestamp,
    authorId: entry.authorId,
  };
}

/** Typed TranscriptEntryInput — the buffered atomic path. */
function toTranscriptEntryInput(
  entry: TranscriptEntry,
  prompt: string,
  response: string,
): TranscriptEntryInput {
  return {
    sessionId: entry.sessionId,
    role: entry.role,
    prompt,
    response,
    inputTokens: entry.tokens?.input ?? 0,
    outputTokens: entry.tokens?.output ?? 0,
    backend: entry.backend,
    timestamp: entry.timestamp,
    authorId: entry.authorId,
  };
}
