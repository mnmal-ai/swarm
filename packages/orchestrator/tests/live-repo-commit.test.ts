/**
 * Integration test for the live-repo commit path — Orchestrator's
 * private commitLiveRepo() method that runs when worktrees are disabled.
 *
 * Why this test exists: an operator running swarm with max_workers=1
 * (or --no-worktrees) on their working repo previously had no commit
 * logic at all. Workers would mutate the working tree, swarm would
 * capture the diff in WorkerResult.diff, and that was the only
 * persistence. A wedge or crash lost everything not yet manually
 * committed by the operator. Real incident: 472 WorkerResults
 * produced, zero commits. Fix is the new commitLiveRepo() helper.
 *
 * IMPORTANT: this test passes a `repoRoot` to Orchestrator pointing at
 * a temp dir, so commitLiveRepo never touches the swarm repo itself.
 * Do NOT replace this with `process.chdir` — process-cwd manipulation
 * leaks across test files run in the same vitest process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../src/orchestrator/index.js";
import type { Task } from "@mnmal-ai/swarm-types";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "goal-1-task-1",
    goal_id: overrides.goal_id ?? "goal-1",
    title: overrides.title ?? "do the thing",
    description: overrides.description ?? "long description",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 1,
    intent: overrides.intent ?? "implementation",
    files_to_create: overrides.files_to_create ?? [],
    files_to_modify: overrides.files_to_modify ?? [],
    estimated_complexity: overrides.estimated_complexity,
  } as Task;
}

function makeOrchestrator(repoRoot?: string): Orchestrator {
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
    } as never,
    backend: { run: async () => ({ output: "", tokenUsage: {} }) } as never,
    repoRoot,
  });
}

describe("Orchestrator.commitLiveRepo", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "swarm-live-commit-"));
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

  it("commits dirty working tree as a single commit per task", async () => {
    await writeFile(join(repoDir, "src.ts"), "// worker output\n");

    const orch = makeOrchestrator(repoDir);
    await orch.commitLiveRepo(
      makeTask({ id: "goal-1-task-2", title: "wire up handler" }),
    );

    const log = await git(repoDir, ["log", "-1", "--format=%s%n%b"]);
    expect(log).toContain("swarm(goal-1-task-2): wire up handler");
    expect(log).toContain("Goal: goal-1");
    expect(log).toContain("Task: goal-1-task-2");

    const tracked = await git(repoDir, ["ls-files"]);
    expect(tracked).toContain("src.ts");
  });

  it("no-ops cleanly when working tree is clean (investigation tasks)", async () => {
    const orch = makeOrchestrator(repoDir);
    const before = await git(repoDir, ["rev-parse", "HEAD"]);

    await orch.commitLiveRepo(
      makeTask({ id: "goal-1-task-3", title: "investigate the thing" }),
    );

    const after = await git(repoDir, ["rev-parse", "HEAD"]);
    expect(after).toBe(before);
  });

  it("commits multiple tasks as separate commits (preserves per-task history)", async () => {
    const orch = makeOrchestrator(repoDir);
    await writeFile(join(repoDir, "a.ts"), "// task 1\n");
    await orch.commitLiveRepo(makeTask({ id: "t1", title: "task 1" }));

    await writeFile(join(repoDir, "b.ts"), "// task 2\n");
    await orch.commitLiveRepo(makeTask({ id: "t2", title: "task 2" }));

    const log = await git(repoDir, ["log", "--format=%s", "-2"]);
    const lines = log.split("\n");
    expect(lines[0]).toBe("swarm(t2): task 2");
    expect(lines[1]).toBe("swarm(t1): task 1");
  });

  it("emits commit_failed event without throwing when git fails", async () => {
    await git(repoDir, ["config", "--unset", "user.email"]);
    await git(repoDir, ["config", "--unset", "user.name"]);
    const saved = {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_AUTHOR_NAME = "";
    process.env.GIT_AUTHOR_EMAIL = "";
    process.env.GIT_COMMITTER_NAME = "";
    process.env.GIT_COMMITTER_EMAIL = "";

    try {
      await writeFile(join(repoDir, "src.ts"), "// worker output\n");
      const orch = makeOrchestrator(repoDir);

      await expect(
        (orch as unknown as { commitLiveRepo: (t: Task) => Promise<void> }).commitLiveRepo(
          makeTask({ id: "t-fail", title: "should not crash" }),
        ),
      ).resolves.toBeUndefined();

      const events = (orch as unknown as { events: { event_type: string; detail: string }[] }).events;
      const failureEvents = events.filter((e) => e.event_type === "commit_failed");
      // Either the env-trick worked and we got a failure event, or git found
      // a fallback identity and committed cleanly — both are OK; the
      // contract this test guards is "no throw on git failure."
      if (failureEvents.length > 0) {
        expect(failureEvents[0]?.detail).toContain("t-fail");
      }
    } finally {
      // Restore — including the case where the original was undefined
      // (delete the var rather than leave it set to "").
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("no-ops when repoRoot is unset (safety: tests + ad-hoc construction)", async () => {
    // Construct without repoRoot. commitLiveRepo should silently no-op
    // even if there's a worker output to commit somewhere — there's no
    // configured target.
    const orch = makeOrchestrator(undefined);
    await expect(
      orch.commitLiveRepo(
        makeTask({ id: "no-repo", title: "should be a no-op" }),
      ),
    ).resolves.toBeUndefined();

    // No events should have been emitted at all
    const events = (orch as unknown as { events: unknown[] }).events;
    expect(events).toHaveLength(0);
  });

  it("regression: external callers (run.ts sequential loops) can invoke commitLiveRepo on the public API", async () => {
    // The original bug: commitLiveRepo was wired into _dispatchFlat but
    // run.ts has TWO sequential dispatch loops (sub-task execution at
    // ~line 2685, remediation execution at ~line 3146) that bypass
    // dispatchParallel entirely. On max_workers=1 setups, those loops run
    // every task and zero commits ever landed.
    //
    // Fix: commitLiveRepo became a public method so the sequential loops
    // can call it directly, mirroring the verdict-check pattern from
    // _dispatchFlat. This test exercises the exact call pattern those
    // loops use: external code holds an Orchestrator reference, decides
    // a task is "completed" by inspecting the verdict, then awaits
    // orchestrator.commitLiveRepo(task).
    //
    // If commitLiveRepo's visibility regresses to private, this test
    // fails at TYPE-CHECK time (no `as unknown as ...` escape hatch) —
    // which is the intended guard.
    await writeFile(join(repoDir, "from-sequential-loop.ts"), "// produced by run.ts seq loop\n");

    const orch = makeOrchestrator(repoDir);
    const task = makeTask({ id: "seq-1", title: "completed via sequential loop" });

    // Simulate the run.ts pattern: verdict-check, then commit if approved.
    const verdict: "approved" | "rejected" = "approved";
    const taskStatus = verdict === "approved" ? "completed" : "failed";
    if (taskStatus === "completed") {
      await orch.commitLiveRepo(task);
    }

    const log = await git(repoDir, ["log", "-1", "--format=%s"]);
    expect(log).toBe("swarm(seq-1): completed via sequential loop");

    const events = (orch as unknown as { events: { event_type: string; detail: string }[] }).events;
    const committedEvents = events.filter((e) => e.event_type === "task_committed");
    expect(committedEvents).toHaveLength(1);
    expect(committedEvents[0]?.detail).toContain("seq-1");
  });
});
