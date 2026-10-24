import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Bug#1 — run.ts wiring: the orchestrator must route EVERY completed goal into
 * the SourceControlManager per-goal push+PR loop, not just the last one.
 *
 * The SourceControlManager loop itself is covered by
 * packages/orchestrator/tests/stack-pr-push-loop.test.ts. These tests cover the
 * CLI seam — `pushCompletedGoalStack` — which decides WHETHER to push (gating
 * on stack_prs + remote_pr) and forwards the full ordered goal list. The final
 * test drives a 3-goal stack end-to-end through the real SourceControlManager
 * against a stubbed gh/git client and asserts 3 stacked PRs are opened.
 */

// Stub git/gh so nothing touches the network. Hoisted above the imports that
// capture execFile (SourceControlManager + stack.ts).
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, "", "")),
}));

import { execFile } from "node:child_process";
import { SourceControlManager } from "@mnmal-ai/swarm-orchestrator";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import {
  pushCompletedGoalStack,
  runStackedPrPushStep,
  type StackedPrManager,
  type StackedPrPushLogger,
  type CompletedGoalRef,
  formatUnstackedGoalsWarning,
} from "../src/cli/run.js";

const mockExecFile = vi.mocked(execFile);

const THREE_GOALS: CompletedGoalRef[] = [
  { goalId: "goal-1", goalDescription: "First goal" },
  { goalId: "goal-2", goalDescription: "Second goal" },
  { goalId: "goal-3", goalDescription: "Third goal" },
];

/** A stub manager that records calls without performing IO. */
function makeStubManager(): StackedPrManager & {
  createSessionBranch: ReturnType<typeof vi.fn>;
  onGoalComplete: ReturnType<typeof vi.fn>;
  restoreBaseBranch: ReturnType<typeof vi.fn>;
} {
  return {
    createSessionBranch: vi.fn(async () => "swarm/session-x"),
    onGoalComplete: vi.fn(async (goals: CompletedGoalRef[]) => ({
      pushed: true,
      prUrl: "https://github.com/test/pr/last",
      goals: goals.map((g, i) => ({
        goalId: g.goalId,
        branch: `swarm/${g.goalId}`,
        base: i === 0 ? "main" : `swarm/${goals[i - 1].goalId}`,
        pushed: true,
        prUrl: `https://github.com/test/pr/${i + 1}`,
      })),
    })),
    restoreBaseBranch: vi.fn(async () => {}),
  };
}

describe("pushCompletedGoalStack — gating (preserve non-stack / non-remote_pr)", () => {
  it("is a pure no-op when stack_prs is off", async () => {
    const mgr = makeStubManager();
    const result = await pushCompletedGoalStack(mgr, THREE_GOALS, {
      stackPRs: false,
      strategy: "remote_pr",
      sessionId: "s1",
    });
    expect(result).toBeNull();
    expect(mgr.createSessionBranch).not.toHaveBeenCalled();
    expect(mgr.onGoalComplete).not.toHaveBeenCalled();
  });

  it("is a pure no-op when strategy is not remote_pr", async () => {
    const mgr = makeStubManager();
    for (const strategy of ["ephemeral", "local_branch", undefined]) {
      const result = await pushCompletedGoalStack(mgr, THREE_GOALS, {
        stackPRs: true,
        strategy,
        sessionId: "s1",
      });
      expect(result).toBeNull();
    }
    expect(mgr.onGoalComplete).not.toHaveBeenCalled();
  });

  it("is a no-op when no goal completed this run", async () => {
    const mgr = makeStubManager();
    const result = await pushCompletedGoalStack(mgr, [], {
      stackPRs: true,
      strategy: "remote_pr",
      sessionId: "s1",
    });
    expect(result).toBeNull();
    expect(mgr.onGoalComplete).not.toHaveBeenCalled();
  });
});

describe("pushCompletedGoalStack — routes ALL completed goals", () => {
  it("forwards the full ordered goal list to onGoalComplete exactly once", async () => {
    const mgr = makeStubManager();
    const result = await pushCompletedGoalStack(mgr, THREE_GOALS, {
      stackPRs: true,
      strategy: "remote_pr",
      sessionId: "sess-abc",
    });

    // No session branch (and so no checkout a dirty tree could refuse): the
    // FULL list is pushed, then the base branch is restored.
    expect(mgr.createSessionBranch).not.toHaveBeenCalled();
    expect(mgr.onGoalComplete).toHaveBeenCalledTimes(1);
    expect(mgr.onGoalComplete).toHaveBeenCalledWith(THREE_GOALS);
    expect(mgr.restoreBaseBranch).toHaveBeenCalledTimes(1);

    // Not just the last goal — all three come back.
    expect(result?.goals.map((g) => g.goalId)).toEqual(["goal-1", "goal-2", "goal-3"]);
    expect(result?.goals.every((g) => g.pushed)).toBe(true);
  });
});

