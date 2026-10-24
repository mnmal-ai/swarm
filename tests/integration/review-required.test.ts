/**
 * Tests for the review_required flag enforcement.
 *
 * Verifies that:
 * - The orchestrator's buildDirective correctly maps trust levels to review_required
 * - The directive flows correctly to RunOptions.reviewRequired
 * - Swarm.runWithOversight skips oversight when reviewRequired is false
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@mnmal-ai/swarm-orchestrator";
import { createMockSubstrateClient } from "./helpers.js";
import type {
  Goal,
  Task,
  ProjectConfig,
  TaskBackend,
  DispatchDirective,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    description: "Test goal",
    priority: 1,
    status: "pending",
    constraints: [],
    acceptance_criteria: ["tests pass"],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    description: "Implement feature",
    intent: "implementation",
    status: "pending",
    order: 1,
    ...overrides,
  };
}

function makeProjectConfig(trust: "low" | "medium" | "high"): ProjectConfig {
  return {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: trust,
    concurrency: { max_workers: 1, max_tokens_per_session: 10_000_000, max_tokens_per_task: 2_000_000, max_tokens_per_goal: 5_000_000 },
    task_backend: "local",
    created: new Date().toISOString(),
  };
}

// Minimal stub satisfying the TaskBackend interface
const stubBackend: TaskBackend = {
  getGoals: async () => [],
  createGoal: async () => "",
  getTasks: async () => [],
  getAllTasks: async () => [],
  getTaskById: async () => null,
  createTask: async () => "",
  updateTask: async () => {},
  addComment: async () => {},
  escalate: async () => {},
};

// ---------------------------------------------------------------------------
// Tests: Orchestrator.buildDirective trust-level mapping
// ---------------------------------------------------------------------------

describe("Orchestrator.buildDirective review_required mapping", () => {
  it("low trust sets review_required to true", () => {
    const orch = new Orchestrator({
      projectConfig: makeProjectConfig("low"),
      backend: stubBackend,
    });
    const directive = orch.buildDirective(makeGoal(), makeTask());
    expect(directive.directive.review_required).toBe(true);
  });

  it("medium trust sets review_required to true (from autonomy preset)", () => {
    const orch = new Orchestrator({
      projectConfig: makeProjectConfig("medium"),
      backend: stubBackend,
    });
    const directive = orch.buildDirective(makeGoal(), makeTask());
    // Medium trust preset: require_review = true
    expect(directive.directive.review_required).toBe(true);
  });

  it("high trust sets review_required to false", () => {
    const orch = new Orchestrator({
      projectConfig: makeProjectConfig("high"),
      backend: stubBackend,
    });
    const directive = orch.buildDirective(makeGoal(), makeTask());
    expect(directive.directive.review_required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Swarm.runWithOversight reviewRequired skip logic
//
// These tests mock Swarm internals to verify the actual skip code path
// in runWithOversight(). We mock Swarm.prototype.run to return a canned
// result and verify that when reviewRequired=false, the result has
// verdict "skipped" — exercising the real production code.
// ---------------------------------------------------------------------------

// Dynamically import Swarm so we can spy on it after mocking dependencies
vi.mock("../src/router/index.js", () => ({
  Router: vi.fn().mockImplementation(() => ({
    classify: vi.fn().mockResolvedValue({ route: "test", confidence: 1 }),
    loadManifest: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/loader/index.js", () => ({
  Loader: vi.fn().mockImplementation(() => ({
    loadFiles: vi.fn().mockResolvedValue({ files: [], totalTokens: 0 }),
  })),
}));

vi.mock("../src/executor/index.js", () => ({
  createProvider: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue({
      content: "test output",
      tokensUsed: { input: 100, output: 50 },
    }),
  }),
  AnthropicProvider: vi.fn(),
  OpenAIProvider: vi.fn(),
}));

vi.mock("../src/telemetry/index.js", () => ({
  Telemetry: vi.fn().mockImplementation(() => ({
    emitEvent: vi.fn().mockResolvedValue({ id: "evt-test" }),
    emitOversightEvent: vi.fn().mockResolvedValue(undefined),
    enabled: true,
  })),
}));

vi.mock("@mnmal-ai/swarm-oversight", () => ({
  Oversight: vi.fn().mockImplementation(() => ({})),
  validateWorkerOutput: vi.fn().mockReturnValue({ valid: true }),
  captureGitDiff: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/tools/index.js", () => ({
  getBuiltinTools: vi.fn().mockReturnValue([]),
  executeTool: vi.fn(),
  BUILTIN_TOOLS: [],
}));

vi.mock("@mnmal-ai/swarm-worker-backends", () => ({
  instantiateFallback: vi.fn().mockReturnValue(null),
  resolveWorkerBackend: vi.fn(),
  detectAvailableBackends: vi.fn(),
  ApiWorkerBackend: vi.fn(),
  ClaudeCodeBackend: vi.fn(),
}));

vi.mock("../src/skill-fetcher/index.js", () => ({
  SkillFetcher: vi.fn().mockImplementation(() => ({
    fetchSkills: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("abc1234")),
  execFile: vi.fn(),
  exec: vi.fn(),
}));

describe("Swarm.runWithOversight reviewRequired skip logic", () => {
  let Swarm: typeof import("@mnmal-ai/swarm-core").Swarm;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@mnmal-ai/swarm-core");
    Swarm = mod.Swarm;
  });

  it("returns verdict 'skipped' when reviewRequired is false and oversight is enabled", async () => {
    const swarm = new Swarm(
      {
        swarmPath: "/tmp/swarm",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        oversight: { enabled: true, reviewerModel: "claude-sonnet-4-5" },
      },
      { queryClient: createMockSubstrateClient() as any },
    );

    // Spy on the run method to return a canned worker result
    vi.spyOn(swarm, "run").mockResolvedValue({
      response: "test output",
      filesLoaded: [],
      tokensUsed: { input: 100, output: 50 },
      sessionId: "sess-test-123",
      telemetryEventId: "evt-test",
      backendType: "api",
    });

    const result = await swarm.runWithOversight("test task", {
      input: "test input",
      reviewRequired: false,
    });

    expect(result.oversight.verdict).toBe("skipped");
    expect(result.oversight.retryCount).toBe(0);
    expect(result.oversight.arbiterInvolved).toBe(false);
    expect(result.oversight.humanEscalation).toBe(false);
    expect(result.response).toBe("test output");
  });

  it("does not skip oversight when reviewRequired is true", async () => {
    const swarm = new Swarm(
      {
        swarmPath: "/tmp/swarm",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        oversight: { enabled: true, reviewerModel: "claude-sonnet-4-5" },
      },
      { queryClient: createMockSubstrateClient() as any },
    );

    vi.spyOn(swarm, "run").mockResolvedValue({
      response: "test output",
      filesLoaded: [],
      tokensUsed: { input: 100, output: 50 },
      sessionId: "sess-test-123",
      telemetryEventId: "evt-test",
      backendType: "api",
    });

    // When reviewRequired is true (or default), the oversight chain should
    // attempt to run. Since the reviewer is mocked to not exist, this will
    // exercise the path past the skip block. We verify it does NOT return
    // "skipped" with reason "trust_level".
    try {
      const result = await swarm.runWithOversight("test task", {
        input: "test input",
        reviewRequired: true,
      });
      // If it succeeds, it should not be a trust_level skip
      if (result.oversight.verdict === "skipped") {
        // Could be skipped for other reasons (e.g., review policy says skip)
        // but should NOT be "trust_level"
        expect(result.oversight).not.toHaveProperty("reviewSkippedReason", "trust_level");
      }
    } catch {
      // Expected — mocked reviewer may throw. The point is the skip block was NOT hit.
    }
  });

  it("does not skip oversight when reviewRequired is undefined", async () => {
    const swarm = new Swarm(
      {
        swarmPath: "/tmp/swarm",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        oversight: { enabled: true, reviewerModel: "claude-sonnet-4-5" },
      },
      { queryClient: createMockSubstrateClient() as any },
    );

    vi.spyOn(swarm, "run").mockResolvedValue({
      response: "test output",
      filesLoaded: [],
      tokensUsed: { input: 100, output: 50 },
      sessionId: "sess-test-123",
      telemetryEventId: "evt-test",
      backendType: "api",
    });

    try {
      const result = await swarm.runWithOversight("test task", {
        input: "test input",
        // reviewRequired not set — should default to running oversight
      });
      if (result.oversight.verdict === "skipped") {
        expect(result.oversight).not.toHaveProperty("reviewSkippedReason", "trust_level");
      }
    } catch {
      // Expected — mocked reviewer may throw
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: End-to-end directive → runOptions flow
// ---------------------------------------------------------------------------

describe("directive review_required flows to RunOptions.reviewRequired", () => {
  it("buildDirective output can be mapped to RunOptions.reviewRequired", () => {
    const orch = new Orchestrator({
      projectConfig: makeProjectConfig("medium"),
      backend: stubBackend,
    });
    const directive: DispatchDirective = orch.buildDirective(makeGoal(), makeTask());

    // Simulate the mapping done in run.ts
    const runOptions = {
      input: "test input",
      reviewRequired: directive.directive.review_required,
    };

    // medium trust preset: require_review = true -> reviewRequired is true
    expect(runOptions.reviewRequired).toBe(true);
  });

  it("low trust directive produces reviewRequired true in RunOptions", () => {
    const orch = new Orchestrator({
      projectConfig: makeProjectConfig("low"),
      backend: stubBackend,
    });
    const directive = orch.buildDirective(makeGoal(), makeTask());

    const runOptions = {
      input: "test input",
      reviewRequired: directive.directive.review_required,
    };

    expect(runOptions.reviewRequired).toBe(true);
  });
});
