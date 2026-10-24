// Tool-call wedge detection for in-flight worker subprocesses.
//
// The orchestrator's existing watchdog catches
// workers wedged at the dispatch-loop level — when no worker resolves
// within `workerHeartbeatMs` (default 30 min). The process-group cleanup
// reaps the worker's descendants on worker exit.
//
// Both fixes are correct AT WORKER EXIT. Neither catches a worker that is
// healthy at the process level but has had a single tool call hung for
// minutes — typically because the tool spawned a long-running subprocess
// (vercel dev, vite, drizzle-kit studio, watch-mode anything) whose
// ambient stdout output keeps Claude Code's bash-tool idle timer alive
// even though the actual user-meaningful work is hung. Swarm sees the
// worker as healthy (active tool call, recent telemetry) and waits the
// full 30 min before the heartbeat fires.
//
// This watcher consumes the ProgressEvent stream the worker backend
// already emits. It tracks how many tool calls are in flight for the
// task and how long since the active-tool-count went from 0 to positive
// (the start of a "tool activity session"). When the session exceeds
// `timeoutMs`, the watcher fires `onWedge` exactly once and stops itself.
// The caller wires `onWedge` to abort the task's AbortController, which
// (together with v0.28.6's process-group cleanup) reaps the worker
// subprocess and every descendant.
//
// SCOPE: this watcher is per-task. The caller is responsible for routing
// only this task's progress events to it. With the current
// `eventBus.emit("backend:progress", ...)` wiring shared across all
// workers, that means: usable as-is for `max_workers: 1`. For multi-
// worker setups, add taskId to ProgressEvent (or use a per-task
// interactionHandler) so events can be correlated. Out of scope here.

import type { ActiveToolSnapshot, ProgressEvent } from "@mnmal-ai/swarm-types";

export interface ToolWedgeWatcherOptions {
  /**
   * Progress-window threshold in ms. The wedge fires when BOTH:
   *   (a) activeToolCount > 0, AND
   *   (b) no model response or tool completion has arrived for this long.
   *
   * This replaces the old per-session-start elapsed check: the
   * relevant signal is "no progress", not "session started N ms ago".
   * A batch of 50 parallel tools that keeps completing throughout a 5-min
   * window is healthy; a batch where nothing completes for 5 min is stuck.
   *
   * Recommended default 5 min (300_000). Alias: `timeoutMs` (kept for
   * backward compat with callers constructed before this rename).
   */
  progressWindowMs?: number;
  /**
   * @deprecated Use `progressWindowMs`. Kept for backward compat — if
   * `progressWindowMs` is not set, this value is used as the threshold.
   */
  timeoutMs?: number;
  /** Polling interval in ms. Defaults to min(10s, progressWindowMs/6) so
   *  even short windows get at least 6 chances to fire before deadline. */
  pollIntervalMs?: number;
  /** Grace period (ms) after onWedge fires before the
   *  `forceRejectionPromise` rejects. Gives the cooperative
   *  `taskAbortController.abort()` a chance to actually settle the task
   *  promise. If the worker subprocess ignores the abort signal (a known
   *  failure mode for the claude-code SDK — same root cause that drove
   *  the workerHeartbeatMs watchdog), the force-rejection fires
   *  and unblocks the dispatch loop instead of waiting the full 30 min
   *  for the heartbeat to trip. Default 10_000 (10 s). */
  forceRejectionGraceMs?: number;
  /** Time source — overridable for tests. Defaults to `() => Date.now()`. */
  now?: () => number;
  /** Setters for the force-rejection scheduling — overridable for tests
   *  that need deterministic time. Defaults to the global setTimeout/
   *  clearTimeout. Production code should never set these. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface WedgeInfo {
  /** Number of tool calls in flight when the wedge fired. */
  activeCount: number;
  /** Wall-clock ms since the tool-activity session started. */
  elapsedMs: number;
  /**
   * Per-tool snapshot of what was in flight when the wedge fired,
   * sorted oldest-first. Empty when the caller never fed any
   * `tool_call` events with `meta.toolUseIds` (e.g., pre-fix backends
   * that only carried name + count). The caller forwards this onto
   * `TaskToolWedgedEvent.activeTools` so postmortem consumers can
   * identify which tool calls were stuck.
   */
  activeTools: ActiveToolSnapshot[];
}

