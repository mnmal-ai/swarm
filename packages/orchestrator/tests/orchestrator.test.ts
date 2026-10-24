import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Goal,
  Task,
  TaskBackend,
  ProjectConfig,
  TrustLevel,
} from "@mnmal-ai/swarm-types";
import { Orchestrator } from "../src/orchestrator/index.js";

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

function makeConfig(trust: TrustLevel): ProjectConfig {
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
    created: "2026-02-21T00:00:00Z",
  };
}

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    description: "Implement authentication flow",
    priority: 1,
    status: "pending",
    constraints: ["Must use OAuth2", "No third-party cookies"],
    acceptance_criteria: ["Users can log in with GitHub", "Session persists across tabs"],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    description: "Set up OAuth2 provider integration",
    intent: "implementation",
    status: "pending",
    order: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  let backend: TaskBackend;

  beforeEach(() => {
    backend = mockBackend();
  });

  // -------------------------------------------------------------------------
  // buildDirective — trust level mappings
  // -------------------------------------------------------------------------

  describe("buildDirective", () => {
    it("at low trust: full context, core-only skills (from preset), review required", () => {
      const config = makeConfig("low");
      const orchestrator = new Orchestrator({ projectConfig: config, backend });
      const goal = makeGoal();
      const task = makeTask();

      const directive = orchestrator.buildDirective(goal, task);

      expect(directive.task_id).toBe("task-1");
      expect(directive.goal_id).toBe("goal-1");
      expect(directive.intent).toBe("implementation");
      expect(directive.description).toBe("Set up OAuth2 provider integration");

      expect(directive.directive.trust_level).toBe("low");
      expect(directive.directive.context_depth).toBe("full");
      // Low trust preset: skill_tiers = ["core"]
      expect(directive.directive.skills_allowed).toEqual(["core"]);
      expect(directive.directive.review_required).toBe(true);

      // Goal constraints are propagated. Acceptance criteria are scoped to the
      // task description, not the goal's criteria (prevents cross-task rejections).
      expect(directive.directive.constraints).toContain("Must use OAuth2");
      expect(directive.directive.constraints).toContain("No third-party cookies");
      expect(directive.directive.acceptance_criteria).toHaveLength(1);
      expect(directive.directive.acceptance_criteria[0]).toContain("Task completed as described:");
    });

    it("at medium trust: standard context, core+vetted skills, review required (from preset)", () => {
      const config = makeConfig("medium");
      const orchestrator = new Orchestrator({ projectConfig: config, backend });
      const goal = makeGoal();
      const task = makeTask();

      const directive = orchestrator.buildDirective(goal, task);

      expect(directive.directive.trust_level).toBe("medium");
      expect(directive.directive.context_depth).toBe("standard");
      expect(directive.directive.skills_allowed).toEqual(["core", "vetted"]);
      // Medium trust preset: require_review = true
      expect(directive.directive.review_required).toBe(true);
    });

    it("at high trust: lean context, includes community skills, no review required", () => {
      const config = makeConfig("high");
      const orchestrator = new Orchestrator({ projectConfig: config, backend });
      const goal = makeGoal();
      const task = makeTask();

      const directive = orchestrator.buildDirective(goal, task);

      expect(directive.directive.trust_level).toBe("high");
      expect(directive.directive.context_depth).toBe("lean");
      expect(directive.directive.skills_allowed).toEqual(["core", "vetted", "community"]);
      expect(directive.directive.review_required).toBe(false);
    });

    it("includes default escalation triggers referencing the task", () => {
      const config = makeConfig("medium");
      const orchestrator = new Orchestrator({ projectConfig: config, backend });
      const goal = makeGoal();
      const task = makeTask();

      const directive = orchestrator.buildDirective(goal, task);

      expect(directive.directive.escalation_triggers.length).toBeGreaterThan(0);
      // Should include a trigger about going outside scope
      expect(
        directive.directive.escalation_triggers.some((t) =>
          t.includes(task.description)
        )
      ).toBe(true);
      // Should include a trigger about new dependencies
      expect(
        directive.directive.escalation_triggers.some((t) =>
          t.toLowerCase().includes("dependency")
        )
      ).toBe(true);
      // Should include a trigger about acceptance criteria
      expect(
        directive.directive.escalation_triggers.some((t) =>
          t.toLowerCase().includes("acceptance criteria")
        )
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getMaxConcurrency
  // -------------------------------------------------------------------------

  describe("getMaxConcurrency", () => {
    it("returns 1 for low trust", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("low"), backend });
      expect(orchestrator.getMaxConcurrency()).toBe(1);
    });

    it("returns 3 for medium trust", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });
      expect(orchestrator.getMaxConcurrency()).toBe(3);
    });

    it("returns 5 for high trust", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("high"), backend });
      expect(orchestrator.getMaxConcurrency()).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Token budgets
  // -------------------------------------------------------------------------

  describe("token budgets", () => {
    it("isSessionTokenExceeded returns true when tokens exceed max_tokens_per_session", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("low"), backend }); // 5M
      expect(orchestrator.isSessionTokenExceeded(5_000_000)).toBe(false); // equal is not exceeded
      expect(orchestrator.isSessionTokenExceeded(5_000_001)).toBe(true);
    });

    it("shouldWarnTokens returns true at 80% of max_tokens_per_session", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("low"), backend }); // 80% = 4M
      expect(orchestrator.shouldWarnTokens(3_999_999)).toBe(false);
      expect(orchestrator.shouldWarnTokens(4_000_000)).toBe(true);
    });

    it("isTaskTokenExceeded returns true when tokens exceed max_tokens_per_task", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend }); // 2M
      expect(orchestrator.isTaskTokenExceeded(2_000_000)).toBe(false);
      expect(orchestrator.isTaskTokenExceeded(2_000_001)).toBe(true);
    });

    it("isGoalTokenExceeded returns true when tokens exceed max_tokens_per_goal", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend }); // 10M
      expect(orchestrator.isGoalTokenExceeded(10_000_000)).toBe(false);
      expect(orchestrator.isGoalTokenExceeded(10_000_001)).toBe(true);
    });

    it("updateTaskTokenLimit and getTaskTokenLimit round-trip a new limit", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });
      expect(orchestrator.getTaskTokenLimit()).toBe(2_000_000);

      orchestrator.updateTaskTokenLimit(5_000_000);
      expect(orchestrator.getTaskTokenLimit()).toBe(5_000_000);
      expect(orchestrator.isTaskTokenExceeded(4_999_999)).toBe(false);
      expect(orchestrator.isTaskTokenExceeded(5_000_001)).toBe(true);
    });

    it("raising one orchestrator's task limit leaves the trust level's preset alone", () => {
      const config = makeConfig("medium");
      delete (config.concurrency as { max_tokens_per_task?: number }).max_tokens_per_task;
      const first = new Orchestrator({ projectConfig: config, backend });
      const before = first.getTaskTokenLimit();

      first.updateTaskTokenLimit(before * 2);

      expect(new Orchestrator({ projectConfig: makeConfig("medium"), backend }).getTaskTokenLimit()).toBe(2_000_000);
      const fresh = new Orchestrator({ projectConfig: { ...config, concurrency: { max_workers: 3 } }, backend });
      expect(fresh.getTaskTokenLimit()).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // Elapsed time
  // -------------------------------------------------------------------------

  describe("getElapsedMs", () => {
    it("returns a positive number of milliseconds since construction", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("low"), backend });
      // Give the clock a tiny bit of time to advance
      const elapsed = orchestrator.getElapsedMs();
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(typeof elapsed).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  describe("checkpoints", () => {
    it("saveCheckpoint writes and loadCheckpoint reads it back", async () => {
      const tmpDir = `/tmp/swarm-orchestrator-test-${Date.now()}`;
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig("medium"),
        backend,
        checkpointPath: tmpDir,
      });
      orchestrator.addTokens(1_230_000);

      await orchestrator.saveCheckpoint({
        session_id: "sess-test",
        swarm_version: "v1.0.0",
        project: "test-project",
        current_goal: "goal-1",
        current_task: "task-2",
        completed_tasks: ["task-1"],
        pending_tasks: ["task-2", "task-3"],
        skipped_tasks: [],
        blocked: false,
      });

      const checkpoint = await orchestrator.loadCheckpoint();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.session_id).toBe("sess-test");
      expect(checkpoint!.swarm_version).toBe("v1.0.0");
      expect(checkpoint!.project).toBe("test-project");
      expect(checkpoint!.trust_level).toBe("medium");
      expect(checkpoint!.current_goal).toBe("goal-1");
      expect(checkpoint!.current_task).toBe("task-2");
      expect(checkpoint!.completed_tasks).toEqual(["task-1"]);
      expect(checkpoint!.pending_tasks).toEqual(["task-2", "task-3"]);
      expect(checkpoint!.blocked).toBe(false);
      expect(checkpoint!.cumulative_tokens).toBe(1_230_000);
      expect(checkpoint!.elapsed_ms).toBeGreaterThanOrEqual(0);

      // Cleanup
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("clearCheckpoint removes the checkpoint file so loadCheckpoint returns null", async () => {
      const tmpDir = `/tmp/swarm-orchestrator-clear-${Date.now()}`;
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig("medium"),
        backend,
        checkpointPath: tmpDir,
      });

      // Save a checkpoint first
      await orchestrator.saveCheckpoint({
        session_id: "sess-clear",
        swarm_version: "v1.0.0",
        project: "test-project",
        current_goal: "goal-1",
        current_task: "task-1",
        completed_tasks: [],
        pending_tasks: ["task-1"],
        skipped_tasks: [],
        blocked: false,
      });

      // Verify it exists
      const before = await orchestrator.loadCheckpoint();
      expect(before).not.toBeNull();
      expect(before!.session_id).toBe("sess-clear");

      // Clear it
      await orchestrator.clearCheckpoint();

      // Verify it's gone
      const after = await orchestrator.loadCheckpoint();
      expect(after).toBeNull();

      // Cleanup
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("skipped_tasks round-trips through saveCheckpoint and loadCheckpoint", async () => {
      const tmpDir = `/tmp/swarm-orchestrator-skipped-${Date.now()}`;
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig("low"),
        backend,
        checkpointPath: tmpDir,
      });

      const skipped = ["task-2", "task-5", "task-7"];

      await orchestrator.saveCheckpoint({
        session_id: "sess-skipped",
        swarm_version: "v2.0.0",
        project: "test-project",
        current_goal: "goal-1",
        current_task: "task-3",
        completed_tasks: ["task-1"],
        pending_tasks: ["task-3", "task-4"],
        skipped_tasks: skipped,
        blocked: false,
      });

      const checkpoint = await orchestrator.loadCheckpoint();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.skipped_tasks).toEqual(skipped);

      // Cleanup
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loadCheckpoint returns null when no checkpoint exists", async () => {
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig("low"),
        backend,
        checkpointPath: `/tmp/swarm-no-checkpoint-${Date.now()}`,
      });

      const checkpoint = await orchestrator.loadCheckpoint();
      expect(checkpoint).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Goal summaries (SDK-23)
  // -------------------------------------------------------------------------

  describe("goal summaries", () => {
    it("addGoalSummary and getGoalSummaries round-trip", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      orchestrator.addGoalSummary({
        goalId: "goal-1",
        description: "Implement auth",
        status: "completed",
        tasksCompleted: 5,
        tasksFailed: 0,
        tasksSkipped: 0,
        tokens: 2_500_000,
        durationMs: 120000,
      });

      orchestrator.addGoalSummary({
        goalId: "goal-2",
        description: "Add user profiles",
        status: "blocked",
        tasksCompleted: 0,
        tasksFailed: 2,
        tasksSkipped: 0,
        tokens: 1_000_000,
        durationMs: 60000,
      });

      const summaries = orchestrator.getGoalSummaries();
      expect(summaries).toHaveLength(2);
      expect(summaries[0].goalId).toBe("goal-1");
      expect(summaries[0].status).toBe("completed");
      expect(summaries[1].goalId).toBe("goal-2");
      expect(summaries[1].status).toBe("blocked");
    });

    it("getGoalSummaries returns a copy", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      orchestrator.addGoalSummary({
        goalId: "goal-1",
        description: "Test goal",
        status: "completed",
        tasksCompleted: 1,
        tasksFailed: 0,
        tasksSkipped: 0,
        tokens: 500_000,
        durationMs: 5000,
      });

      const copy = orchestrator.getGoalSummaries();
      copy.push({
        goalId: "fake",
        description: "Fake",
        status: "completed",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksSkipped: 0,
        tokens: 0,
        durationMs: 0,
      });

      expect(orchestrator.getGoalSummaries()).toHaveLength(1);
    });

    it("buildPriorGoalsContext returns empty string when no summaries", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });
      expect(orchestrator.buildPriorGoalsContext()).toBe("");
    });

    it("buildPriorGoalsContext formats completed and blocked goals", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      orchestrator.addGoalSummary({
        goalId: "goal-1",
        description: "Implement auth",
        status: "completed",
        tasksCompleted: 5,
        tasksFailed: 0,
        tasksSkipped: 0,
        tokens: 2_500_000,
        durationMs: 120000,
      });

      orchestrator.addGoalSummary({
        goalId: "goal-2",
        description: "Add user profiles",
        status: "blocked",
        tasksCompleted: 0,
        tasksFailed: 2,
        tasksSkipped: 0,
        tokens: 1_000_000,
        durationMs: 60000,
      });

      const ctx = orchestrator.buildPriorGoalsContext();
      expect(ctx).toContain("## Prior goals");
      expect(ctx).toContain("[DONE]");
      expect(ctx).toContain("Implement auth");
      expect(ctx).toContain("[BLOCKED]");
      expect(ctx).toContain("Add user profiles");
      expect(ctx).toContain("2.5M tokens");
      expect(ctx).not.toMatch(/\$/);
    });

    it("trimEventsForNextGoal keeps only last 5 events", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      for (let i = 0; i < 20; i++) {
        orchestrator.recordEvent("task_dispatched", `Event ${i}`);
      }

      expect(orchestrator.getEvents()).toHaveLength(20);

      orchestrator.trimEventsForNextGoal();

      expect(orchestrator.getEvents()).toHaveLength(5);
      // The last 5 events should be preserved
      expect(orchestrator.getEvents()[0].detail).toBe("Event 15");
      expect(orchestrator.getEvents()[4].detail).toBe("Event 19");
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe("events", () => {
    it("recordEvent creates and stores an event", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      const event = orchestrator.recordEvent("session_started", "Session initialized");

      expect(event.event_type).toBe("session_started");
      expect(event.detail).toBe("Session initialized");
      expect(event.project).toBe("test-project");
      expect(event.trust_level).toBe("medium");
      expect(event.id).toBeTruthy();
      expect(event.timestamp).toBeTruthy();
      expect(event.session_id).toBeTruthy();
    });

    it("recordEvent with optional extra fields", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("low"), backend });

      const event = orchestrator.recordEvent("token_warning", "Approaching limit", {
        goal_id: "goal-1",
        task_id: "task-2",
        tokens: 3_500_000,
        cumulative_tokens: 4_200_000,
        active_workers: 1,
      });

      expect(event.goal_id).toBe("goal-1");
      expect(event.task_id).toBe("task-2");
      expect(event.tokens).toBe(3_500_000);
      expect(event.cumulative_tokens).toBe(4_200_000);
      expect(event.active_workers).toBe(1);
    });

    it("getEvents returns a copy of all recorded events", () => {
      const orchestrator = new Orchestrator({ projectConfig: makeConfig("medium"), backend });

      orchestrator.recordEvent("session_started", "Start");
      orchestrator.recordEvent("goal_started", "Goal begins");
      orchestrator.recordEvent("task_dispatched", "Dispatching task");

      const events = orchestrator.getEvents();
      expect(events).toHaveLength(3);
      expect(events[0].event_type).toBe("session_started");
      expect(events[1].event_type).toBe("goal_started");
      expect(events[2].event_type).toBe("task_dispatched");

      // Should be a copy, not the internal array
      events.push(orchestrator.recordEvent("session_completed", "Done"));
      expect(orchestrator.getEvents()).toHaveLength(4);
    });
  });
});
