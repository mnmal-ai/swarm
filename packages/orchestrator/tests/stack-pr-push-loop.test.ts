import { describe, it, expect, vi, beforeEach } from "vitest";
import { SourceControlManager } from "../src/source-control/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SourceControlConfig } from "@mnmal-ai/swarm-types";

/**
 * Regression guard: a stacked multi-goal run must push EVERY goal's
 * branch and open one PR per goal. The original defect pushed-and-PR'd only one
 * branch per session while the worker had committed to every goal branch — the
 * rest landed local-only. This drives a 3-goal stack through
 * SourceControlManager.onGoalComplete() against a stub gh/git client that
 * records (never executes) push and `gh pr create` invocations, and asserts the
 * full stacked base chain plus that all three branches were pushed.
 */

// Stub node:child_process so neither git nor gh ever touches the network.
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, "", "");
  }),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

function makeConfig(overrides?: Partial<SourceControlConfig>): SourceControlConfig {
  return {
    strategy: "remote_pr",
    stack_prs: true,
    ...overrides,
  };
}

/** A recorded `git push` of a goal branch. */
interface RecordedPush {
  remote: string;
  branch: string;
}

/** A recorded `gh pr create` invocation. */
interface RecordedPr {
  base?: string;
  head?: string;
}

/**
 * Install a stub gh/git client that records every push and `gh pr create`
 * without performing any IO. `gh pr create` returns a distinct PR URL per call
 * so the manager treats each goal as a real, opened PR.
 */
function installStubGhClient(pushes: RecordedPush[], prs: RecordedPr[]) {
  let prIdx = 0;
  mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
    const args = (rawArgs as string[]) ?? [];

    if (cmd === "git" && args[0] === "push") {
      // `git push -u <remote> <branch>` — last two args are remote, branch.
      pushes.push({ remote: args[args.length - 2], branch: args[args.length - 1] });
      cb(null, "", "");
      return;
    }

    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
      const baseIdx = args.indexOf("--base");
      const headIdx = args.indexOf("--head");
      prs.push({
        base: baseIdx >= 0 ? args[baseIdx + 1] : undefined,
        head: headIdx >= 0 ? args[headIdx + 1] : undefined,
      });
      cb(null, `https://github.com/test/pr/${++prIdx}\n`, "");
      return;
    }

    // git merge-base --is-ancestor / git branch -f / git checkout -b all succeed.
    cb(null, "", "");
  });
}

describe("stack-PR push loop", () => {
  let pushes: RecordedPush[];
  let prs: RecordedPr[];

  beforeEach(() => {
    vi.resetAllMocks();
    pushes = [];
    prs = [];
    installStubGhClient(pushes, prs);
  });

  it("opens exactly 3 stacked PRs and pushes every goal branch for a 3-goal stack", async () => {
    const prEvents: { goalId: string; branch: string; prUrl: string }[] = [];
    const pushEvents: { branch: string }[] = [];
    const eventBus = new SwarmEventBus();
    eventBus.on("source_control:pr_created", (e) =>
      prEvents.push(e as { goalId: string; branch: string; prUrl: string }),
    );
    eventBus.on("source_control:branch_pushed", (e) => pushEvents.push(e as { branch: string }));

    const mgr = new SourceControlManager("/repo", makeConfig(), eventBus);
    await mgr.createSessionBranch("sess-abc12345");

    const result = await mgr.onGoalComplete([
      { goalId: "goal-1", goalDescription: "First goal" },
      { goalId: "goal-2", goalDescription: "Second goal" },
      { goalId: "goal-3", goalDescription: "Third goal" },
    ]);

    // Exactly three PRs, one per goal — not a single session PR.
    expect(prs).toHaveLength(3);
    expect(prEvents).toHaveLength(3);
    expect(result.goals).toHaveLength(3);

    // Every goal's branch was pushed (3 pushes) — none landed local-only.
    expect(pushes).toHaveLength(3);
    expect(pushEvents).toHaveLength(3);
    expect(result.goals.every((g) => g.pushed)).toBe(true);
    expect(result.pushed).toBe(true);

    const branches = result.goals.map((g) => g.branch);
    expect(branches).toEqual(["swarm/goal-1", "swarm/goal-2", "swarm/goal-3"]);
    // The recorded pushes cover exactly the three goal branches, in order.
    expect(pushes.map((p) => p.branch)).toEqual(branches);
  });

  it("creates the PRs in stacked order with the correct base chain", async () => {
    const mgr = new SourceControlManager("/repo", makeConfig(), new SwarmEventBus());
    await mgr.createSessionBranch("sess-abc12345");

    const result = await mgr.onGoalComplete([
      { goalId: "goal-1", goalDescription: "First goal" },
      { goalId: "goal-2", goalDescription: "Second goal" },
      { goalId: "goal-3", goalDescription: "Third goal" },
    ]);

    // PRs recorded in goal order.
    expect(prs.map((p) => p.head)).toEqual(["swarm/goal-1", "swarm/goal-2", "swarm/goal-3"]);

    // goal-1 bases on the stack root (the project base branch, main).
    expect(prs[0].base).toBe("main");
    expect(result.goals[0].base).toBe("main");

    // goal-2 base = goal-1 head; goal-3 base = goal-2 head.
    expect(prs[1].base).toBe(prs[0].head);
    expect(prs[2].base).toBe(prs[1].head);
    expect(result.goals[1].base).toBe(result.goals[0].branch);
    expect(result.goals[2].base).toBe(result.goals[1].branch);
  });
});

describe("stack-PR body", () => {
  let bodies: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    bodies = [];
    mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
      const args = (rawArgs as string[]) ?? [];
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        bodies.push(args[args.indexOf("--body") + 1]);
        cb(null, `https://github.com/test/pr/${bodies.length}\n`, "");
        return;
      }
      cb(null, "", "");
    });
  });

  it("names the item the goal came from, so the PR links back to its ticket", async () => {
    const mgr = new SourceControlManager("/repo", makeConfig(), new SwarmEventBus());
    await mgr.createSessionBranch("sess-abc12345");

    await mgr.onGoalComplete([
      { goalId: "trello-aaa111", goalDescription: "Fix the export button", goalUrl: "https://trello.com/c/aaa111" },
    ]);

    expect(bodies[0]).toContain("Source: https://trello.com/c/aaa111");
  });

  it("adds no source line when the goal has no URL", async () => {
    const mgr = new SourceControlManager("/repo", makeConfig(), new SwarmEventBus());
    await mgr.createSessionBranch("sess-abc12345");

    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First goal" }]);

    expect(bodies[0]).not.toContain("Source:");
  });
});
