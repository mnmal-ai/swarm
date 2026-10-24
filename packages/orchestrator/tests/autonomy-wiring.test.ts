/**
 * Tests for wiring AutonomyConfig into the Orchestrator.
 *
 * Verifies that:
 * - buildDirective uses autonomy.review.require_review (not hardcoded table)
 * - buildDirective uses autonomy.context.skill_tiers (not hardcoded table)
 * - getMaxConcurrency uses autonomy.execution.max_workers
 * - getMaxConcurrency returns 1 when parallel_workers is false
 */

import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";
import { AUTONOMY_PRESETS } from "../src/autonomy/presets.js";
import type {
  Goal,
  Task,
  TaskBackend,
  ProjectConfig,
  AutonomyConfig,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helpers
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

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    description: "Test goal",
    priority: 1,
    status: "pending",
    constraints: ["no third-party deps"],
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

function makeProjectConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency: {
      max_workers: 3,
      max_tokens_per_session: 20_000_000,
      max_tokens_per_task: 2_000_000,
      max_tokens_per_goal: 10_000_000,
    },
    task_backend: "local",
    created: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Autonomy wiring in Orchestrator", () => {
  describe("buildDirective uses autonomy.review.require_review", () => {
    it("review_required is true when autonomy.review.require_review is true", () => {
      const autonomy: AutonomyConfig = {
        ...AUTONOMY_PRESETS.medium,
        review: { ...AUTONOMY_PRESETS.medium.review, require_review: true },
      };
      const config = makeProjectConfig({ autonomy });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      const directive = orch.buildDirective(makeGoal(), makeTask());
      expect(directive.directive.review_required).toBe(true);
    });

    it("review_required is false when autonomy.review.require_review is false", () => {
      const autonomy: AutonomyConfig = {
        ...AUTONOMY_PRESETS.medium,
        review: { ...AUTONOMY_PRESETS.medium.review, require_review: false },
      };
      const config = makeProjectConfig({ autonomy });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      const directive = orch.buildDirective(makeGoal(), makeTask());
      expect(directive.directive.review_required).toBe(false);
    });
  });

  describe("buildDirective uses autonomy.context.skill_tiers", () => {
    it("uses skill_tiers from explicit autonomy config", () => {
      const autonomy: AutonomyConfig = {
        ...AUTONOMY_PRESETS.low,
        context: { ...AUTONOMY_PRESETS.low.context, skill_tiers: ["core"] },
      };
      const config = makeProjectConfig({ trust_level: "low", autonomy });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      const directive = orch.buildDirective(makeGoal(), makeTask());
      expect(directive.directive.skills_allowed).toEqual(["core"]);
    });

    it("uses preset skill_tiers when no explicit autonomy", () => {
      // high trust preset has ["core", "vetted", "community"]
      const config = makeProjectConfig({
        trust_level: "high",
        concurrency: {
          max_workers: 5,
          max_tokens_per_session: 50_000_000,
          max_tokens_per_task: 5_000_000,
          max_tokens_per_goal: 25_000_000,
        },
      });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      const directive = orch.buildDirective(makeGoal(), makeTask());
      expect(directive.directive.skills_allowed).toEqual(["core", "vetted", "community"]);
    });
  });

  describe("getMaxConcurrency uses autonomy.execution", () => {
    it("returns max_workers from autonomy config", () => {
      const autonomy: AutonomyConfig = {
        ...AUTONOMY_PRESETS.medium,
        execution: { ...AUTONOMY_PRESETS.medium.execution, parallel_workers: true, max_workers: 7 },
      };
      const config = makeProjectConfig({ autonomy });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      expect(orch.getMaxConcurrency()).toBe(7);
    });

    it("returns 1 when parallel_workers is false", () => {
      const autonomy: AutonomyConfig = {
        ...AUTONOMY_PRESETS.medium,
        execution: { ...AUTONOMY_PRESETS.medium.execution, parallel_workers: false, max_workers: 5 },
      };
      const config = makeProjectConfig({ autonomy });
      const orch = new Orchestrator({ projectConfig: config, backend: mockBackend() });

      expect(orch.getMaxConcurrency()).toBe(1);
    });
  });
});
