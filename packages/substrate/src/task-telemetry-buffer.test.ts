import { describe, it, expect } from "vitest";
import { TaskTelemetryBuffer } from "./task-telemetry-buffer.js";
import type {
  ReviewVerdictInput,
  SessionEventInput,
  TranscriptEntryInput,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate-shared";

const sessionEvent: SessionEventInput = {
  eventId: "evt-1",
  sessionId: "sess-1",
  role: "worker",
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  intent: "implementation",
  swarmFilesLoaded: "[]",
  contextTokensUsed: 100,
  inputTokens: 10,
  outputTokens: 20,
  latencyMs: 5,
  timestamp: "2026-05-30T00:00:00.000Z",
};

const transcript: TranscriptEntryInput = {
  sessionId: "sess-1",
  role: "worker",
  prompt: "p",
  response: "r",
  inputTokens: 10,
  outputTokens: 20,
  backend: "claude-code",
  timestamp: "2026-05-30T00:00:00.000Z",
};

const workerResult: WorkerResultInput = {
  sessionId: "sess-1",
  intent: "",
  output: "done",
  diff: "",
  filesModified: "[]",
  tokenUsage: 0,
  timestamp: "2026-05-30T00:00:00.000Z",
};

function verdict(v: string): ReviewVerdictInput {
  return {
    sessionId: "sess-1",
    workerResultId: "",
    verdict: v,
    reasons: "[]",
    suggestions: "[]",
    attempt: 0,
    timestamp: "2026-05-30T00:00:00.000Z",
  };
}

describe("TaskTelemetryBuffer", () => {
  it("is not flush-ready until the three required rows are present", () => {
    const buf = new TaskTelemetryBuffer();
    expect(buf.hasRequiredRows()).toBe(false);

    buf.setSessionEvent(sessionEvent);
    expect(buf.hasRequiredRows()).toBe(false);

    buf.setTranscript(transcript);
    expect(buf.hasRequiredRows()).toBe(false);

    buf.setWorkerResult(workerResult);
    expect(buf.hasRequiredRows()).toBe(true);
  });

  it("toRequest() builds the atomic envelope and omits an absent reviewVerdict", () => {
    const buf = new TaskTelemetryBuffer();
    buf.setSessionEvent(sessionEvent);
    buf.setTranscript(transcript);
    buf.setWorkerResult(workerResult);

    const req = buf.toRequest();
    expect(req.sessionEvent).toEqual(sessionEvent);
    expect(req.transcript).toEqual(transcript);
    expect(req.workerResult).toEqual(workerResult);
    expect("reviewVerdict" in req).toBe(false);
  });

  it("toRequest() includes the reviewVerdict when one was buffered", () => {
    const buf = new TaskTelemetryBuffer();
    buf.setSessionEvent(sessionEvent);
    buf.setTranscript(transcript);
    buf.setWorkerResult(workerResult);
    buf.setReviewVerdict(verdict("approved"));

    expect(buf.toRequest().reviewVerdict?.verdict).toBe("approved");
  });

  it("last-write-wins on the reviewVerdict so the final verdict is persisted", () => {
    const buf = new TaskTelemetryBuffer();
    buf.setSessionEvent(sessionEvent);
    buf.setTranscript(transcript);
    buf.setWorkerResult(workerResult);
    buf.setReviewVerdict(verdict("rejected")); // attempt 0
    buf.setReviewVerdict(verdict("approved")); // retry won

    expect(buf.toRequest().reviewVerdict?.verdict).toBe("approved");
  });

  it("toRequest() throws when a required row is missing", () => {
    const buf = new TaskTelemetryBuffer();
    buf.setSessionEvent(sessionEvent);
    expect(() => buf.toRequest()).toThrow(/required/);
  });
});
