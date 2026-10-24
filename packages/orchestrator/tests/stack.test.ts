import { describe, it, expect } from "vitest";
import { resolveStackBase, goalBranchName, STACK_PRS_DEFAULT } from "../src/source-control/stack.js";

describe("resolveStackBase", () => {
  it("returns the project base branch when stacking is disabled, regardless of previous goal", () => {
    expect(
      resolveStackBase({ stackPRs: false, projectBaseBranch: "main", previousGoalBranch: "swarm/goal-1" }),
    ).toBe("main");
    expect(
      resolveStackBase({ stackPRs: false, projectBaseBranch: "develop", previousGoalBranch: null }),
    ).toBe("develop");
  });

  it("returns the project base branch on the first goal of a stacked run (no previous branch yet)", () => {
    expect(
      resolveStackBase({ stackPRs: true, projectBaseBranch: "main", previousGoalBranch: null }),
    ).toBe("main");
  });

  it("returns the previous goal's branch when stacking is enabled and one exists", () => {
    expect(
      resolveStackBase({ stackPRs: true, projectBaseBranch: "main", previousGoalBranch: "swarm/goal-1" }),
    ).toBe("swarm/goal-1");
  });

  it("falls back to base branch when stacking is enabled but the previous goal was reset (failed/blocked)", () => {
    // Callers reset previousGoalBranch to null after a non-success goal so we
    // don't stack follow-up work on top of partial output. resolveStackBase
    // must honor that signal — null wins over the stackPRs flag.
    expect(
      resolveStackBase({ stackPRs: true, projectBaseBranch: "main", previousGoalBranch: null }),
    ).toBe("main");
  });
});

describe("goalBranchName", () => {
  it("uses the configured prefix with a 'goal-' segment and a sanitized goal id", () => {
    expect(goalBranchName("swarm/", "goal-37")).toBe("swarm/goal-37");
    expect(goalBranchName("swarm", "37")).toBe("swarm/goal-37");
  });

  it("normalizes prefixes that lack a trailing slash", () => {
    expect(goalBranchName("swarm", "g7")).toBe("swarm/goal-g7");
    expect(goalBranchName("swarm/", "g7")).toBe("swarm/goal-g7");
  });

  it("lowercases the goal id segment so two goals differing only in case don't collide on git's case-insensitive ref store", () => {
    expect(goalBranchName("swarm/", "Goal-AB")).toBe("swarm/goal-ab");
  });

  it("strips git-unsafe characters from the goal id", () => {
    // git refs cannot contain spaces, ~, ^, :, \, ?, *, [, and a few others;
    // collapse runs of those to a single dash so the result is a valid ref.
    expect(goalBranchName("swarm/", "feat: do  X^Y?")).toBe("swarm/goal-feat-do-x-y-");
  });

  it("rewrites a leading dot, dash, or slash so the ref doesn't start with a forbidden character", () => {
    // Per git-check-ref-format(1), a branch name cannot start with '.' or '/'
    // and a leading '-' is rejected by 'git branch'. The forbidden character
    // is replaced with 'g' (matching SourceControlManager's pattern), not
    // prepended — that would still leave the bad char in second position
    // (fine for refs but ugly).
    expect(goalBranchName("swarm/", ".hidden")).toBe("swarm/goal-ghidden");
    expect(goalBranchName("swarm/", "/abs")).toBe("swarm/goal-gabs");
    expect(goalBranchName("swarm/", "-flag")).toBe("swarm/goal-gflag");
  });

  it("collapses double dots and double slashes (rejected by git refs)", () => {
    expect(goalBranchName("swarm/", "a..b")).toBe("swarm/goal-a.b");
    expect(goalBranchName("swarm/", "a//b")).toBe("swarm/goal-a/b");
  });
});

describe("STACK_PRS_DEFAULT", () => {
  it("defaults to false so stack-PR mode is opt-in", () => {
    // Stacked PRs are a behavioral change for existing multi-goal users.
    // Defaulting to false means a fresh swarm config (no source_control block,
    // or one without stack_prs set) keeps the pre-stacking behavior — every
    // goal branches off base_branch independently. Users enable stacking
    // explicitly with `source_control.stack_prs: true`. Flipping this constant
    // flips the whole ecosystem; guard it with a test so the change is loud.
    expect(STACK_PRS_DEFAULT).toBe(false);
  });
});

describe("goalBranchName edge cases", () => {
  it("throws on an empty goal ID", () => {
    expect(() => goalBranchName("swarm/", "")).toThrow();
  });
});
