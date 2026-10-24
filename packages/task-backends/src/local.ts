import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentTaskStatus } from "@mnmal-ai/swarm-types";
import type { Goal, Task, TaskUpdate, TaskBackend } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// File names for JSON persistence
// ---------------------------------------------------------------------------

const GOALS_FILE = "goals.json";
const TASKS_FILE = "tasks.json";
const COMMENTS_FILE = "comments.json";

// ---------------------------------------------------------------------------
// LocalTaskBackend — JSON-file-based implementation of TaskBackend
// ---------------------------------------------------------------------------

/**
 * A task backend that persists goals, tasks, and comments as JSON files
 * in a local directory. Suitable for single-user / local development use.
 *
 * File layout:
 *   <storageDir>/goals.json    — Goal[]
 *   <storageDir>/tasks.json    — Task[]
 *   <storageDir>/comments.json — Record<taskId, string[]>
 */
export class LocalTaskBackend implements TaskBackend {
  private readonly storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    mkdirSync(storageDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  async getGoals(): Promise<Goal[]> {
    return this.readJson<Goal[]>(GOALS_FILE, []);
  }

  async createGoal(goal: Goal): Promise<string> {
    const goals = this.readJson<Goal[]>(GOALS_FILE, []);
    const existingIndex = goals.findIndex((g) => g.id === goal.id);
    if (existingIndex >= 0) {
      goals[existingIndex] = goal;
    } else {
      goals.push(goal);
    }
    this.writeJson(GOALS_FILE, goals);
    return goal.id;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async getTasks(goalId: string): Promise<Task[]> {
    const tasks = this.readTasks();
    return tasks.filter((t) => t.goal_id === goalId);
  }

  async getAllTasks(): Promise<Task[]> {
    return this.readTasks();
  }

  async getTaskById(taskId: string): Promise<Task | null> {
    const tasks = this.readTasks();
    return tasks.find((t) => t.id === taskId) ?? null;
  }

  async createTask(task: Task): Promise<string> {
    const tasks = this.readTasks();
    const existingIndex = tasks.findIndex((t) => t.id === task.id);
    if (existingIndex >= 0) {
      tasks[existingIndex] = task;
    } else {
      tasks.push(task);
    }
    this.writeJson(TASKS_FILE, tasks);
    return task.id;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<void> {
    const tasks = this.readTasks();
    const index = tasks.findIndex((t) => t.id === taskId);

    if (index === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (update.status !== undefined) {
      tasks[index].status = update.status;
    }
    if (update.result !== undefined) {
      tasks[index].result = update.result;
    }
    if (update.description !== undefined) {
      tasks[index].description = update.description;
    }

    this.writeJson(TASKS_FILE, tasks);
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  async addComment(taskId: string, comment: string): Promise<void> {
    const allComments = this.readJson<Record<string, string[]>>(COMMENTS_FILE, {});
    if (!allComments[taskId]) {
      allComments[taskId] = [];
    }
    allComments[taskId].push(comment);
    this.writeJson(COMMENTS_FILE, allComments);
  }

  /**
   * Retrieve all comments for a given task.
   * Not part of the TaskBackend interface, but useful for local inspection.
   */
  async getComments(taskId: string): Promise<string[]> {
    const allComments = this.readJson<Record<string, string[]>>(COMMENTS_FILE, {});
    return allComments[taskId] ?? [];
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  async escalate(taskId: string, reason: string): Promise<void> {
    // Update the task status to "blocked"
    await this.updateTask(taskId, { status: "blocked" });

    // Add an ESCALATED comment with the reason
    await this.addComment(taskId, `ESCALATED: ${reason}`);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private filePath(filename: string): string {
    return join(this.storageDir, filename);
  }

  private readJson<T>(filename: string, fallback: T): T {
    const path = this.filePath(filename);
    if (!existsSync(path)) {
      return fallback;
    }
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  }

  /** tasks.json, with any status saved under a pre-token-budget name read
   *  as its current one (and written back that way on the next save). */
  private readTasks(): Task[] {
    return this.readJson<Task[]>(TASKS_FILE, []).map((t) => ({ ...t, status: currentTaskStatus(t.status) }));
  }

  private writeJson(filename: string, data: unknown): void {
    const path = this.filePath(filename);
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }
}
