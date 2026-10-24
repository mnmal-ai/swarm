import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Telemetry } from "../src/telemetry/index.js";
import { TaskTelemetryBuffer } from "@mnmal-ai/swarm-substrate";
import { mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SwarmEvent, TranscriptEntry } from "@mnmal-ai/swarm-types";

// Use a nested directory to avoid transcript sibling directory conflicts
// with other test suites sharing the __fixtures__ parent.
const TEMP_DIR = join(__dirname, "__fixtures__", "substrate-telem", "events");

// ---------------------------------------------------------------------------
// Mock SubstrateClient that records mutate() calls
// ---------------------------------------------------------------------------

interface MutateCall {
  mutationName: string;
  params: Record<string, unknown>;
  fields: Record<string, unknown>;
}

function createMockSubstrateClient() {
  const calls: MutateCall[] = [];
  return {
    calls,
    query: vi.fn(async () => []),
    mutate: vi.fn(async (mutationName: string, params: Record<string, unknown>, fields: Record<string, unknown>) => {
      calls.push({ mutationName, params, fields });
      return { id: calls.length };
    }),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSwarmEvent(telemetry: Telemetry, overrides?: Partial<SwarmEvent>): SwarmEvent {
  return {
    id: telemetry.generateEventId(),
    timestamp: "2026-04-01T12:00:00.000Z",
    session_id: "sess-substrate-test",
    role: "worker",
    model: { provider: "anthropic", model_id: "claude-sonnet-4-6" },
    swarm_version: { commit_sha: "abc123", tag: "v1.0.0" },
    intent: "implementation",
    swarm_files_loaded: ["core/values.md", "modes/implementation.md"],
    context_tokens_used: 3000,
    tokens: { input: 500, output: 200 },
    latency_ms: 1500,
    ...overrides,
  };
}

function makeTranscript(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    sessionId: "sess-substrate-test",
    role: "worker",
    timestamp: "2026-04-01T12:00:00.000Z",
    prompt: "## Task\nImplement the feature\n\n## Swarm Context\nYou are helpful.",
    response: "I completed the implementation successfully.",
    tokens: { input: 100, output: 50 },
    backend: "claude-code",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Substrate entity creation in Telemetry
// ---------------------------------------------------------------------------

describe("Telemetry Substrate integration", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  describe("emitEvent() with a substrate client", () => {
    it("creates a SessionEvent entity via Substrate mutate", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const event = makeSwarmEvent(telemetry);

      await telemetry.emitEvent(event);

      const sessionEventCalls = substrate.calls.filter(c => c.mutationName === "createSessionEvent");
      expect(sessionEventCalls).toHaveLength(1);
      expect(sessionEventCalls[0].params).toMatchObject({
        eventId: event.id,
        sessionId: "sess-substrate-test",
        role: "worker",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        intent: "implementation",
        swarmFilesLoaded: JSON.stringify(["core/values.md", "modes/implementation.md"]),
        contextTokensUsed: 3000,
        inputTokens: 500,
        outputTokens: 200,
        latencyMs: 1500,
        timestamp: "2026-04-01T12:00:00.000Z",
      });
      expect(sessionEventCalls[0].params).not.toHaveProperty("costUsd");
      expect(sessionEventCalls[0].fields).toEqual({ id: true });
    });

    it("does NOT write JSONL file when substrate client is provided", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const event = makeSwarmEvent(telemetry);

      await telemetry.emitEvent(event);

      // JSONL file should not exist — Substrate is the source of truth
      const files = existsSync(TEMP_DIR) ? readdirSync(TEMP_DIR) : [];
      const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
      expect(jsonlFiles).toHaveLength(0);
    });

    it("handles missing model fields gracefully", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const event = makeSwarmEvent(telemetry, {
        model: undefined as any,
        intent: undefined as any,
        swarm_files_loaded: undefined as any,
        context_tokens_used: undefined as any,
        tokens: undefined as any,
        latency_ms: undefined as any,
      });

      await telemetry.emitEvent(event);

      const call = substrate.calls[0];
      expect(call.params.provider).toBe("");
      expect(call.params.modelId).toBe("");
      expect(call.params.intent).toBe("");
      expect(call.params.swarmFilesLoaded).toBe("[]");
      expect(call.params.contextTokensUsed).toBe(0);
      expect(call.params.inputTokens).toBe(0);
      expect(call.params.outputTokens).toBe(0);
      expect(call.params.latencyMs).toBe(0);
    });
  });

  describe("emitTranscript() with a substrate client", () => {
    it("creates a TranscriptEntry entity via Substrate mutate", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      await telemetry.emitTranscript(makeTranscript());

      const transcriptCalls = substrate.calls.filter(c => c.mutationName === "createTranscriptEntry");
      expect(transcriptCalls).toHaveLength(1);
      expect(transcriptCalls[0].params).toMatchObject({
        sessionId: "sess-substrate-test",
        role: "worker",
        inputTokens: 100,
        outputTokens: 50,
        backend: "claude-code",
        timestamp: "2026-04-01T12:00:00.000Z",
      });
      // Prompt and response should be present (scrubbed)
      expect(transcriptCalls[0].params.prompt).toContain("Implement the feature");
      expect(transcriptCalls[0].params.response).toContain("completed the implementation");
      expect(transcriptCalls[0].fields).toEqual({ id: true });
    });

    it("does NOT write transcript JSONL file when substrate client is provided", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      await telemetry.emitTranscript(makeTranscript());

      // Transcript JSONL should not exist
      const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
      expect(existsSync(transcriptsDir)).toBe(false);
    });

    it("still scrubs secrets before writing to Substrate", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      await telemetry.emitTranscript(makeTranscript({
        prompt: "Use key sk-ant-abcdefghijklmnopqrstuvwxyz to call the API",
        response: "I used sk-ant-abcdefghijklmnopqrstuvwxyz successfully",
      }));

      const call = substrate.calls[0];
      expect(call.params.prompt).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
      expect(call.params.response).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    });

    it("still truncates long content before writing to Substrate", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const longContent = "x".repeat(600_000);

      await telemetry.emitTranscript(makeTranscript({
        prompt: longContent,
        response: longContent,
      }));

      const call = substrate.calls[0];
      expect((call.params.prompt as string).length).toBeLessThan(600_000);
      expect(call.params.prompt).toContain("[truncated]");
      expect((call.params.response as string).length).toBeLessThan(600_000);
      expect(call.params.response).toContain("[truncated]");
    });

    it("handles missing tokens gracefully and writes no dollar field", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      await telemetry.emitTranscript(makeTranscript({
        tokens: undefined,
      }));

      const call = substrate.calls[0];
      expect(call.params.inputTokens).toBe(0);
      expect(call.params.outputTokens).toBe(0);
      expect(call.params).not.toHaveProperty("costUsd");
    });
  });

  describe("backward compatibility (no substrate client)", () => {
    it("emitEvent() writes JSONL when substrate client is NOT provided", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      const event = makeSwarmEvent(telemetry);

      await telemetry.emitEvent(event);

      const files = readdirSync(TEMP_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.jsonl$/);
    });

    it("emitTranscript() writes JSONL when substrate client is NOT provided", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      await telemetry.emitTranscript(makeTranscript());

      const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
      expect(existsSync(transcriptsDir)).toBe(true);
      const files = readdirSync(transcriptsDir);
      expect(files.length).toBe(1);
    });

    it("emitOversightEvent() writes JSONL when substrate client is NOT provided", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      await telemetry.emitOversightEvent({
        session_id: "sess-1",
        worker_event_id: "evt-2026-01-01-0001",
        reviewer_verdict: "approved",
        rejection_reasons: [],
        retry_count: 0,
        arbiter_involved: false,
        human_escalation: false,
        total_resolution_time_ms: 5000,
      });

      const files = readdirSync(TEMP_DIR);
      expect(files.length).toBe(1);
    });
  });

  describe("the session's context record", () => {
    const CONTEXT = {
      budgetTokens: 14000,
      loaded: [{ path: "core/values.md", tier: "core", tokens: 600 }],
      omitted: [{ path: "capabilities/git.md", tier: "capabilities", tokens: 900 }],
    };

    it("buildEvent() carries the context record onto the event", () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      const event = telemetry.buildEvent({
        sessionId: "s",
        role: "worker",
        provider: "anthropic",
        modelId: "m",
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: ["core/values.md"],
        contextTokensUsed: 600,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        context: CONTEXT,
      });
      expect(event.context_detail).toEqual(CONTEXT);
    });

    it("writes it to the SessionEvent row as JSON, per row and buffered", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      await telemetry.emitEvent(makeSwarmEvent(telemetry, { context_detail: CONTEXT }));
      const row = substrate.calls.find((c) => c.mutationName === "createSessionEvent");
      expect(row?.params.contextDetail).toBe(JSON.stringify(CONTEXT));

      const buffer = new TaskTelemetryBuffer();
      telemetry.setTaskBuffer(buffer);
      await telemetry.emitEvent(makeSwarmEvent(telemetry, { context_detail: CONTEXT }));
      expect(buffer.sessionEvent?.contextDetail).toBe(JSON.stringify(CONTEXT));
    });

    it("leaves the field off a row whose session loaded no swarm context", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      await telemetry.emitEvent(makeSwarmEvent(telemetry));
      const row = substrate.calls.find((c) => c.mutationName === "createSessionEvent");
      expect(row?.params).not.toHaveProperty("contextDetail");
    });
  });

  describe("the session's fnl coverage", () => {
    const COVERAGE = { buildCommands: 3, wrapped: 1, leftAlone: { structure: 2 }, byTool: { gradlew: { wrapped: 1, leftAlone: 2 } }, unanswered: 0 };

    it("buildEvent carries it", () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      const event = telemetry.buildEvent({
        sessionId: "s",
        role: "worker",
        provider: "anthropic",
        modelId: "m",
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: [],
        contextTokensUsed: 0,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        fnlCoverage: COVERAGE,
      });
      expect(event.fnl_coverage).toEqual(COVERAGE);
    });

    it("writes it to the SessionEvent row as JSON, per row and buffered, and leaves it off otherwise", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      await telemetry.emitEvent(makeSwarmEvent(telemetry, { fnl_coverage: COVERAGE }));
      await telemetry.emitEvent(makeSwarmEvent(telemetry));
      const rows = substrate.calls.filter((c) => c.mutationName === "createSessionEvent");
      expect(rows[0]?.params.fnlCoverage).toBe(JSON.stringify(COVERAGE));
      expect(rows[1]?.params).not.toHaveProperty("fnlCoverage");

      const buffer = new TaskTelemetryBuffer();
      telemetry.setTaskBuffer(buffer);
      await telemetry.emitEvent(makeSwarmEvent(telemetry, { fnl_coverage: COVERAGE }));
      expect(buffer.sessionEvent?.fnlCoverage).toBe(JSON.stringify(COVERAGE));
    });
  });

  describe("buffered mode (setTaskBuffer)", () => {
    it("emitEvent() buffers the SessionEvent instead of writing it per-row", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const buffer = new TaskTelemetryBuffer();
      telemetry.setTaskBuffer(buffer);

      await telemetry.emitEvent(
        makeSwarmEvent(telemetry, { id: "evt-buf-1", authorId: "example-user@example.invalid" }),
      );

      // No immediate Substrate write — the row is held for the atomic flush.
      expect(substrate.calls).toHaveLength(0);
      expect(buffer.sessionEvent).toMatchObject({
        eventId: "evt-buf-1",
        sessionId: "sess-substrate-test",
        // numeric fields stay numbers in the typed input shape
        contextTokensUsed: 3000,
        inputTokens: 500,
        swarmFilesLoaded: JSON.stringify(["core/values.md", "modes/implementation.md"]),
        // authorId threads through the typed input untouched.
        authorId: "example-user@example.invalid",
      });
    });

    it("emitTranscript() buffers the scrubbed/truncated TranscriptEntry, no per-row write", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const buffer = new TaskTelemetryBuffer();
      telemetry.setTaskBuffer(buffer);

      await telemetry.emitTranscript(makeTranscript({
        prompt: "Use key sk-ant-abcdefghijklmnopqrstuvwxyz now",
        authorId: "example-user@example.invalid",
      }));

      expect(substrate.calls).toHaveLength(0);
      expect(buffer.transcript).toMatchObject({
        sessionId: "sess-substrate-test",
        role: "worker",
        inputTokens: 100,
        outputTokens: 50,
        backend: "claude-code",
        // authorId threads through the typed input untouched.
        authorId: "example-user@example.invalid",
      });
      // Scrubbing still runs before buffering.
      expect(buffer.transcript?.prompt).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    });

    it("detaching the buffer restores immediate per-row writes", async () => {
      const substrate = createMockSubstrateClient();
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);
      const buffer = new TaskTelemetryBuffer();

      telemetry.setTaskBuffer(buffer);
      await telemetry.emitEvent(makeSwarmEvent(telemetry));
      expect(substrate.calls).toHaveLength(0);

      telemetry.setTaskBuffer(undefined);
      await telemetry.emitEvent(makeSwarmEvent(telemetry));
      expect(substrate.calls.filter(c => c.mutationName === "createSessionEvent")).toHaveLength(1);
    });
  });

  describe("Substrate failure resilience", () => {
    it("emitEvent() logs warning and does not throw when Substrate fails", async () => {
      const substrate = createMockSubstrateClient();
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw
      await telemetry.emitEvent(makeSwarmEvent(telemetry));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Substrate createSessionEvent failed"),
      );
      warnSpy.mockRestore();
    });

    it("emitTranscript() logs warning and does not throw when Substrate fails", async () => {
      const substrate = createMockSubstrateClient();
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));
      const telemetry = new Telemetry(TEMP_DIR, true, substrate as any);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw
      await telemetry.emitTranscript(makeTranscript());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Substrate createTranscriptEntry failed"),
      );
      warnSpy.mockRestore();
    });
  });
});
