/**
 * Regression: the 2026-05-30 swarm-on-swarm run with `stack_prs:true` and
 * `branch_prefix:"swarm-worker/"` produced 123 commits across 8 goals — all
 * of which landed on whatever branch the orchestrator process started on
 * (in that run, `ci/pr-review-oauth`), not on the `swarm-worker/goal-N`
 * branches that the CLI had pre-materialized via materializeGoalBranch.
 *
 * Root cause: `commitLiveRepo` did `git add -A && git commit` without ever
 * honoring the current goal's branch context, so every goal's diff piled
 * onto a single non-stacked branch.
 *
 * Fix: per-call `goalBranch` opt on `dispatchParallel` + `commitLiveRepo`.
 * No ambient state, no setter to forget. The CLI passes `currentGoalBranch`
 * into each dispatchParallel call and into each direct commitLiveRepo
 * call. When `goalBranch` is provided, commitLiveRepo checks current HEAD
 * and `git checkout`s the goal branch before committing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../src/orchestrator/index.js";
import { WorktreeManager } from "../src/worktree/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type {
  SwarmOversightRunResult,
  Goal,
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

/**
 * `as unknown as Goal` — bypass type-checking only for the fields the
 * orchestrator's live-repo path doesn't read. `as never` (used elsewhere
 * in this repo's test suite) is unsound — if Goal's required fields
 * shift, `as never` silently masks the test from compiler-flagged
 * breakage. `as unknown as Goal` at least keeps the eventual consumer's
 * shape explicit at the call site.
 */
