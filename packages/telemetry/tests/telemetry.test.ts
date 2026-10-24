import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Telemetry } from "../src/telemetry/index.js";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEMP_DIR = join(__dirname, "__fixtures__", "telemetry-test");

describe("Telemetry", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  describe("runId stamping", () => {
    it("stamps runId on generic bus events", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      telemetry.setRunId("run-testproject-abc123");

      await telemetry.emitGenericEvent("task:start", { taskId: "t1" });

      const files = readdirSync(TEMP_DIR);
      expect(files.length).toBe(1);

      const content = readFileSync(join(TEMP_DIR, files[0]), "utf-8").trim();
      const event = JSON.parse(content);
      expect(event.runId).toBe("run-testproject-abc123");
      expect(event._type).toBe("bus_event");
      expect(event.payload.taskId).toBe("t1");
    });

    it("stamps runId on SwarmEvents", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      telemetry.setRunId("run-testproject-abc123");

      const event = telemetry.buildEvent({
        sessionId: "sess-1",
        role: "worker",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: ["core/values.md"],
        contextTokensUsed: 100,
        inputTokens: 50,
        outputTokens: 25,
        latencyMs: 1000,
      });

      await telemetry.emitEvent(event);

      const files = readdirSync(TEMP_DIR);
      const content = readFileSync(join(TEMP_DIR, files[0]), "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.runId).toBe("run-testproject-abc123");
      expect(parsed.id).toMatch(/^evt-/);
    });

    it("threads authorId from buildEvent onto the SwarmEvent", () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      const event = telemetry.buildEvent({
        sessionId: "sess-1",
        role: "worker",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: ["core/values.md"],
        contextTokensUsed: 100,
        inputTokens: 50,
        outputTokens: 25,
        latencyMs: 1000,
        authorId: "example-user@example.invalid",
      });

      expect(event.authorId).toBe("example-user@example.invalid");
    });

    it("leaves authorId undefined when not supplied", () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      const event = telemetry.buildEvent({
        sessionId: "sess-1",
        role: "worker",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: ["core/values.md"],
        contextTokensUsed: 100,
        inputTokens: 50,
        outputTokens: 25,
        latencyMs: 1000,
      });

      expect(event.authorId).toBeUndefined();
    });

    it("stamps runId on OversightEvents", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      telemetry.setRunId("run-testproject-def456");

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
      const content = readFileSync(join(TEMP_DIR, files[0]), "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.runId).toBe("run-testproject-def456");
    });

    it("works without runId set (backwards compatible)", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);
      // Note: no setRunId call

      await telemetry.emitGenericEvent("task:start", { taskId: "t1" });

      const files = readdirSync(TEMP_DIR);
      const content = readFileSync(join(TEMP_DIR, files[0]), "utf-8").trim();
      const event = JSON.parse(content);
      expect(event.runId).toBeUndefined();
      expect(event.payload.taskId).toBe("t1");
    });
  });
});
