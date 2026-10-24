/**
 * TaskTelemetryBuffer — a per-task accumulator for the four primary telemetry
 * rows a task produces (the worker's SessionEvent + TranscriptEntry, the
 * WorkerResult, and the optional final ReviewVerdict).
 *
 * It exists so the telemetry and oversight subsystems can BUFFER their rows
 * instead of writing each immediately, letting the coordinator
 * (`packages/core/src/swarm.ts`) flush all of them in ONE atomic
 * `SwarmQueryClient.persistTaskTelemetry(...)` call at the task boundary.
 *
 * The buffer is the shared vocabulary between three packages that all depend
 * on `@mnmal-ai/swarm-substrate` (the resolver input types live in
 * `@mnmal-ai/swarm-substrate-shared`):
 *   - packages/telemetry  fills sessionEvent + transcript
 *   - packages/oversight  fills workerResult + reviewVerdict
 *   - packages/core       builds the request and flushes it
 *
 * It holds DATA only — no I/O, no client reference. The flush (atomic vs. the
 * per-row mutate / JSONL fallback) is the coordinator's job, so this stays
 * trivially testable and backend-neutral.
 */

import type {
  PersistTaskTelemetryRequest,
  ReviewVerdictInput,
  SessionEventInput,
  TranscriptEntryInput,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate-shared";

export class TaskTelemetryBuffer {
  sessionEvent?: SessionEventInput;
  transcript?: TranscriptEntryInput;
  workerResult?: WorkerResultInput;
  reviewVerdict?: ReviewVerdictInput;

  setSessionEvent(input: SessionEventInput): void {
    this.sessionEvent = input;
  }

  setTranscript(input: TranscriptEntryInput): void {
    this.transcript = input;
  }

  setWorkerResult(input: WorkerResultInput): void {
    this.workerResult = input;
  }

  /**
   * Last-write-wins: the atomic envelope carries one ReviewVerdict per task, so
   * a retry's verdict overwrites the previous one. The final verdict is the one
   * that represents the task outcome — which is what we want persisted.
   */
  setReviewVerdict(input: ReviewVerdictInput): void {
    this.reviewVerdict = input;
  }

  /**
   * True once the three non-optional rows the resolver requires are present —
   * i.e. the atomic envelope can be built. The coordinator checks this before
   * attempting an atomic flush (a task that produced no WorkerResult, e.g. one
   * whose review was skipped, never reaches the atomic path).
   */
  hasRequiredRows(): boolean {
    return Boolean(this.sessionEvent && this.transcript && this.workerResult);
  }

  /**
   * Build the atomic `persistTaskTelemetry` request. `reviewVerdict` is included
   * only when one was buffered. Throws when a required row is missing — callers
   * must gate on {@link hasRequiredRows} first.
   */
  toRequest(): PersistTaskTelemetryRequest {
    if (!this.sessionEvent || !this.transcript || !this.workerResult) {
      throw new Error(
        "TaskTelemetryBuffer.toRequest(): sessionEvent, transcript, and workerResult are all required",
      );
    }
    return {
      sessionEvent: this.sessionEvent,
      transcript: this.transcript,
      workerResult: this.workerResult,
      ...(this.reviewVerdict ? { reviewVerdict: this.reviewVerdict } : {}),
    };
  }
}