describe("pushCompletedGoalStack — end-to-end through the real SourceControlManager", () => {
  let pushes: string[];
  let prs: { base?: string; head?: string }[];

  beforeEach(() => {
    vi.resetAllMocks();
    pushes = [];
    prs = [];
    let prIdx = 0;
    mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
      const args = (rawArgs as string[]) ?? [];
      if (cmd === "git" && args[0] === "push") {
        pushes.push(args[args.length - 1]); // branch is the last arg
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
      // git checkout / branch -f / merge-base --is-ancestor all succeed.
      cb(null, "", "");
    });
  });

  it("opens exactly 3 stacked PRs for a 3-goal stack via the run.ts seam", async () => {
    const scm = new SourceControlManager(
      "/repo",
      { strategy: "remote_pr", stack_prs: true, base_branch: "main", branch_prefix: "swarm/" },
      new SwarmEventBus(),
    );

    const result = await pushCompletedGoalStack(scm, THREE_GOALS, {
      stackPRs: true,
      strategy: "remote_pr",
      sessionId: "sess-abc12345",
    });

    expect(result).not.toBeNull();
    // Three branches pushed, three PRs opened — not one session PR.
    expect(pushes).toEqual(["swarm/goal-1", "swarm/goal-2", "swarm/goal-3"]);
    expect(prs).toHaveLength(3);
    expect(prs.map((p) => p.head)).toEqual(["swarm/goal-1", "swarm/goal-2", "swarm/goal-3"]);

    // Stacked base chain: goal-1 → main, goal-2 → goal-1, goal-3 → goal-2.
    expect(prs[0].base).toBe("main");
    expect(prs[1].base).toBe("swarm/goal-1");
    expect(prs[2].base).toBe("swarm/goal-2");
    expect(result?.goals.every((g) => g.pushed)).toBe(true);
  });
});

/**
 * Bug#4 — call-site error isolation: the stacked-PR push step must NEVER throw
 * out to the caller, because the run-summary capture (captureRunObservation)
 * fires later on the linear session-end path. A throw here silently drops
 * learned/runs/<runId>.md (observed for run-id 3dcd7f). runStackedPrPushStep
 * wraps construction + push and swallows any failure.
 */
describe("runStackedPrPushStep — error isolation guarantees capture is reached", () => {
  const STACK_OPTS = { stackPRs: true, strategy: "remote_pr", sessionId: "sess-iso" } as const;

  function recordingLogger(): StackedPrPushLogger & {
    results: unknown[];
    errors: { err: unknown; count: number }[];
  } {
    const results: unknown[] = [];
    const errors: { err: unknown; count: number }[] = [];
    return {
      results,
      errors,
      onResult: (r) => results.push(r),
      onError: (err, count) => errors.push({ err, count }),
    };
  }

  it("does not throw when the manager factory (SCM ctor) throws", async () => {
    const logger = recordingLogger();
    const makeManager = () => {
      throw new Error("bad repo state");
    };

    // The whole point: this resolves, it does not reject. If it threw, the
    // downstream capture in runOrchestrator would be skipped.
    const result = await runStackedPrPushStep(makeManager, THREE_GOALS, STACK_OPTS, logger);

    expect(result).toBeNull();
    expect(logger.errors).toHaveLength(1);
    expect((logger.errors[0].err as Error).message).toBe("bad repo state");
    expect(logger.errors[0].count).toBe(3);
    expect(logger.results).toHaveLength(0);
  });

  it("does not throw when the push+PR loop throws (half-pushed stack)", async () => {
    const logger = recordingLogger();
    const mgr = makeStubManager();
    mgr.onGoalComplete.mockRejectedValueOnce(new Error("wedge: half-pushed stack"));

    const result = await runStackedPrPushStep(() => mgr, THREE_GOALS, STACK_OPTS, logger);

    expect(result).toBeNull();
    expect(mgr.onGoalComplete).toHaveBeenCalledTimes(1);
    expect(logger.errors).toHaveLength(1);
    expect((logger.errors[0].err as Error).message).toBe("wedge: half-pushed stack");
    expect(logger.results).toHaveLength(0);
  });

  it("reports the push result via onResult on success", async () => {
    const logger = recordingLogger();
    const mgr = makeStubManager();

    const result = await runStackedPrPushStep(() => mgr, THREE_GOALS, STACK_OPTS, logger);

    expect(result).not.toBeNull();
    expect(logger.errors).toHaveLength(0);
    expect(logger.results).toHaveLength(1);
    expect((logger.results[0] as { goals: unknown[] }).goals).toHaveLength(3);
  });

  it("never constructs the manager for a non-stack / non-remote_pr / empty run", async () => {
    const logger = recordingLogger();
    const makeManager = vi.fn(() => makeStubManager());

    const offStack = await runStackedPrPushStep(makeManager, THREE_GOALS, { ...STACK_OPTS, stackPRs: false }, logger);
    const offRemote = await runStackedPrPushStep(makeManager, THREE_GOALS, { ...STACK_OPTS, strategy: "ephemeral" }, logger);
    const noGoals = await runStackedPrPushStep(makeManager, [], STACK_OPTS, logger);

    expect(offStack).toBeNull();
    expect(offRemote).toBeNull();
    expect(noGoals).toBeNull();
    // Pure no-op: the factory is never invoked, so no git/gh is touched.
    expect(makeManager).not.toHaveBeenCalled();
    expect(logger.results).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });
});

