/**
 * Integration test for the live-repo commit path inside `_dispatchFlat`.
 *
 * Bug context: `commitLiveRepo` was first added to `_dispatchWithDAG` only.
 * Tasks WITHOUT explicit `dependsOn`, serialization constraints, or shared
 * files take the flat path — and the flat path had no commit hook. A real
 * incident: swarm v0.28.0 ran for 2 hours, approved 15 task verdicts, and
 * made ZERO git commits because every task hit `_dispatchFlat`.
 *
 * This test drives the public `dispatchParallel` with no-deps tasks (so the
 * router selects `_dispatchFlat`) and asserts a commit landed per approved
 * task.
 *
 * IMPORTANT: every Orchestrator constructed here gets `repoRoot` pointing
 * at a temp dir so `commitLiveRepo` never touches the swarm repo itself.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../src/orchestrator/index.js";
import type {
  SwarmOversightRunResult,
  ProjectConfig,
  Task,
} from "@mnmal-ai/swarm-types";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goal_id: overrides.goal_id ?? "goal-1",
    title: overrides.title ?? id,
    description: overrides.description ?? `do ${id}`,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 1,
    intent: overrides.intent ?? "implementation",
    files_to_create: overrides.files_to_create ?? [],
    files_to_modify: overrides.files_to_modify ?? [],
  } as Task;
}

function makeResult(verdict: "approved" | "rejected" | "skipped"): SwarmOversightRunResult {
  return {
    output: "ok",
    tokensUsed: { input: 0, output: 0 },
    latencyMs: 0,
    tokenLimitExceeded: false,
    oversight: {
      verdict,
      rejectionReasons: [],
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
    },
  } as SwarmOversightRunResult;
}

function makeOrchestrator(repoRoot: string): Orchestrator {
  return new Orchestrator({
    projectConfig: {
      project: "test",
      swarm_path: ".swarm",
      trust_level: "low",
      task_backend: "local",
      models: {
        worker: "test",
        reviewer: "test",
        arbiter: "test",
        provider: "anthropic",
      },
      backends: {},
      base_branch: "main",
      isolation: null,
      concurrency: {
        max_workers: 1,
        max_tokens_per_session: 100_000_000,
        max_tokens_per_task: 10_000_000,
        max_tokens_per_goal: 50_000_000,
      },
    } as unknown as ProjectConfig,
    backend: { run: async () => ({ output: "", tokenUsage: {} }) } as never,
    repoRoot,
  });
}

describe("Orchestrator._dispatchFlat — live-repo commit path", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "swarm-flat-commit-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@test.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);
    await writeFile(join(repoDir, "README.md"), "# initial\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "initial"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("commits a per-task commit for each approved no-deps task", async () => {
    const orch = makeOrchestrator(repoDir);

    const tasks = [makeTask("t1", { title: "task one" }), makeTask("t2", { title: "task two" })];

    // Mutate a different file for each task so each one has staged content.
    // Workers normally mutate the working tree directly; we simulate that here.
    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    const result = await orch.dispatchParallel({
      tasks,
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: repoDir,
      executeTask,
    });

    expect(result.completed.map((c) => c.task.id).sort()).toEqual(["t1", "t2"]);

    // Two new commits since the initial "initial" commit
    const log = await git(repoDir, ["log", "--format=%s"]);
    const subjects = log.split("\n").filter(Boolean);
    expect(subjects).toContain("swarm(t1): task one");
    expect(subjects).toContain("swarm(t2): task two");
    expect(subjects[subjects.length - 1]).toBe("initial");
  });

  it("does NOT commit when verdict is rejected (only approved/skipped)", async () => {
    const orch = makeOrchestrator(repoDir);

    const tasks = [makeTask("rej", { title: "rejected task" })];

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// rejected\n`);
      return makeResult("rejected");
    };

    const before = await git(repoDir, ["rev-parse", "HEAD"]);
    await orch.dispatchParallel({
      tasks,
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: repoDir,
      executeTask,
    });
    const after = await git(repoDir, ["rev-parse", "HEAD"]);

    expect(after).toBe(before);
  });

  it("commits skipped verdicts (no-work tasks still get a marker commit if dirty)", async () => {
    const orch = makeOrchestrator(repoDir);
    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// skip-marker\n`);
      return makeResult("skipped");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("sk", { title: "skipped task" })],
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: repoDir,
      executeTask,
    });

    const log = await git(repoDir, ["log", "--format=%s", "-1"]);
    expect(log).toBe("swarm(sk): skipped task");
  });

  it("invokes onTaskComplete after committing in the live-repo path", async () => {
    const orch = makeOrchestrator(repoDir);
    const completedTasks: string[] = [];

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("t1"), makeTask("t2")],
      goal: { id: "goal-1", description: "g", priority: 1, status: "pending" } as never,
      project: "test",
      workingDirectory: repoDir,
      executeTask,
      onTaskComplete: async (task) => {
        completedTasks.push(task.id);
      },
    });

    expect(completedTasks.sort()).toEqual(["t1", "t2"]);
  });
});