interface InFlightTool {
  toolUseId: string;
  name: string;
  startedAt: number;
  inputPreview: string;
}

export class ToolWedgeWatcher {
  private activeCount = 0;
  /** Timestamp when activeCount went 0 → positive. 0 means no session.
   *  Kept for lifecycle management and the getSessionStart() accessor. */
  private sessionStart = 0;
  /**
   * Timestamp of the most recent model response. Updated whenever a
   * `model_response` event arrives while a tool session is in progress.
   * 0 when no session is active. Part of the progress-window signal.
   */
  private lastModelResponseAt = 0;
  /**
   * Timestamp of the most recent tool completion (tool_summary). Updated
   * on each completion as long as activeCount stays > 0. 0 when no
   * session is active. Part of the progress-window signal.
   */
  private lastToolCompletionAt = 0;
  /**
   * Ordered list of in-flight tool calls. Push on `tool_call`, shift
   * (FIFO) on `tool_summary` since the SDK's summary event does not
   * carry a `tool_use_id` we can match. FIFO is heuristic: when tools
   * complete out of order the snapshot can attribute the wrong start
   * time to a survivor. That's acceptable for wedge triage — the IDs
   * + names + input previews are still correct; only the per-tool
   * `ageMs` may be slightly off. `activeTools` in WedgeInfo is forensic;
   * it is NOT the wedge trigger (see tick()).
   */
  private inFlightTools: InFlightTool[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = false;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly progressWindowMs: number;

  // Force-rejection plumbing — see forceRejectionPromise() docstring.
  private readonly forceRejectionGraceMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private forceRejectionRejecter: ((err: Error) => void) | null = null;
  private forceRejectionTimerHandle: unknown = null;

  constructor(
    opts: ToolWedgeWatcherOptions,
    private readonly onWedge: (info: WedgeInfo) => void,
  ) {
    this.now = opts.now ?? Date.now;
    // progressWindowMs: new canonical name; timeoutMs is the backward-compat alias.
    this.progressWindowMs = opts.progressWindowMs ?? opts.timeoutMs ?? 300_000;
    // pollIntervalMs floor of 1s to avoid pathological busy-loops on
    // very short timeouts (e.g. tests with progressWindowMs=10ms — those
    // drive the tick() method directly).
    this.pollIntervalMs =
      opts.pollIntervalMs ??
      Math.max(1_000, Math.min(10_000, Math.floor(this.progressWindowMs / 6)));
    this.forceRejectionGraceMs = opts.forceRejectionGraceMs ?? 10_000;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /**
   * Returns a promise that REJECTS when (a) the wedge fires AND (b) the
   * configured grace period elapses. Use with `Promise.race` against the
   * actual task promise to guarantee the dispatch loop unblocks even
   * when the worker subprocess ignores `taskAbortController.abort()`.
   *
   * Lifecycle: the returned promise is created lazily so call this at
   * MOST ONCE per watcher instance. Calling stop() before the wedge
   * fires cancels the pending force-rejection timer (the promise stays
   * unresolved — the caller's Promise.race against the task promise
   * resolves naturally with the task's result).
   *
   * The leaked worker subprocess this protects against is NOT cleaned
   * up here; the existing 30 min workerHeartbeatMs watchdog reaps it
   * via the process-group cleanup at worker-record exit. A
   * dedicated targeted-kill follow-up is desirable but out of scope.
   */
  forceRejectionPromise(): Promise<never> {
    return new Promise<never>((_, reject) => {
      this.forceRejectionRejecter = reject;
    });
  }

  /** Start the watchdog timer. Idempotent. */
  start(): void {
    if (this.timer !== null || this.fired) return;
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  /** Stop the watchdog timer AND cancel any pending force-rejection
   *  timer. Idempotent. Always called from the task's finally block —
   *  wedge or no wedge, both timers must be cleared so a successful
   *  task doesn't leak a force-rejection that fires later against a
   *  no-longer-relevant promise. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.forceRejectionTimerHandle !== null) {
      this.clearTimeoutFn(this.forceRejectionTimerHandle);
      this.forceRejectionTimerHandle = null;
    }
    // Drop the rejecter reference so a stale onWedge doesn't reject
    // after stop(). The promise stays unresolved forever, which is fine
    // — the consumer always Promise.races it against the task promise,
    // and the task promise has resolved by the time stop() runs.
    this.forceRejectionRejecter = null;
  }

  /** Feed a progress event from the worker backend. Only `tool_call` and
   *  `tool_summary` events affect the active-count; other event types
   *  are ignored. Active-count is the authoritative wedge signal;
   *  `inFlightTools` is the best-effort per-tool snapshot used to
   *  populate `WedgeInfo.activeTools`.
   *
   *  `tool_call` payload shape (claude-code backend, see
   *  packages/worker-backends/src/claude-code.ts):
   *    meta: { tools: string[], count: number, inputs: [{tool, preview}],
   *            toolUseIds: string[] }
   *  Older payloads without `toolUseIds` still bump activeCount but
   *  contribute placeholder entries to inFlightTools so the snapshot
   *  size matches the count. `tool_summary` shifts the oldest entry —
   *  see InFlightTool docstring for the heuristic. */
  onProgress(event: ProgressEvent): void {
    if (this.fired) return;

    if (event.type === "tool_call") {
      const count = readPositiveInt(event.meta?.count, 1);
      const wasZero = this.activeCount === 0;
      this.activeCount += count;
      if (wasZero) {
        // New session: initialize both progress timestamps so the window
        // starts from now, not from some prior session's last event.
        const t = this.now();
        this.sessionStart = t;
        this.lastModelResponseAt = t;
        this.lastToolCompletionAt = t;
      }

      const meta = event.meta ?? {};
      const names = Array.isArray(meta.tools) ? (meta.tools as unknown[]) : [];
      const ids = Array.isArray(meta.toolUseIds) ? (meta.toolUseIds as unknown[]) : [];
      const inputs = Array.isArray(meta.inputs) ? (meta.inputs as unknown[]) : [];
      const startedAt = this.now();
      for (let i = 0; i < count; i++) {
        this.inFlightTools.push({
          toolUseId: typeof ids[i] === "string" ? (ids[i] as string) : "",
          name: typeof names[i] === "string" ? (names[i] as string) : "unknown",
          startedAt,
          inputPreview:
            typeof inputs[i] === "object" && inputs[i] !== null && "preview" in (inputs[i] as object)
              ? String((inputs[i] as { preview: unknown }).preview ?? "").slice(0, 120)
              : "",
        });
      }
    } else if (event.type === "tool_summary") {
      this.activeCount = Math.max(0, this.activeCount - 1);
      // FIFO removal: SDK's tool_summary event doesn't carry tool_use_id
      // so we approximate. See InFlightTool docstring.
      if (this.inFlightTools.length > 0) this.inFlightTools.shift();
      if (this.activeCount === 0) {
        // Session ended: reset all session-scoped state.
        this.sessionStart = 0;
        this.lastModelResponseAt = 0;
        this.lastToolCompletionAt = 0;
      } else {
        // Tools still in flight: record this completion as visible progress.
        this.lastToolCompletionAt = this.now();
      }
    } else if (event.type === "model_response") {
      // A model response means the worker is thinking and routing — visible
      // progress even if no individual tool call has completed yet.
      if (this.activeCount > 0) {
        this.lastModelResponseAt = this.now();
      }
    }
  }

  /**
   * Snapshot of in-flight tools, sorted oldest-first. Computed lazily
   * so callers (the wedge handler in particular) get the freshest
   * possible age values. Returns an empty array when no tools are
   * tracked.
   */
  snapshotActiveTools(): ActiveToolSnapshot[] {
    const now = this.now();
    return this.inFlightTools
      .slice()
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => ({
        toolUseId: t.toolUseId,
        name: t.name,
        startedAt: t.startedAt,
        ageMs: now - t.startedAt,
        inputPreview: t.inputPreview,
      }));
  }

  /** Exposed for tests so the watchdog logic can be exercised
   *  deterministically without waiting on real timers. Production code
   *  drives this via the `setInterval` started in `start()`. */
  tick(): void {
    if (this.fired) return;
    if (this.activeCount === 0) return;
    // Progress-window detection:
    // Fire only when BOTH active tools exist AND no model response or tool
    // completion has arrived within the progress window. This avoids the
    // false-positive class where a large parallel batch (50+ tools) keeps
    // completing throughout the window but the session's total elapsed time
    // exceeds the old per-session threshold.
    const lastProgressAt = Math.max(this.lastModelResponseAt, this.lastToolCompletionAt);
    const elapsedMs = this.now() - lastProgressAt;
    if (elapsedMs >= this.progressWindowMs) {
      this.fired = true;
      // NOTE: stop() clears the force-rejection rejecter — so we MUST
      // schedule the force-rejection timer BEFORE calling stop(), and
      // capture the rejecter into a local before stop() nulls it. The
      // poll-interval timer still gets cleared either way.
      const capturedRejecter = this.forceRejectionRejecter;
      const wedgeInfo: WedgeInfo = {
        activeCount: this.activeCount,
        elapsedMs, // ms since last model response or tool completion
        activeTools: this.snapshotActiveTools(),
      };
      const thresholdMs = this.progressWindowMs;
      const graceMs = this.forceRejectionGraceMs;

      // Clear the poll timer so the watcher's setInterval stops; null
      // out the rejecter so a late stop() doesn't double-cancel.
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.forceRejectionRejecter = null;

      // Schedule the force-rejection timer if the consumer ever called
      // forceRejectionPromise() (otherwise no rejecter to call).
      if (capturedRejecter) {
        this.forceRejectionTimerHandle = this.setTimeoutFn(() => {
          this.forceRejectionTimerHandle = null;
          capturedRejecter(
            new ToolWedgeForceRejectError({
              activeCount: wedgeInfo.activeCount,
              elapsedMs: wedgeInfo.elapsedMs,
              thresholdMs,
              graceMs,
            }),
          );
        }, graceMs);
      }

      try {
        this.onWedge(wedgeInfo);
      } catch {
        // The caller's onWedge must not be allowed to throw out of the
        // setInterval callback — that would crash the host process.
        // Swallow; the wedge has been recorded by `fired = true`.
      }
    }
  }

  /** Test/inspection accessor. */
  getActiveCount(): number {
    return this.activeCount;
  }

  /** Test/inspection accessor. */
  getSessionStart(): number {
    return this.sessionStart;
  }

  /** Test/inspection accessor — max(lastModelResponseAt, lastToolCompletionAt).
   *  0 when no session is active. */
  getLastProgressAt(): number {
    return Math.max(this.lastModelResponseAt, this.lastToolCompletionAt);
  }

  /** Test accessor — has the wedge already fired? */
  hasFired(): boolean {
    return this.fired;
  }
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Thrown when the wedge fires AND the cooperative
 * `taskAbortController.abort()` doesn't settle the underlying task
 * promise within the grace window. Caller catches this, marks the
 * task failed, and continues the dispatch loop. The leaked worker
 * subprocess is reaped by the existing 30 min workerHeartbeatMs
 * watchdog at most one heartbeat later.
 *
 * Distinct from the orchestrator's `WorkerWedgedError` which fires
 * for whole-loop wedges (no worker resolves within the heartbeat).
 * This is the per-task in-flight version.
 */
export class ToolWedgeForceRejectError extends Error {
  readonly activeCount: number;
  readonly elapsedMs: number;
  readonly thresholdMs: number;
  readonly graceMs: number;
  constructor(info: {
    activeCount: number;
    elapsedMs: number;
    thresholdMs: number;
    graceMs: number;
  }) {
    super(
      `Tool wedge force-reject: worker did not honor abort within ${info.graceMs}ms grace ` +
        `(${info.activeCount} tool(s) active for ${(info.elapsedMs / 1000).toFixed(0)}s, ` +
        `threshold ${(info.thresholdMs / 1000).toFixed(0)}s). Dispatch unblocked; ` +
        `worker subprocess leaks until next workerHeartbeatMs reap.`,
    );
    this.name = "ToolWedgeForceRejectError";
    this.activeCount = info.activeCount;
    this.elapsedMs = info.elapsedMs;
    this.thresholdMs = info.thresholdMs;
    this.graceMs = info.graceMs;
  }
}
