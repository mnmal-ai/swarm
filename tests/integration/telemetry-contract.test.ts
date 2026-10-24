import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  createRouterAndLoader,
  INTENTS,
  MODELS,
  KNOWN_PROJECTS,
} from "./helpers.js";
import type { Router } from "@mnmal-ai/swarm-core";
import type { Loader } from "@mnmal-ai/swarm-core";
import { Telemetry } from "@mnmal-ai/swarm-telemetry";
import type { SwarmEvent, OversightEvent } from "@mnmal-ai/swarm-types";

interface JsonSchema {
  required?: string[];
  properties?: Record<string, { type?: string | string[]; enum?: string[]; minimum?: number; maximum?: number }>;
}

describe("Telemetry Contract — Event Shape Validation", () => {
  let router: Router;
  let loader: Loader;
  // The schemas this repo tracks (telemetry/schema/*.schema.json), which
  // mirror the SwarmEvent/OversightEvent types — not a sibling checkout's copy.
  const schemaRoot = path.join(__dirname, "../..");
  let eventSchema: JsonSchema;
  let oversightSchema: JsonSchema;

  beforeAll(async () => {
    const pair = createRouterAndLoader();
    router = pair.router;
    loader = pair.loader;

    // Load schemas from the swarm repo
    const eventSchemaRaw = await fs.readFile(
      path.join(schemaRoot, "telemetry/schema/event.schema.json"),
      "utf-8",
    );
    eventSchema = JSON.parse(eventSchemaRaw);

    const oversightSchemaRaw = await fs.readFile(
      path.join(schemaRoot, "telemetry/schema/oversight_event.schema.json"),
      "utf-8",
    );
    oversightSchema = JSON.parse(oversightSchemaRaw);
  });

  // -------------------------------------------------------------------------
  // SwarmEvent constructed from real data has required fields
  // -------------------------------------------------------------------------

  describe("SwarmEvent matches schema", () => {
    it("constructed event has all required fields", async () => {
      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      // Construct a SwarmEvent from real classification + load data
      const event: SwarmEvent = {
        id: "evt-2026-03-01-0001",
        timestamp: new Date().toISOString(),
        session_id: "sess-test-integration",
        role: "worker",
        model: {
          provider: "anthropic",
          model_id: MODELS.OPUS,
        },
        swarm_version: {
          commit_sha: "abc123",
        },
        intent: classification.intent,
        swarm_files_loaded: loadResult.files.map((f) => f.path),
        context_tokens_used: loadResult.totalTokens,
        tokens: {
          input: 1000,
          output: 500,
        },
        latency_ms: 2000,
        input_summary: "test integration",
        output_summary: "test output",
      };

      // Validate required fields from schema
      const required = eventSchema.required ?? [];
      for (const field of required) {
        expect(
          (event as Record<string, unknown>)[field],
          `required field "${field}" is missing or undefined`,
        ).toBeDefined();
      }
    });

    it("field types match schema expectations", async () => {
      const classification = await router.classify("test", INTENTS.IMPLEMENTATION);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      const event: SwarmEvent = {
        id: "evt-2026-03-01-0002",
        timestamp: new Date().toISOString(),
        session_id: "sess-test-types",
        role: "worker",
        model: {
          provider: "anthropic",
          model_id: MODELS.OPUS,
        },
        swarm_version: {
          commit_sha: "def456",
        },
        intent: classification.intent,
        swarm_files_loaded: loadResult.files.map((f) => f.path),
        context_tokens_used: loadResult.totalTokens,
        tokens: { input: 2000, output: 800 },
        latency_ms: 3000,
      };

      // Type checks
      expect(typeof event.id).toBe("string");
      expect(event.id.startsWith("evt-")).toBe(true);
      expect(typeof event.timestamp).toBe("string");
      expect(typeof event.session_id).toBe("string");
      expect(typeof event.role).toBe("string");
      expect(["worker", "reviewer", "arbiter"]).toContain(event.role);
      expect(typeof event.model).toBe("object");
      expect(typeof event.model.provider).toBe("string");
      expect(typeof event.model.model_id).toBe("string");
      expect(typeof event.swarm_version).toBe("object");
      expect(typeof event.swarm_version.commit_sha).toBe("string");
      expect(typeof event.intent).toBe("string");
      expect(Array.isArray(event.swarm_files_loaded)).toBe(true);
      expect(typeof event.tokens).toBe("object");
      expect(typeof event.tokens.input).toBe("number");
      expect(typeof event.tokens.output).toBe("number");
    });

    it("swarm_files_loaded paths match loaded files", async () => {
      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      const eventPaths = loadResult.files.map((f) => f.path);

      // Every path should be a string and non-empty
      for (const p of eventPaths) {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
      }

      // Should contain at least core + mode + oversight files
      expect(eventPaths.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // OversightEvent has required fields
  // -------------------------------------------------------------------------

  describe("OversightEvent matches schema", () => {
    it("constructed oversight event has all required fields", () => {
      const event: OversightEvent = {
        session_id: "sess-test-oversight",
        worker_event_id: "evt-2026-03-01-0003",
        reviewer_verdict: "approved",
        retry_count: 0,
        arbiter_involved: false,
        human_escalation: false,
        total_resolution_time_ms: 5000,
      };

      const required = oversightSchema.required ?? [];
      for (const field of required) {
        expect(
          (event as Record<string, unknown>)[field],
          `required field "${field}" is missing or undefined`,
        ).toBeDefined();
      }
    });

    it("reviewer_verdict enum in schema matches TypeScript type", () => {
      // Verify the schema defines the expected enum values — this catches
      // drift between the JSON Schema and the TypeScript type definition
      const schemaEnum = oversightSchema.properties?.reviewer_verdict?.enum ?? [];
      expect(schemaEnum).toContain("approved");
      expect(schemaEnum).toContain("rejected");
      expect(schemaEnum).toContain("skipped");
      expect(schemaEnum.length).toBe(3);
    });

    it("arbiter_verdict enum in schema matches TypeScript type", () => {
      const schemaEnum = oversightSchema.properties?.arbiter_verdict?.enum ?? [];
      expect(schemaEnum).toContain("approved");
      expect(schemaEnum).toContain("rejected");
      expect(schemaEnum).toContain("escalate");
      expect(schemaEnum.length).toBe(3);
    });

    it("retry_count schema constraints match expected range 0–3", () => {
      const retrySchema = oversightSchema.properties?.retry_count;
      expect(retrySchema).toBeDefined();
      expect(retrySchema?.type).toBe("integer");
      expect(retrySchema?.minimum).toBe(0);
      expect(retrySchema?.maximum).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // JSONL round-trip — write events, read back, validate
  // -------------------------------------------------------------------------

  describe("JSONL emission round-trip", () => {
    const TEMP_DIR = path.join(__dirname, "../__fixtures__", "integration-telemetry-test");

    beforeEach(() => {
      mkdirSync(TEMP_DIR, { recursive: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    });

    it("SwarmEvent survives write → read JSONL round-trip with correct schema fields", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();
      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      // Build and emit a real event
      const event = telemetry.buildEvent({
        sessionId: "sess-roundtrip",
        role: "worker",
        provider: "anthropic",
        modelId: MODELS.OPUS,
        swarmCommitSha: "abc123",
        intent: classification.intent,
        filesLoaded: loadResult.files.map((f) => f.path),
        contextTokensUsed: loadResult.totalTokens,
        inputTokens: 1500,
        outputTokens: 600,
        latencyMs: 2500,
        inputSummary: "test roundtrip",
        outputSummary: "roundtrip output",
      });

      await telemetry.emitEvent(event);

      // Read back from JSONL
      const files = readdirSync(TEMP_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.jsonl$/);

      const content = readFileSync(path.join(TEMP_DIR, files[0]), "utf-8").trim();
      const parsed = JSON.parse(content) as SwarmEvent;

      // Validate all required schema fields survived the round-trip
      const required = eventSchema.required ?? [];
      for (const field of required) {
        expect(
          (parsed as Record<string, unknown>)[field],
          `required field "${field}" missing after JSONL round-trip`,
        ).toBeDefined();
      }

      // Validate specific values
      expect(parsed.id).toMatch(/^evt-/);
      expect(parsed.session_id).toBe("sess-roundtrip");
      expect(parsed.role).toBe("worker");
      expect(parsed.intent).toBe("code-review");
      expect(parsed.swarm_files_loaded.length).toBe(loadResult.files.length);
      expect(parsed.tokens.input).toBe(1500);
      expect(parsed.tokens.output).toBe(600);
    });

    it("OversightEvent survives write → read JSONL round-trip", async () => {
      const telemetry = new Telemetry(TEMP_DIR, true);

      const oversightEvent: OversightEvent = {
        session_id: "sess-oversight-roundtrip",
        worker_event_id: "evt-2026-03-01-0001",
        reviewer_verdict: "rejected",
        rejection_reasons: ["missing error handling", "no tests"],
        retry_count: 1,
        arbiter_involved: false,
        human_escalation: false,
        total_resolution_time_ms: 8000,
      };

      await telemetry.emitOversightEvent(oversightEvent);

      const files = readdirSync(TEMP_DIR);
      const content = readFileSync(path.join(TEMP_DIR, files[0]), "utf-8").trim();
      const parsed = JSON.parse(content);

      // Validate required oversight schema fields
      const required = oversightSchema.required ?? [];
      for (const field of required) {
        expect(
          parsed[field],
          `required oversight field "${field}" missing after round-trip`,
        ).toBeDefined();
      }

      expect(parsed.session_id).toBe("sess-oversight-roundtrip");
      expect(parsed.reviewer_verdict).toBe("rejected");
      expect(parsed.rejection_reasons).toEqual(["missing error handling", "no tests"]);
      expect(parsed.retry_count).toBe(1);
      expect(parsed.arbiter_involved).toBe(false);
    });

    it("multiple events append to the same daily JSONL file", async () => {
      // Pin the date to avoid flakiness if the test runs across UTC midnight
      vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00Z") });
      const telemetry = new Telemetry(TEMP_DIR, true);

      // Emit two events
      const event1 = telemetry.buildEvent({
        sessionId: "sess-multi-1",
        role: "worker",
        provider: "anthropic",
        modelId: MODELS.OPUS,
        swarmCommitSha: "abc",
        intent: "implementation",
        filesLoaded: ["core/values.md"],
        contextTokensUsed: 100,
        inputTokens: 50,
        outputTokens: 25,
        latencyMs: 1000,
      });
      await telemetry.emitEvent(event1);

      const event2 = telemetry.buildEvent({
        sessionId: "sess-multi-2",
        role: "reviewer",
        provider: "anthropic",
        modelId: MODELS.SONNET,
        swarmCommitSha: "abc",
        intent: "code-review",
        filesLoaded: ["modes/code-review.md"],
        contextTokensUsed: 200,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 2000,
      });
      await telemetry.emitEvent(event2);

      // Both events should be in the same file
      const files = readdirSync(TEMP_DIR);
      expect(files.length).toBe(1);

      const content = readFileSync(path.join(TEMP_DIR, files[0]), "utf-8").trim();
      const lines = content.split("\n");
      expect(lines.length).toBe(2);

      const parsed1 = JSON.parse(lines[0]);
      const parsed2 = JSON.parse(lines[1]);
      expect(parsed1.session_id).toBe("sess-multi-1");
      expect(parsed2.session_id).toBe("sess-multi-2");
      expect(parsed1.role).toBe("worker");
      expect(parsed2.role).toBe("reviewer");
    });
  });
});
