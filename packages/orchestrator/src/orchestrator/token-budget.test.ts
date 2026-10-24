import { describe, it, expect, vi } from "vitest";
import type { ProjectConfig, TaskBackend } from "@mnmal-ai/swarm-types";
import { Orchestrator } from "./index.js";
import { AUTONOMY_PRESETS } from "../autonomy/index.js";

// ---------------------------------------------------------------------------
// Budgets are in tokens at three levels — session, goal, task — counted as
// all input (fresh + cache reads + cache writes) plus output. A project that
// sets no limit gets its trust level's, so no check is ever inert.
// ---------------------------------------------------------------------------

function mockBackend(): TaskBackend {
  return {
    getGoals: vi.fn().mockResolvedValue([]),
    createGoal: vi.fn().mockResolvedValue("goal-1"),
    getTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue("task-1"),
    updateTask: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    escalate: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOrchestrator(limits: { session?: number; goal?: number; task?: number } = {}): Orchestrator {
  const config: ProjectConfig = {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency: {
      max_workers: 3,
      ...(limits.session === undefined ? {} : { max_tokens_per_session: limits.session }),
      ...(limits.goal === undefined ? {} : { max_tokens_per_goal: limits.goal }),
      ...(limits.task === undefined ? {} : { max_tokens_per_task: limits.task }),
    },
    task_backend: "local",
    created: "2026-02-21T00:00:00Z",
  };
  return new Orchestrator({ projectConfig: config, backend: mockBackend() });
}

describe("Orchestrator token budgets", () => {
  it("starts at zero and accumulates added tokens", () => {
    const orch = makeOrchestrator();
    expect(orch.getCumulativeTokens()).toBe(0);
    orch.addTokens(250);
    orch.addTokens(750);
    expect(orch.getCumulativeTokens()).toBe(1000);
  });

  describe("session", () => {
    it("warns from 80% of the limit", () => {
      const orch = makeOrchestrator({ session: 1000 });
      expect(orch.shouldWarnTokens(799)).toBe(false);
      expect(orch.shouldWarnTokens(800)).toBe(true);
    });

    it("is exceeded only above the limit", () => {
      const orch = makeOrchestrator({ session: 1000 });
      expect(orch.isSessionTokenExceeded(1000)).toBe(false);
      expect(orch.isSessionTokenExceeded(1001)).toBe(true);
    });
  });

  describe("goal", () => {
    it("is exceeded only above the limit", () => {
      const orch = makeOrchestrator({ goal: 500 });
      expect(orch.isGoalTokenExceeded(500)).toBe(false);
      expect(orch.isGoalTokenExceeded(501)).toBe(true);
    });
  });

  describe("task", () => {
    it("is exceeded only above the limit", () => {
      const orch = makeOrchestrator({ task: 200 });
      expect(orch.isTaskTokenExceeded(200)).toBe(false);
      expect(orch.isTaskTokenExceeded(201)).toBe(true);
    });

    it("can have its limit raised mid-run, and reports the new one", () => {
      const orch = makeOrchestrator({ task: 200 });
      orch.updateTaskTokenLimit(300);
      expect(orch.getTaskTokenLimit()).toBe(300);
      expect(orch.isTaskTokenExceeded(250)).toBe(false);
    });
  });

  describe("with no limits configured", () => {
    it("enforces the trust level's limits instead of none", () => {
      const orch = makeOrchestrator();
      const preset = AUTONOMY_PRESETS.medium.execution;

      expect(orch.getTokenLimits()).toEqual({
        session: preset.max_tokens_per_session,
        goal: preset.max_tokens_per_goal,
        task: preset.max_tokens_per_task,
      });
      expect(orch.isSessionTokenExceeded(preset.max_tokens_per_session + 1)).toBe(true);
      expect(orch.isGoalTokenExceeded(preset.max_tokens_per_goal + 1)).toBe(true);
      expect(orch.isTaskTokenExceeded(preset.max_tokens_per_task + 1)).toBe(true);
    });
  });
});