/**
 * A stack-mode remote_pr run that completed goals but stacked none of them
 * used to return null silently: no push, no PR, no message. It must say which
 * goals were left out and where their commits are.
 */
describe("runStackedPrPushStep — completed goals that were not stacked", () => {
  const STACK_OPTS = { stackPRs: true, strategy: "remote_pr", sessionId: "sess-u" } as const;
  const UNSTACKED = [
    { goalId: "trello-q7Wd2kRn", goalDescription: "Add the reading list page", commitsOn: "main", commitCount: 7 },
  ];

  it("reports them when nothing was stacked, without constructing the manager", async () => {
    const reported: unknown[] = [];
    const makeManager = vi.fn(() => makeStubManager());

    const result = await runStackedPrPushStep(
      makeManager,
      [],
      { ...STACK_OPTS, unstackedGoals: UNSTACKED },
      { onUnstacked: (goals) => reported.push(goals) },
    );

    expect(result).toBeNull();
    expect(makeManager).not.toHaveBeenCalled();
    expect(reported).toEqual([UNSTACKED]);
  });

  it("reports them alongside a push of the goals that were stacked", async () => {
    const reported: unknown[] = [];
    const mgr = makeStubManager();

    const result = await runStackedPrPushStep(
      () => mgr,
      THREE_GOALS,
      { ...STACK_OPTS, unstackedGoals: UNSTACKED },
      { onUnstacked: (goals) => reported.push(goals) },
    );

    expect(result?.goals).toHaveLength(3);
    expect(reported).toEqual([UNSTACKED]);
  });

  it("stays silent outside stack + remote_pr mode", async () => {
    const onUnstacked = vi.fn();
    await runStackedPrPushStep(() => makeStubManager(), [], { ...STACK_OPTS, stackPRs: false, unstackedGoals: UNSTACKED }, { onUnstacked });
    await runStackedPrPushStep(() => makeStubManager(), [], { ...STACK_OPTS, strategy: "local_branch", unstackedGoals: UNSTACKED }, { onUnstacked });
    await runStackedPrPushStep(() => makeStubManager(), [], { ...STACK_OPTS, unstackedGoals: [] }, { onUnstacked });
    expect(onUnstacked).not.toHaveBeenCalled();
  });

  it("formats a warning naming each goal and the branch holding its commits", () => {
    const lines = formatUnstackedGoalsWarning([
      ...UNSTACKED,
      { goalId: "g2", goalDescription: "Second", commitsOn: null, commitCount: 0 },
    ]);
    const text = lines.join("\n");
    expect(text).toMatch(/2 completed goal\(s\) were not stacked/);
    expect(text).toMatch(/no branch was pushed and no PR opened/);
    expect(text).toContain("trello-q7Wd2kRn");
    expect(text).toContain("Add the reading list page");
    expect(text).toContain("7 commit(s) on 'main'");
    expect(text).toContain("g2");
    expect(text).toContain("no commits");
  });
});
