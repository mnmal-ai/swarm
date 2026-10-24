import type { DocumentGuard, OversightResult, IWorkerBackend } from "./config.js";
import type { SwarmEvent, ContextRecord, OversightEvent } from "./telemetry.js";

/**
 * Base interface for all pluggable adapters in the swarm.
 * Provides a standardized lifecycle contract.
 */
export interface Adapter {
  /** Human-readable name for logs and diagnostics. */
  readonly name: string;
  /** Discriminant for type-safe switching. */
  readonly kind: string;
  /** Optional setup (connect, authenticate, warm caches). */
  init?(): Promise<void>;
  /** Is this adapter usable in the current environment? */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  /** Optional teardown (close connections, flush buffers). */
  dispose?(): Promise<void>;
}

export interface TelemetryAdapter extends Adapter {
  readonly kind: "telemetry";
  emit(event: SwarmEvent): Promise<void>;
  flush(): Promise<void>;
  /** Build a SwarmEvent from execution data. */
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
    /** Session author for telemetry attribution. Threaded onto the SwarmEvent
     *  so every persisted row carries it. Optional — undefined for callers that
     *  don't supply it. */
    authorId?: string;
    /** The session's context record (worker sessions that loaded swarm context). */
    context?: ContextRecord;
  }): SwarmEvent;
  /** Emit an OversightEvent to the telemetry store. */
  emitOversightEvent(event: OversightEvent): Promise<void>;
}

/**
 * Interface for the oversight subsystem, used by the Swarm class via DI.
 * Matches the actual Oversight.runFullChain signature.
 */
export interface OversightRunner {
  runFullChain(params: {
    modeContext: string;
    /** The project's binding rules (core rules and constraints), given to the
     *  reviewer and the arbiter in full ahead of everything else. */
    bindingRules?: string;
    /** The same rules delivered by index (context.rules, over budget), for a
     *  reviewer or arbiter on a direct-execution backend, which can read the
     *  indexed rules by line range; `bindingRules` everywhere else. */
    bindingRulesIndexed?: string;
    originalTask: string;
    workerOutput: string;
    maxRetries: number;
    sessionId: string;
    onRetry?: (reasons: string[], attempt: number) => Promise<string>;
    reviewerBackend?: IWorkerBackend;
    arbiterBackend?: IWorkerBackend;
    workingDirectory?: string;
    /** Session author, threaded onto the WorkerResult and ReviewVerdict rows
     *  the chain persists. Optional — undefined for callers that omit it. */
    authorId?: string;
    /** The worker's document index with the sections it read (context.pull),
     *  for a reviewer on a backend; "" when there is none. */
    documentIndex?: () => string;
    /** The worker's read guard, given to a reviewer on a backend. */
    documentGuard?: DocumentGuard;
  }): Promise<OversightResult>;
}
