import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalTaskBackend } from "../src/local.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Goal, Task } from "@mnmal-ai/swarm-types";

const TEMP_DIR = join(__dirname, "__fixtures__", "task-backend-test");

describe("LocalTaskBackend", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Goal CRUD
  // ---------------------------------------------------------------------------

  describe("goals", () => {
    it("creates and retrieves a goal (round-trip)", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const goal: Goal = {
        id: "goal-1",
        description: "Implement user authentication",
        priority: 1,
        status: "pending",
        constraints: ["Must use OAuth2"],
        acceptance_criteria: ["Users can log in with GitHub"],
      };

      const id = await backend.createGoal(goal);
      expect(id).toBe("goal-1");

      const goals = await backend.getGoals();
      expect(goals).toHaveLength(1);
      expect(goals[0]).toEqual(goal);
    });

    it("retrieves multiple goals", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const goal1: Goal = {
        id: "goal-1",
        description: "First goal",
        priority: 1,
        status: "pending",
        constraints: [],
        acceptance_criteria: [],
      };
      const goal2: Goal = {
        id: "goal-2",
        description: "Second goal",
        priority: 2,
        status: "in_progress",
        constraints: ["Be fast"],
        acceptance_criteria: ["Under 100ms"],
      };

      await backend.createGoal(goal1);
      await backend.createGoal(goal2);

      const goals = await backend.getGoals();
      expect(goals).toHaveLength(2);
      expect(goals.map((g) => g.id)).toEqual(["goal-1", "goal-2"]);
    });

    it("returns empty array when no goals exist", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const goals = await backend.getGoals();
      expect(goals).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Task CRUD
  // ---------------------------------------------------------------------------

  describe("tasks", () => {
    it("creates and retrieves tasks for a specific goal", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const task: Task = {
        id: "task-1",
        goal_id: "goal-1",
        description: "Set up OAuth2 provider",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      const id = await backend.createTask(task);
      expect(id).toBe("task-1");

      const tasks = await backend.getTasks("goal-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual(task);
    });

    it("filters tasks by goal_id", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const task1: Task = {
        id: "task-1",
        goal_id: "goal-1",
        description: "Task for goal 1",
        intent: "implementation",
        status: "pending",
        order: 1,
      };
      const task2: Task = {
        id: "task-2",
        goal_id: "goal-2",
        description: "Task for goal 2",
        intent: "code-review",
        status: "pending",
        order: 1,
      };
      const task3: Task = {
        id: "task-3",
        goal_id: "goal-1",
        description: "Another task for goal 1",
        intent: "investigation",
        status: "pending",
        order: 2,
      };

      await backend.createTask(task1);
      await backend.createTask(task2);
      await backend.createTask(task3);

      const goal1Tasks = await backend.getTasks("goal-1");
      expect(goal1Tasks).toHaveLength(2);
      expect(goal1Tasks.map((t) => t.id)).toEqual(["task-1", "task-3"]);

      const goal2Tasks = await backend.getTasks("goal-2");
      expect(goal2Tasks).toHaveLength(1);
      expect(goal2Tasks[0].id).toBe("task-2");
    });

    it("returns empty array when no tasks exist for a goal", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const tasks = await backend.getTasks("nonexistent-goal");
      expect(tasks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Task updates
  // ---------------------------------------------------------------------------

  describe("updateTask", () => {
    it("updates task status", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const task: Task = {
        id: "task-1",
        goal_id: "goal-1",
        description: "Do something",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      await backend.createTask(task);
      await backend.updateTask("task-1", { status: "in_progress" });

      const tasks = await backend.getTasks("goal-1");
      expect(tasks[0].status).toBe("in_progress");
    });

    it("updates task result", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const task: Task = {
        id: "task-1",
        goal_id: "goal-1",
        description: "Do something",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      await backend.createTask(task);
      await backend.updateTask("task-1", {
        status: "completed",
        result: {
          output: "Task completed successfully",
          latency_ms: 1200,
          retry_count: 0,
        },
      });

      const tasks = await backend.getTasks("goal-1");
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].result).toBeDefined();
      expect(tasks[0].result!.output).toBe("Task completed successfully");
      expect(tasks[0].result!.latency_ms).toBe(1200);
    });

    it("throws when updating a nonexistent task", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      await expect(
        backend.updateTask("nonexistent", { status: "completed" })
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence across instances
  // ---------------------------------------------------------------------------

  describe("persistence", () => {
    it("persists goals across backend instances", async () => {
      const backend1 = new LocalTaskBackend(TEMP_DIR);
      await backend1.createGoal({
        id: "goal-persist",
        description: "Persisted goal",
        priority: 1,
        status: "pending",
        constraints: [],
        acceptance_criteria: ["Data survives restart"],
      });

      // Create a new instance pointing to the same directory
      const backend2 = new LocalTaskBackend(TEMP_DIR);
      const goals = await backend2.getGoals();
      expect(goals).toHaveLength(1);
      expect(goals[0].id).toBe("goal-persist");
      expect(goals[0].description).toBe("Persisted goal");
    });

    it("persists tasks across backend instances", async () => {
      const backend1 = new LocalTaskBackend(TEMP_DIR);
      await backend1.createTask({
        id: "task-persist",
        goal_id: "goal-1",
        description: "Persisted task",
        intent: "implementation",
        status: "pending",
        order: 1,
      });

      const backend2 = new LocalTaskBackend(TEMP_DIR);
      const tasks = await backend2.getTasks("goal-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("task-persist");
    });

    it("persists task updates across backend instances", async () => {
      const backend1 = new LocalTaskBackend(TEMP_DIR);
      await backend1.createTask({
        id: "task-update-persist",
        goal_id: "goal-1",
        description: "Task to update",
        intent: "implementation",
        status: "pending",
        order: 1,
      });
      await backend1.updateTask("task-update-persist", { status: "completed" });

      const backend2 = new LocalTaskBackend(TEMP_DIR);
      const tasks = await backend2.getTasks("goal-1");
      expect(tasks[0].status).toBe("completed");
    });
  });

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  describe("comments", () => {
    it("adds and retrieves comments for a task", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      await backend.createTask({
        id: "task-comments",
        goal_id: "goal-1",
        description: "Task with comments",
        intent: "implementation",
        status: "pending",
        order: 1,
      });

      await backend.addComment("task-comments", "First comment");
      await backend.addComment("task-comments", "Second comment");

      const comments = await backend.getComments("task-comments");
      expect(comments).toHaveLength(2);
      expect(comments[0]).toBe("First comment");
      expect(comments[1]).toBe("Second comment");
    });

    it("returns empty array when no comments exist", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      const comments = await backend.getComments("nonexistent-task");
      expect(comments).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Escalation
  // ---------------------------------------------------------------------------

  describe("escalation", () => {
    it("marks task as blocked and adds ESCALATED comment", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      await backend.createTask({
        id: "task-escalate",
        goal_id: "goal-1",
        description: "Task to escalate",
        intent: "implementation",
        status: "in_progress",
        order: 1,
      });

      await backend.escalate("task-escalate", "Requires human decision on architecture");

      // Status should be updated to blocked
      const tasks = await backend.getTasks("goal-1");
      expect(tasks[0].status).toBe("blocked");

      // An ESCALATED comment should have been added
      const comments = await backend.getComments("task-escalate");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("ESCALATED");
      expect(comments[0]).toContain("Requires human decision on architecture");
    });

    it("throws when escalating a nonexistent task", async () => {
      const backend = new LocalTaskBackend(TEMP_DIR);
      await expect(
        backend.escalate("nonexistent", "Some reason")
      ).rejects.toThrow();
    });
  });
});