function makeGoal(id: string, priority = 1): Goal {
  return { id, description: `goal ${id}`, priority, status: "pending" } as unknown as Goal;
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

describe("Orchestrator — live-repo commits land on the configured goal branch", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "swarm-stack-commit-branch-"));
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

  it("commits land on the configured goal branch, not on the orchestrator's starting HEAD", async () => {
    // Pre-create the goal branch (mimicking what CLI's materializeGoalBranch
    // does after computing goalBranchName from the prefix). Stay on `main`
    // when the worker runs so we can prove the orchestrator switches HEAD
    // before committing.
    await git(repoDir, ["branch", "swarm-worker/goal-1", "main"]);
    expect(await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("t1", { title: "task one", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      // Per-call branch context — the CLI passes `currentGoalBranch` here.
      goalBranch: "swarm-worker/goal-1",
      executeTask,
    });

    // HEAD should now be on swarm-worker/goal-1 because the commit landed there.
    expect(await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("swarm-worker/goal-1");

    // The commit should exist on swarm-worker/goal-1 and NOT on main.
    const goalLog = await git(repoDir, ["log", "--format=%s", "swarm-worker/goal-1"]);
    expect(goalLog.split("\n")).toContain("swarm(t1): task one");

    const mainLog = await git(repoDir, ["log", "--format=%s", "main"]);
    expect(mainLog.split("\n")).not.toContain("swarm(t1): task one");
  });

  it("stacks: a second goal's commits land on its own branch (off the previous goal's branch), not on the first goal's branch", async () => {
    await git(repoDir, ["branch", "swarm-worker/goal-1", "main"]);
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("t1", { title: "task one", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/goal-1",
      executeTask,
    });

    // Goal-2 stacks on goal-1
    await git(repoDir, ["branch", "swarm-worker/goal-2", "swarm-worker/goal-1"]);

    await orch.dispatchParallel({
      tasks: [makeTask("t2", { title: "task two", goal_id: "goal-2" })],
      goal: makeGoal("goal-2", 2),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/goal-2",
      executeTask,
    });

    const goal1Log = (await git(repoDir, ["log", "--format=%s", "swarm-worker/goal-1"])).split("\n");
    const goal2Log = (await git(repoDir, ["log", "--format=%s", "swarm-worker/goal-2"])).split("\n");

    expect(goal1Log).toContain("swarm(t1): task one");
    expect(goal1Log).not.toContain("swarm(t2): task two");

    expect(goal2Log).toContain("swarm(t2): task two");
    expect(goal2Log).toContain("swarm(t1): task one"); // inherited from base
  });

  it("falls back to current HEAD when no goal branch is configured (stack mode off)", async () => {
    // Default behavior preserved: when goalBranch is omitted (or null),
    // commitLiveRepo lands on whatever HEAD is — identical to pre-fix
    // behavior. This is the non-stack-PR mode, where a single session
    // branch or the user's checked-out branch accumulates all goal work.
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("solo", { title: "solo task", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      // goalBranch deliberately omitted
      executeTask,
    });

    // Still on main — orchestrator didn't try to switch.
    expect(await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    const log = (await git(repoDir, ["log", "--format=%s"])).split("\n");
    expect(log).toContain("swarm(solo): solo task");
  });

  it("goalBranch=null is equivalent to omitting it (stack mode off mid-session)", async () => {
    // After a non-success goal, the CLI sets currentGoalBranch=null in
    // its main loop. Passing that null down through dispatchParallel
    // opts must mean "no branch switch" — same as omitting the opt.
    await git(repoDir, ["branch", "swarm-worker/goal-1", "main"]);
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("after-reset", { title: "after reset", goal_id: "goal-2" })],
      goal: makeGoal("goal-2", 2),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: null,
      executeTask,
    });

    expect(await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  // ---------------------------------------------------------------------
  // Checkout-failure path — Major coverage gap flagged by the reviewer
  // ---------------------------------------------------------------------

  it("stashes worker output on checkout failure so the next task's commit doesn't inherit stranded files", async () => {
    // Configure a goal branch that was never created — `git switch` throws.
    // The safety path inside commitLiveRepo must:
    //   1. Skip the commit (no silent landing on the wrong branch).
    //   2. Leave HEAD where it was.
    //   3. Stash the worker's output so it doesn't bleed into the NEXT
    //      task's `git add -A` (the bleed a review flagged).
    //      The stash is recoverable via `git stash list` + `git stash
    //      apply` — operator-inspectable, not silently destroyed.
    //   4. Emit a commit_failed event whose detail names the failed
    //      branch AND records that the worker output was stashed.
    const orch = makeOrchestrator(repoDir);

    const recordedEvents: Array<{ type: string; detail: string }> = [];
    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("ghost", { title: "ghost task", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/this-branch-does-not-exist",
      executeTask,
    });

    // (1) HEAD didn't move — checkout failed.
    expect(await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

    // (2) The commit did NOT land on main (no silent fallback to wrong branch).
    const mainLog = (await git(repoDir, ["log", "--format=%s"])).split("\n");
    expect(mainLog).not.toContain("swarm(ghost): ghost task");

    // (3) Worker output is no longer in the working tree — it was stashed
    //     to prevent bleed into the next task's commit. The working tree
    //     is clean so subsequent commitLiveRepo calls are unaffected.
    expect(existsSync(join(repoDir, "ghost.ts"))).toBe(false);
    expect((await git(repoDir, ["status", "--porcelain"])).length).toBe(0);

    // (3a) The stash is recoverable: `git stash list` includes a labeled
    //      entry naming the task id and failed branch so the operator
    //      can inspect or recover the worker's output.
    const stashList = await git(repoDir, ["stash", "list"]);
    expect(stashList).toMatch(/failed-checkout salvage for task "ghost"/);
    expect(stashList).toMatch(/swarm-worker\/this-branch-does-not-exist/);

    // (4) commit_failed event recorded with the failed-branch name AND
    //     the "stashed" flag (instead of the previous "dirty working
    //     tree" flag) so dashboards / operators can find the stash.
    for (const e of orch.getEvents()) {
      recordedEvents.push({ type: e.event_type, detail: e.detail ?? "" });
    }
    const failEvents = recordedEvents.filter((e) => e.type === "commit_failed");
    expect(failEvents.length).toBeGreaterThan(0);
    expect(failEvents[0]!.detail).toMatch(/could not checkout swarm-worker\/this-branch-does-not-exist/);
    expect(failEvents[0]!.detail).toMatch(/worker output stashed/);
  });

  it("a subsequent task's commit does NOT include files from a previous task whose checkout failed (bleed prevention)", async () => {
    // The exact regression the round-3 review caught: t1's checkout
    // fails and its files are stranded in the tree. t2's checkout
    // succeeds and `git add -A` would otherwise stage t1.ts + t2.ts
    // into a single commit titled `swarm(t2): ...`. With the stash
    // fix in place, t1.ts is no longer in the tree when t2 runs, so
    // t2's commit contains only t2.ts.
    await git(repoDir, ["branch", "swarm-worker/goal-good", "main"]);
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    // Task 1: goal branch does NOT exist, checkout fails, stash kicks in.
    await orch.dispatchParallel({
      tasks: [makeTask("t1", { title: "t1", goal_id: "goal-bleed-1" })],
      goal: makeGoal("goal-bleed-1"),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/missing-branch",
      executeTask,
    });

    expect(existsSync(join(repoDir, "t1.ts"))).toBe(false);
    expect(orch.getCommitsForGoal("goal-bleed-1")).toBe(0);

    // Task 2: goal branch DOES exist; the commit should contain ONLY t2's
    // file. If the bleed fix were missing, `git add -A` would stage both
    // t1.ts and t2.ts and the commit message would falsely claim
    // ownership.
    await orch.dispatchParallel({
      tasks: [makeTask("t2", { title: "t2", goal_id: "goal-bleed-2" })],
      goal: makeGoal("goal-bleed-2", 2),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/goal-good",
      executeTask,
    });

    // The committed diff for t2 contains only t2.ts, no t1.ts.
    const lastCommitFiles = (await git(repoDir, [
      "show",
      "--name-only",
      "--format=",
      "swarm-worker/goal-good",
    ])).split("\n").filter(Boolean);
    expect(lastCommitFiles).toContain("t2.ts");
    expect(lastCommitFiles).not.toContain("t1.ts");

    // Counter reflects the truth: t2's goal got 1 commit, t1's got 0.
    expect(orch.getCommitsForGoal("goal-bleed-1")).toBe(0);
    expect(orch.getCommitsForGoal("goal-bleed-2")).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Per-goal commit counter — stateless, keyed by task.goal_id
  // ---------------------------------------------------------------------

  it("getCommitsForGoal() returns 0 for an unknown goal on a fresh orchestrator", () => {
    const orch = makeOrchestrator(repoDir);
    expect(orch.getCommitsForGoal("goal-never-seen")).toBe(0);
  });

  it("increments per-goal-id after a successful commitLiveRepo", async () => {
    const orch = makeOrchestrator(repoDir);
    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };
    await orch.dispatchParallel({
      tasks: [makeTask("t1", { title: "one", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      executeTask,
    });
    expect(orch.getCommitsForGoal("goal-1")).toBe(1);
  });

  it("stays at 0 when commitLiveRepo no-ops on a clean working tree (investigation task)", async () => {
    // Worker runs but writes NO files — commitLiveRepo's "nothing staged"
    // early return path. The counter must not lie about commits that
    // weren't actually produced.
    const orch = makeOrchestrator(repoDir);
    const executeTask = async (_task: Task): Promise<SwarmOversightRunResult> => {
      // Deliberately no file writes.
      return makeResult("approved");
    };
    await orch.dispatchParallel({
      tasks: [makeTask("noop", { title: "noop", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      executeTask,
    });
    expect(orch.getCommitsForGoal("goal-1")).toBe(0);
  });

  it("stays at 0 when the goal-branch checkout fails (no commit lands on the wrong branch)", async () => {
    // Counter integrity: even if the worker wrote output, the
    // checkout-failure path returns early *before* the commit. The
    // counter mustn't increment for commits that didn't actually land.
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };
    await orch.dispatchParallel({
      tasks: [makeTask("orphan", { title: "orphan", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/this-branch-does-not-exist",
      executeTask,
    });
    expect(orch.getCommitsForGoal("goal-1")).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Worktree-mode counter coverage (a major regression a review
  // flagged): `commitLiveRepo` isn't called in worktree mode —
  // commits land via `worktreeManager.commitChanges` + `merge`. Without
  // counting in BOTH paths, the ghost-completion predicate would false-
  // positive on every worktree-mode goal regardless of how much work
  // actually landed.
  // ---------------------------------------------------------------------

  it("increments commitsByGoal in worktree mode after commitChanges + merge succeed", async () => {
    const orch = makeOrchestrator(repoDir);
    const eventBus = new SwarmEventBus();
    const worktreeManager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const executeTask = async (task: Task, workingDir: string): Promise<SwarmOversightRunResult> => {
      // Worker writes a file into the worktree (not the live repo).
      await writeFile(join(workingDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [
        makeTask("t1", { title: "task one", goal_id: "goal-wt-1" }),
        makeTask("t2", { title: "task two", goal_id: "goal-wt-1" }),
      ],
      goal: makeGoal("goal-wt-1"),
      project: "test",
      workingDirectory: repoDir,
      worktreeManager,
      executeTask,
    });

    // Both worktree-mode tasks produced real commits — counter must
    // reflect that, not stay at 0 the way the previous draft did.
    expect(orch.getCommitsForGoal("goal-wt-1")).toBe(2);
  });

  it("stays at 0 in worktree mode when commitChanges throws on a clean worktree (investigation task)", async () => {
    // Worker runs in the worktree but writes nothing — `commitChanges`
    // throws "no changes to commit". The merge then no-ops. From the
    // operator's perspective, no work landed on the goal branch, so the
    // counter must stay at 0 (and ghost-completion will correctly fire).
    const orch = makeOrchestrator(repoDir);
    const eventBus = new SwarmEventBus();
    const worktreeManager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const executeTask = async (_task: Task, _workingDir: string): Promise<SwarmOversightRunResult> => {
      // No file writes.
      return makeResult("approved");
    };

    await orch.dispatchParallel({
      tasks: [makeTask("noop", { title: "noop", goal_id: "goal-wt-inv" })],
      goal: makeGoal("goal-wt-inv"),
      project: "test",
      workingDirectory: repoDir,
      worktreeManager,
      executeTask,
    });

    expect(orch.getCommitsForGoal("goal-wt-inv")).toBe(0);
  });

  it("tracks counts independently per goal_id (no cross-goal contamination)", async () => {
    // Each goal gets its own count. The map-keyed design means
    // observing goal-1's count never tells us anything about goal-2.
    await git(repoDir, ["branch", "swarm-worker/goal-1", "main"]);
    const orch = makeOrchestrator(repoDir);

    const executeTask = async (task: Task): Promise<SwarmOversightRunResult> => {
      await writeFile(join(repoDir, `${task.id}.ts`), `// ${task.id}\n`);
      return makeResult("approved");
    };
    await orch.dispatchParallel({
      tasks: [makeTask("g1-t1", { title: "g1 t1", goal_id: "goal-1" })],
      goal: makeGoal("goal-1"),
      project: "test",
      workingDirectory: repoDir,
      goalBranch: "swarm-worker/goal-1",
      executeTask,
    });
    expect(orch.getCommitsForGoal("goal-1")).toBe(1);

    // Advance to the next goal — the new goal's count starts at 0
    // independently of goal-1's count, no reset call needed.
    await git(repoDir, ["branch", "swarm-worker/goal-2", "swarm-worker/goal-1"]);
    expect(orch.getCommitsForGoal("goal-2")).toBe(0);
    expect(orch.getCommitsForGoal("goal-1")).toBe(1); // unaffected
  });
});
