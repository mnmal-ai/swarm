/**
 * Regression: a real `swarm run` with `max_workers: 1` + `remote_pr` +
 * `stack_prs: true` completed its goal, committed every task onto the work
 * repo's local `main`, never created the goal branch, and pushed nothing —
 * with no message. With one worker there are no worktrees, so the goal loop
 * takes the sequential path; the goal branch was only ever materialized on the
 * parallel (worktree) path, so `currentGoalBranch` stayed null, commitLiveRepo
 * committed on HEAD, and the goal was never queued for the push+PR step.
 *
 * These tests drive the goal loop's own seams (prepareGoalDispatch →
 * Orchestrator.commitLiveRepo → recordGoalOutcomeForStack → runStackedPrPushStep
 * with a real SourceControlManager) against a temp git repo. `git push` goes
 * to a local bare repo and `gh` is a stub script on PATH — no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm, readFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator, SourceControlManager } from "@mnmal-ai/swarm-orchestrator";
import type { ProjectConfig, Task } from "@mnmal-ai/swarm-types";
import {
  prepareGoalDispatch,
  createGoalStackLedger,
  recordGoalOutcomeForStack,
  whereGoalCommitsLanded,
} from "../src/cli/goal-stack.js";
import { runStackedPrPushStep } from "../src/cli/run.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

const PREFIX = "fix/swarm";

function makeOrchestrator(repoRoot: string): Orchestrator {
  return new Orchestrator({
    projectConfig: {
      project: "test",
      swarm_path: ".swarm",
      trust_level: "low",
      task_backend: "local",
      models: { worker: "test", reviewer: "test", arbiter: "test", provider: "anthropic" },
      backends: {},
      base_branch: "main",
      isolation: null,
      concurrency: { max_workers: 1, max_tokens_per_session: 100_000_000, max_tokens_per_task: 10_000_000, max_tokens_per_goal: 50_000_000 },
      source_control: { strategy: "remote_pr", stack_prs: true, branch_prefix: PREFIX },
    } as unknown as ProjectConfig,
    backend: { run: async () => ({ output: "", tokenUsage: {} }) } as never,
    repoRoot,
  });
}

function makeTask(id: string, goalId: string): Task {
  return {
    id,
    goal_id: goalId,
    title: `task ${id}`,
    description: `do ${id}`,
    status: "pending",
    priority: 1,
    intent: "implementation",
  } as unknown as Task;
}

describe("single-worker stacked PRs (max_workers: 1, remote_pr, stack_prs)", () => {
  let root: string;
  let repo: string;
  let remote: string;
  let ghLog: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "swarm-single-worker-stack-"));
    repo = join(root, "work");
    remote = join(root, "origin.git");
    ghLog = join(root, "gh.log");
    await mkdir(repo);
    await git(root, ["init", "--bare", "-b", "main", remote]);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "# initial\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-u", "origin", "main"]);

    // Stub `gh`: record its argv, print a PR URL.
    const bin = join(root, "bin");
    await mkdir(bin);
    const gh = join(bin, "gh");
    await writeFile(
      gh,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\necho "https://github.com/test/repo/pull/7"\n`,
    );
    await chmod(gh, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    delete process.env.SWARM_GOAL_BRANCH;
    delete process.env.SWARM_BASE_BRANCH;
    await rm(root, { recursive: true, force: true });
  });

  /** One goal through the loop exactly as run.ts drives it. */
  async function runGoal(
    orch: Orchestrator,
    ledger: ReturnType<typeof createGoalStackLedger>,
    goalId: string,
    files: string[],
  ) {
    const plan = await prepareGoalDispatch({
      maxConcurrency: orch.getMaxConcurrency(),
      hasWorktreeManager: false, // run.ts: worktrees need max_workers > 1
      stackPRs: true,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId,
      projectBaseBranch: "main",
      configuredBaseBranch: "main",
      previousGoalBranch: ledger.previousGoalBranch,
    });
    expect(plan.parallel).toBe(false);

    // The worker edits the live repo; the sequential loop then commits.
    for (const [i, f] of files.entries()) {
      await writeFile(join(repo, f), `${goalId} ${f}\n`);
      await orch.commitLiveRepo(makeTask(`${goalId}-t${i + 1}`, goalId), { goalBranch: plan.goalBranch });
    }

    await recordGoalOutcomeForStack(ledger, {
      stackPRs: true,
      goalBranch: plan.goalBranch,
      goalStatus: "completed",
      goal: { goalId, goalDescription: `Goal ${goalId}` },
      commitCount: orch.getCommitsForGoal(goalId),
      commitsOn: () => whereGoalCommitsLanded(plan, repo),
    });
    return plan;
  }

  it("commits the goal's tasks onto its goal branch, not the base branch", async () => {
    const orch = makeOrchestrator(repo);
    expect(orch.getMaxConcurrency()).toBe(1);
    const ledger = createGoalStackLedger();
    const mainBefore = await git(repo, ["rev-parse", "main"]);

    const plan = await runGoal(orch, ledger, "trello-Ab12Cd34", ["a.txt", "b.txt"]);

    const goalBranch = `${PREFIX}/goal-trello-ab12cd34`;
    expect(plan.goalBranch).toBe(goalBranch);
    // main untouched; both commits on the goal branch, created from main.
    expect(await git(repo, ["rev-parse", "main"])).toBe(mainBefore);
    expect(await git(repo, ["rev-list", "--count", `main..${goalBranch}`])).toBe("2");
    expect(await git(repo, ["merge-base", "main", goalBranch])).toBe(mainBefore);
    expect(orch.getCommitsForGoal("trello-Ab12Cd34")).toBe(2);
    // …and the goal is queued for the end-of-run push step.
    expect(ledger.completed.map((g) => g.goalId)).toEqual(["trello-Ab12Cd34"]);
  });

  it("the end-of-run step pushes the goal branch and opens its PR", async () => {
    const orch = makeOrchestrator(repo);
    const ledger = createGoalStackLedger();
    await runGoal(orch, ledger, "trello-Ab12Cd34", ["a.txt"]);

    const result = await runStackedPrPushStep(
      () =>
        new SourceControlManager(repo, {
          strategy: "remote_pr",
          stack_prs: true,
          base_branch: "main",
          branch_prefix: PREFIX,
        }),
      ledger.completed,
      { stackPRs: true, strategy: "remote_pr", sessionId: "sess-1234abcd" },
    );

    const goalBranch = `${PREFIX}/goal-trello-ab12cd34`;
    expect(result?.goals).toEqual([
      { goalId: "trello-Ab12Cd34", branch: goalBranch, base: "main", pushed: true, prUrl: "https://github.com/test/repo/pull/7" },
    ]);
    // The pushed branch carries the task commit.
    expect(await git(remote, ["rev-parse", goalBranch])).toBe(await git(repo, ["rev-parse", goalBranch]));
    expect(await git(remote, ["rev-list", "--count", `main..${goalBranch}`])).toBe("1");
    const ghCalls = await readFile(ghLog, "utf-8");
    expect(ghCalls).toContain("--base main");
    expect(ghCalls).toContain(`--head ${goalBranch}`);
  });

  it("stacks a second goal on the first goal's branch", async () => {
    const orch = makeOrchestrator(repo);
    const ledger = createGoalStackLedger();
    await runGoal(orch, ledger, "g1", ["one.txt"]);
    const plan2 = await runGoal(orch, ledger, "g2", ["two.txt"]);

    expect(plan2.stackBase).toBe(`${PREFIX}/goal-g1`);
    expect(await git(repo, ["rev-list", "--count", `${PREFIX}/goal-g1..${PREFIX}/goal-g2`])).toBe("1");
    expect(await git(repo, ["rev-list", "--count", `main..${PREFIX}/goal-g1`])).toBe("1");
    expect(ledger.completed.map((g) => g.goalId)).toEqual(["g1", "g2"]);
  });

  it("starts a goal from its stack base even when HEAD is elsewhere", async () => {
    // A blocked earlier goal can leave HEAD on its own branch. The next goal
    // must be built on the stack base, not on whatever HEAD holds.
    await git(repo, ["switch", "-c", "stray"]);
    await writeFile(join(repo, "stray.txt"), "stray\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "stray work"]);

    const plan = await prepareGoalDispatch({
      maxConcurrency: 1,
      hasWorktreeManager: false,
      stackPRs: true,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId: "g1",
      projectBaseBranch: "main",
      configuredBaseBranch: "main",
      previousGoalBranch: null,
    });

    // The worker runs in the repo root: it must see the goal branch's tree.
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(`${PREFIX}/goal-g1`);
    expect(plan.goalBranch).toBe(`${PREFIX}/goal-g1`);
    expect(existsSync(join(repo, "stray.txt"))).toBe(false);
  });

  it("leaves HEAD alone in worktree mode", async () => {
    const plan = await prepareGoalDispatch({
      maxConcurrency: 3,
      hasWorktreeManager: true,
      stackPRs: true,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId: "g1",
      projectBaseBranch: "main",
      configuredBaseBranch: "main",
      previousGoalBranch: null,
    });

    expect(plan.parallel).toBe(true);
    expect(plan.dispatchBaseBranch).toBe(`${PREFIX}/goal-g1`);
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("hands the worker no branch hints: workers cannot open PRs, swarm does", async () => {
    await prepareGoalDispatch({
      maxConcurrency: 1,
      hasWorktreeManager: false,
      stackPRs: true,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId: "g1",
      projectBaseBranch: "main",
      configuredBaseBranch: "main",
      previousGoalBranch: null,
    });

    expect(process.env.SWARM_GOAL_BRANCH).toBeUndefined();
    expect(process.env.SWARM_BASE_BRANCH).toBeUndefined();
  });

  it("does nothing to git when stack mode is off", async () => {
    const plan = await prepareGoalDispatch({
      maxConcurrency: 1,
      hasWorktreeManager: false,
      stackPRs: false,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId: "g1",
      projectBaseBranch: "main",
      configuredBaseBranch: "main",
      previousGoalBranch: null,
    });

    expect(plan.goalBranch).toBeNull();
    expect(plan.dispatchBaseBranch).toBe("main");
    expect(await git(repo, ["branch", "--list", `${PREFIX}/*`])).toBe("");
  });
});

describe("completed goals that could not be stacked are reported, not dropped", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "swarm-unstacked-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "# initial\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
  });

  afterEach(async () => {
    delete process.env.SWARM_GOAL_BRANCH;
    delete process.env.SWARM_BASE_BRANCH;
    await rm(repo, { recursive: true, force: true });
  });

  it("records a completed goal whose branch could not be made, with where its commits went", async () => {
    const orch = makeOrchestrator(repo);
    const ledger = createGoalStackLedger();
    const warnings: string[] = [];
    // A base ref that doesn't exist makes materialization fail; the goal falls
    // back to flat mode and its commits land on HEAD (main).
    const plan = await prepareGoalDispatch({
      maxConcurrency: 1,
      hasWorktreeManager: false,
      stackPRs: true,
      repoRoot: repo,
      branchPrefix: PREFIX,
      goalId: "g1",
      projectBaseBranch: "no-such-branch",
      configuredBaseBranch: "no-such-branch",
      previousGoalBranch: null,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    expect(plan.goalBranch).toBeNull();
    expect(warnings.join("\n")).toMatch(/failed to create goal branch/);

    await writeFile(join(repo, "one.txt"), "one\n");
    await orch.commitLiveRepo(makeTask("g1-t1", "g1"), { goalBranch: plan.goalBranch });

    await recordGoalOutcomeForStack(ledger, {
      stackPRs: true,
      goalBranch: plan.goalBranch,
      goalStatus: "completed",
      goal: { goalId: "g1", goalDescription: "Goal g1" },
      commitCount: orch.getCommitsForGoal("g1"),
      commitsOn: () => whereGoalCommitsLanded(plan, repo),
    });

    expect(ledger.completed).toEqual([]);
    expect(ledger.unstacked).toEqual([
      { goalId: "g1", goalDescription: "Goal g1", commitsOn: "main", commitCount: 1 },
    ]);
  });

  it("does not report goals when stack mode is off or the goal did not complete", async () => {
    const ledger = createGoalStackLedger();
    const commitsOn = async () => "main";
    await recordGoalOutcomeForStack(ledger, {
      stackPRs: false, goalBranch: null, goalStatus: "completed",
      goal: { goalId: "a", goalDescription: "A" }, commitCount: 1, commitsOn,
    });
    await recordGoalOutcomeForStack(ledger, {
      stackPRs: true, goalBranch: null, goalStatus: "blocked",
      goal: { goalId: "b", goalDescription: "B" }, commitCount: 1, commitsOn,
    });
    expect(ledger.completed).toEqual([]);
    expect(ledger.unstacked).toEqual([]);
  });

  it("reports the dispatch base as the landing branch in worktree mode", async () => {
    expect(
      await whereGoalCommitsLanded(
        { parallel: true, goalBranch: null, stackBase: "main", dispatchBaseBranch: "develop" },
        repo,
      ),
    ).toBe("develop");
    expect(
      await whereGoalCommitsLanded(
        { parallel: false, goalBranch: null, stackBase: "main", dispatchBaseBranch: "develop" },
        repo,
      ),
    ).toBe("main");
  });
});
