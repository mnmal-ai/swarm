import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { materializeGoalBranch, goalBranchName, resolveStackBase } from "../src/source-control/stack.js";

const exec = promisify(execFile);

// Integration coverage for the git side-effect path. The pure helpers are
// covered by stack.test.ts; this file proves the full chain — resolve base
// → name branch → materialize it — does what the run loop expects against
// a real git repo. Slow-ish (forks `git` ~10x per test) but isolated to
// /tmp, so safe to run on CI.

describe("materializeGoalBranch (integration)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "swarm-stack-int-"));
    await exec("git", ["init", "-b", "main"], { cwd: repoRoot });
    await exec("git", ["config", "user.email", "test@swarm.local"], { cwd: repoRoot });
    await exec("git", ["config", "user.name", "Swarm Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "README.md"), "initial\n");
    await exec("git", ["add", "."], { cwd: repoRoot });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("creates the goal branch pointing at the resolved base for the first goal of a stacked run", async () => {
    // First goal: previousGoalBranch is null, so stackBase falls back to
    // the project's base branch (main). The goal branch should point at
    // main's HEAD commit.
    const base = resolveStackBase({ stackPRs: true, projectBaseBranch: "main", previousGoalBranch: null });
    const branch = goalBranchName("swarm/", "goal-1");

    await materializeGoalBranch(repoRoot, branch, base);

    const { stdout: branchHead } = await exec("git", ["rev-parse", branch], { cwd: repoRoot });
    const { stdout: mainHead } = await exec("git", ["rev-parse", "main"], { cwd: repoRoot });
    expect(branchHead.trim()).toBe(mainHead.trim());
  });

  it("chains goal-2's branch on top of goal-1's branch when goal-1 has its own commits", async () => {
    // Simulate the full multi-goal flow: goal-1 creates a branch off main,
    // we add a commit there (mimicking the worker's diff merged in via
    // auto-merge cleanup), then goal-2 starts and should base on goal-1's
    // branch — including goal-1's commit.
    const branch1 = goalBranchName("swarm/", "goal-1");
    await materializeGoalBranch(repoRoot, branch1, "main");
    await exec("git", ["checkout", branch1], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "goal-1.txt"), "goal-1 work\n");
    await exec("git", ["add", "."], { cwd: repoRoot });
    await exec("git", ["commit", "-m", "goal-1: do work"], { cwd: repoRoot });
    const { stdout: goal1Head } = await exec("git", ["rev-parse", branch1], { cwd: repoRoot });

    // Now goal-2: stack base is goal-1's branch
    const stackBaseG2 = resolveStackBase({
      stackPRs: true,
      projectBaseBranch: "main",
      previousGoalBranch: branch1,
    });
    expect(stackBaseG2).toBe(branch1);

    const branch2 = goalBranchName("swarm/", "goal-2");
    await materializeGoalBranch(repoRoot, branch2, stackBaseG2);

    const { stdout: branch2Head } = await exec("git", ["rev-parse", branch2], { cwd: repoRoot });
    expect(branch2Head.trim()).toBe(goal1Head.trim());

    // goal-2's branch should contain goal-1's commit in its history
    const { stdout: log } = await exec("git", ["log", "--format=%s", branch2], { cwd: repoRoot });
    expect(log).toContain("goal-1: do work");
  });

  it("uses git branch -f so re-running the same goal repoints the branch instead of erroring", async () => {
    const branch = goalBranchName("swarm/", "goal-7");

    // First materialization — branch did not previously exist
    await materializeGoalBranch(repoRoot, branch, "main");
    const { stdout: head1 } = await exec("git", ["rev-parse", branch], { cwd: repoRoot });

    // Advance main one commit so the second materialization moves to a
    // different SHA — proving the call is doing a real "-f" relocation
    // rather than silently no-op'ing on an existing branch.
    writeFileSync(join(repoRoot, "advance.txt"), "advance\n");
    await exec("git", ["add", "."], { cwd: repoRoot });
    await exec("git", ["commit", "-m", "advance main"], { cwd: repoRoot });
    const { stdout: newMainHead } = await exec("git", ["rev-parse", "main"], { cwd: repoRoot });
    expect(newMainHead.trim()).not.toBe(head1.trim());

    // Second materialization — same branch name, different base. Must
    // succeed (the run loop relies on this for resumed sessions).
    await materializeGoalBranch(repoRoot, branch, "main");
    const { stdout: head2 } = await exec("git", ["rev-parse", branch], { cwd: repoRoot });
    expect(head2.trim()).toBe(newMainHead.trim());
  });

  it("rejects (and lets the caller fall back) when the base ref doesn't exist", async () => {
    // The run loop catches this exception, prints a warning, and falls
    // back to projectConfig.base_branch for the offending goal. The test
    // just asserts the call rejects so the catch fires — no fall-back
    // logic to verify here.
    await expect(
      materializeGoalBranch(repoRoot, "swarm/goal-doomed", "this-ref-does-not-exist"),
    ).rejects.toBeTruthy();
  });

  it("resolves safely when goalBranch is checked out and already descends from base", async () => {
    // With the ancestor guard: if the goal branch is already ahead of (or at)
    // base, materialize is a no-op. This avoids the git fatal that fires when
    // trying to force-reset the currently checked-out branch, and also
    // preserves any partial task work already merged into the branch during a
    // resumed session.
    const branch = goalBranchName("swarm/", "7");
    await exec("git", ["checkout", "-b", branch], { cwd: repoRoot });
    await expect(materializeGoalBranch(repoRoot, branch, "main")).resolves.toBeUndefined();
    // Branch is still at main's HEAD — the no-op didn't corrupt it.
    const { stdout: branchHead } = await exec("git", ["rev-parse", branch], { cwd: repoRoot });
    const { stdout: mainHead } = await exec("git", ["rev-parse", "main"], { cwd: repoRoot });
    expect(branchHead.trim()).toBe(mainHead.trim());
  });
});
