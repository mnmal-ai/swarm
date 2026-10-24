import { describe, it, expect, afterEach, vi } from "vitest";
import { validatePrerequisites } from "../src/orchestrator/prerequisites.js";
import type {
  PrerequisiteCheck,
  ProjectConfig,
  TrustLevel,
  TaskBackend,
} from "@mnmal-ai/swarm-types";
import { Orchestrator } from "../src/orchestrator/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";

// ---------------------------------------------------------------------------
// Unit tests for validatePrerequisites (pure function)
// ---------------------------------------------------------------------------

describe("validatePrerequisites", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should pass when all required env vars are present", () => {
    process.env.TEST_API_KEY = "some-key";
    process.env.TEST_DB_URL = "postgres://localhost";

    const checks: PrerequisiteCheck[] = [
      { name: "TEST_API_KEY", type: "env_var", required: true, mockable: false },
      { name: "TEST_DB_URL", type: "env_var", required: true, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(true);
    expect(result.hardBlocked).toHaveLength(0);
    expect(result.softBlocked).toHaveLength(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.available)).toBe(true);
  });

  it("should hard-block when required non-mockable env var is missing", () => {
    delete process.env.MISSING_KEY;

    const checks: PrerequisiteCheck[] = [
      { name: "MISSING_KEY", type: "env_var", required: true, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(false);
    expect(result.hardBlocked).toHaveLength(1);
    expect(result.hardBlocked[0].check.name).toBe("MISSING_KEY");
    expect(result.softBlocked).toHaveLength(0);
  });

  it("should hard-block when required env var is empty string", () => {
    process.env.EMPTY_KEY = "";

    const checks: PrerequisiteCheck[] = [
      { name: "EMPTY_KEY", type: "env_var", required: true, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(false);
    expect(result.hardBlocked).toHaveLength(1);
  });

  it("should hard-block when required env var is whitespace-only", () => {
    process.env.WHITESPACE_KEY = "   ";

    const checks: PrerequisiteCheck[] = [
      { name: "WHITESPACE_KEY", type: "env_var", required: true, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(false);
    expect(result.hardBlocked).toHaveLength(1);
  });

  it("should soft-block when optional env var is missing", () => {
    delete process.env.OPTIONAL_KEY;

    const checks: PrerequisiteCheck[] = [
      { name: "OPTIONAL_KEY", type: "env_var", required: false, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(true);
    expect(result.hardBlocked).toHaveLength(0);
    expect(result.softBlocked).toHaveLength(1);
    expect(result.softBlocked[0].check.name).toBe("OPTIONAL_KEY");
  });

  it("should soft-block when required but mockable env var is missing", () => {
    delete process.env.MOCKABLE_KEY;

    const checks: PrerequisiteCheck[] = [
      { name: "MOCKABLE_KEY", type: "env_var", required: true, mockable: true },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(true);
    expect(result.hardBlocked).toHaveLength(0);
    expect(result.softBlocked).toHaveLength(1);
    expect(result.softBlocked[0].check.name).toBe("MOCKABLE_KEY");
  });

  it("should hard-block on unimplemented service checks (fail-closed)", () => {
    const checks: PrerequisiteCheck[] = [
      { name: "redis", type: "service", required: true, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(false);
    expect(result.hardBlocked).toHaveLength(1);
    expect(result.hardBlocked[0].check.name).toBe("redis");
    expect(result.results[0].available).toBe(false);
    expect(result.results[0].detail).toBe("Service checks not yet implemented");
  });

  it("should handle mixed checks with some passing and some failing", () => {
    process.env.PRESENT_KEY = "value";
    delete process.env.MISSING_REQUIRED;
    delete process.env.MISSING_OPTIONAL;

    const checks: PrerequisiteCheck[] = [
      { name: "PRESENT_KEY", type: "env_var", required: true, mockable: false },
      { name: "MISSING_REQUIRED", type: "env_var", required: true, mockable: false },
      { name: "MISSING_OPTIONAL", type: "env_var", required: false, mockable: false },
    ];

    const result = validatePrerequisites(checks);

    expect(result.passed).toBe(false);
    expect(result.hardBlocked).toHaveLength(1);
    expect(result.hardBlocked[0].check.name).toBe("MISSING_REQUIRED");
    expect(result.softBlocked).toHaveLength(1);
    expect(result.softBlocked[0].check.name).toBe("MISSING_OPTIONAL");
  });

  it("should return empty arrays when given an empty check list", () => {
    const result = validatePrerequisites([]);

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.hardBlocked).toHaveLength(0);
    expect(result.softBlocked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for Orchestrator.validatePrerequisites()
// ---------------------------------------------------------------------------

function mockBackend(): TaskBackend {
  return {
    getGoals: vi.fn().mockResolvedValue([]),
    createGoal: vi.fn().mockResolvedValue("goal-1"),
    getTasks: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue([]),
    getTaskById: vi.fn().mockResolvedValue(null),
    createTask: vi.fn().mockResolvedValue("task-1"),
    updateTask: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    escalate: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(trust: TrustLevel, prerequisites?: PrerequisiteCheck[]): ProjectConfig {
  const concurrency = {
    low: { max_workers: 1, max_tokens_per_session: 5_000_000, max_tokens_per_task: 1_000_000, max_tokens_per_goal: 3_000_000 },
    medium: { max_workers: 3, max_tokens_per_session: 20_000_000, max_tokens_per_task: 2_000_000, max_tokens_per_goal: 10_000_000 },
    high: { max_workers: 5, max_tokens_per_session: 50_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 25_000_000 },
  };
  return {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: trust,
    concurrency: concurrency[trust],
    task_backend: "local",
    prerequisites,
    created: "2026-02-21T00:00:00Z",
  };
}

describe("Orchestrator.validatePrerequisites()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should return null when no prerequisites are configured", () => {
    const orch = new Orchestrator({
      projectConfig: makeConfig("medium"),
      backend: mockBackend(),
    });

    expect(orch.validatePrerequisites()).toBeNull();
  });

  it("should return null when prerequisites array is empty", () => {
    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", []),
      backend: mockBackend(),
    });

    expect(orch.validatePrerequisites()).toBeNull();
  });

  it("should record a prerequisite_check event when all pass", () => {
    process.env.MY_KEY = "value";

    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", [
        { name: "MY_KEY", type: "env_var", required: true, mockable: false },
      ]),
      backend: mockBackend(),
    });

    const result = orch.validatePrerequisites();

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);

    const events = orch.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("prerequisite_check");
  });

  it("should record a prerequisite_failed event and emit human:escalation when hard-blocked", () => {
    delete process.env.REQUIRED_MISSING;

    const eventBus = new SwarmEventBus();
    const escalations: unknown[] = [];
    eventBus.on("human:escalation", (e) => escalations.push(e));

    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", [
        { name: "REQUIRED_MISSING", type: "env_var", required: true, mockable: false },
      ]),
      backend: mockBackend(),
      eventBus,
    });

    const result = orch.validatePrerequisites();

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.hardBlocked).toHaveLength(1);

    const events = orch.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("prerequisite_failed");

    // Should have emitted a human:escalation event
    expect(escalations).toHaveLength(1);
  });

  it("should emit prerequisite:checked event on the event bus", () => {
    process.env.CHECK_KEY = "present";

    const eventBus = new SwarmEventBus();
    const checkedEvents: unknown[] = [];
    eventBus.on("prerequisite:checked", (e) => checkedEvents.push(e));

    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", [
        { name: "CHECK_KEY", type: "env_var", required: true, mockable: false },
      ]),
      backend: mockBackend(),
      eventBus,
    });

    orch.validatePrerequisites();

    expect(checkedEvents).toHaveLength(1);
  });

  it("dispatchParallel should throw when prerequisites are hard-blocked", async () => {
    delete process.env.DISPATCH_REQUIRED;

    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", [
        { name: "DISPATCH_REQUIRED", type: "env_var", required: true, mockable: false },
      ]),
      backend: mockBackend(),
    });

    await expect(
      orch.dispatchParallel({
        tasks: [],
        goal: { id: "g1", description: "test", priority: 1, status: "pending", constraints: [], acceptance_criteria: [] },
        project: "test",
        workingDirectory: "/tmp",
        executeTask: async () => ({ response: "", filesLoaded: [], tokensUsed: { input: 0, output: 0 }, sessionId: "s", backendType: "api" as const, oversight: { verdict: "approved" as const, retryCount: 0, arbiterInvolved: false, humanEscalation: false, rejectionReasons: [], totalResolutionTimeMs: 0 } }),
      }),
    ).rejects.toThrow("Cannot dispatch — missing required prerequisites: DISPATCH_REQUIRED");
  });

  it("dispatchParallel should proceed when prerequisites pass", async () => {
    process.env.DISPATCH_OK = "present";

    const orch = new Orchestrator({
      projectConfig: makeConfig("medium", [
        { name: "DISPATCH_OK", type: "env_var", required: true, mockable: false },
      ]),
      backend: mockBackend(),
    });

    // Empty task list — should not throw
    const result = await orch.dispatchParallel({
      tasks: [],
      goal: { id: "g1", description: "test", priority: 1, status: "pending", constraints: [], acceptance_criteria: [] },
      project: "test",
      workingDirectory: "/tmp",
      executeTask: async () => ({ response: "", filesLoaded: [], tokensUsed: { input: 0, output: 0 }, sessionId: "s", backendType: "api" as const, oversight: { verdict: "approved" as const, retryCount: 0, arbiterInvolved: false, humanEscalation: false, rejectionReasons: [], totalResolutionTimeMs: 0 } }),
    });

    expect(result.completed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
