import { describe, it, expect, vi, beforeEach } from "vitest";
import { SourceControlManager, formatPrTitle } from "../src/source-control/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SourceControlConfig } from "@mnmal-ai/swarm-types";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, "", "");
  }),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

function makeConfig(overrides?: Partial<SourceControlConfig>): SourceControlConfig {
  return {
    strategy: "ephemeral",
    ...overrides,
  };
}

describe("SourceControlManager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore default mock: all git/gh commands succeed with empty output,
    // except `git show-ref --verify`, which exits 1: no branch exists yet.
    mockExecFile.mockImplementation((_cmd: string, args: unknown, _opts: unknown, cb: Function) => {
      if ((args as string[])[0] === "show-ref") return cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
      cb(null, "", "");
    });
  });

  // -------------------------------------------------------------------------
  // Ephemeral strategy
  // -------------------------------------------------------------------------

  describe("ephemeral strategy", () => {
    it("createSessionBranch returns null", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "ephemeral" }));
      const branch = await mgr.createSessionBranch("sess-abc12345");
      expect(branch).toBeNull();
      expect(mgr.getSessionBranch()).toBeNull();
    });

    it("onGoalComplete is a no-op", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "ephemeral" }));
      const result = await mgr.onGoalComplete("goal-1", "Test goal");
      expect(result.pushed).toBe(false);
      expect(result.prUrl).toBeUndefined();
    });

    it("does not emit any events", async () => {
      const eventBus = new SwarmEventBus();
      const events: unknown[] = [];
      eventBus.onAny((_name, payload) => events.push(payload));

      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "ephemeral" }), eventBus);
      await mgr.createSessionBranch("sess-abc12345");
      await mgr.onGoalComplete("goal-1", "Test goal");

      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Local branch strategy
  // -------------------------------------------------------------------------

  describe("local_branch strategy", () => {
    it("creates a session branch with correct naming", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));
      const branch = await mgr.createSessionBranch("sess-abc12345-more-id");

      expect(branch).toMatch(/^swarm\/session-\d{4}-\d{2}-\d{2}-sess-abc/);
      expect(mgr.getSessionBranch()).toBe(branch);
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["checkout", "-b"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses custom branch prefix", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "local_branch",
        branch_prefix: "custom/",
      }));
      const branch = await mgr.createSessionBranch("sess-abc12345");
      expect(branch).toMatch(/^custom\/session-/);
    });

    it("uses custom base branch as start point", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "local_branch",
        base_branch: "develop",
      }));
      await mgr.createSessionBranch("sess-abc12345");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["checkout", "-b", expect.stringContaining("session"), "develop"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("gives two runs of the same project on the same day different session branches", async () => {
      // Run ids share a "run-<project>-" prefix; only the random tail tells them apart.
      const first = await new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }))
        .createSessionBranch("run-project-a-aa11bb");
      const second = await new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }))
        .createSessionBranch("run-project-a-cc22dd");

      expect(first).toContain("aa11bb");
      expect(second).toContain("cc22dd");
      expect(first).not.toBe(second);
    });

    it("switches to the session branch when it already exists instead of failing", async () => {
      // show-ref finds the branch; `checkout -b` would fail, here with a
      // non-English message, so the check must not depend on git's wording.
      mockExecFile.mockImplementation((_cmd: string, args: unknown, _opts: unknown, cb: Function) => {
        const a = args as string[];
        if (a[0] === "checkout" && a[1] === "-b") {
          const msg = `fatal: une branche nommée '${a[2]}' existe déjà`;
          return cb(Object.assign(new Error(msg), { code: 128 }), "", msg);
        }
        cb(null, "", "");
      });
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));

      const branch = await mgr.createSessionBranch("run-project-a-aa11bb");

      expect(branch).toContain("aa11bb");
      expect(mgr.getSessionBranch()).toBe(branch);
      const calls = mockExecFile.mock.calls.map(([, a]) => (a as string[]).join(" "));
      expect(calls).toContain(`show-ref --verify --quiet refs/heads/${branch}`);
      expect(calls).toContain(`checkout ${branch}`);
      expect(calls.some((c) => c.startsWith("checkout -b"))).toBe(false);
    });

    it("still fails when creating a new session branch fails for another reason", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: unknown, _opts: unknown, cb: Function) => {
        const a = args as string[];
        if (a[0] === "show-ref") return cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
        if (a[0] === "checkout") return cb(new Error("fatal: invalid reference: main"), "", "");
        cb(null, "", "");
      });
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));

      await expect(mgr.createSessionBranch("run-project-a-aa11bb")).rejects.toThrow(/invalid reference/);
    });

    it("emits source_control:branch_created event", async () => {
      const eventBus = new SwarmEventBus();
      const events: unknown[] = [];
      eventBus.on("source_control:branch_created", (e) => events.push(e));

      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }), eventBus);
      await mgr.createSessionBranch("sess-abc12345");

      expect(events).toHaveLength(1);
    });

    it("onGoalComplete does not push", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));
      await mgr.createSessionBranch("sess-abc12345");
      const result = await mgr.onGoalComplete("goal-1", "Test goal");
      expect(result.pushed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Remote PR strategy
  // -------------------------------------------------------------------------

  describe("remote_pr strategy", () => {
    it("pushes and creates PR on goal complete", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
        if (_cmd === "gh") {
          cb(null, "https://github.com/test/pr/1\n", "");
        } else {
          cb(null, "", "");
        }
      });

      const eventBus = new SwarmEventBus();
      const pushEvents: unknown[] = [];
      const prEvents: unknown[] = [];
      eventBus.on("source_control:branch_pushed", (e) => pushEvents.push(e));
      eventBus.on("source_control:pr_created", (e) => prEvents.push(e));

      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "remote_pr" }), eventBus);
      await mgr.createSessionBranch("sess-abc12345");
      const result = await mgr.onGoalComplete("goal-1", "Test goal");

      expect(result.pushed).toBe(true);
      expect(result.prUrl).toBe("https://github.com/test/pr/1");
      expect(pushEvents).toHaveLength(1);
      expect(prEvents).toHaveLength(1);
    });

    it("uses custom remote", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "remote_pr",
        remote: "upstream",
      }));
      await mgr.createSessionBranch("sess-abc12345");
      await mgr.onGoalComplete("goal-1", "Test goal");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["upstream"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("handles push failure gracefully", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
        const args = _args as string[];
        if (_cmd === "git" && args.includes("push")) {
          cb(new Error("push failed"), "", "");
        } else {
          cb(null, "", "");
        }
      });

      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "remote_pr" }));
      await mgr.createSessionBranch("sess-abc12345");
      const result = await mgr.onGoalComplete("goal-1", "Test goal");

      expect(result.pushed).toBe(false);
      expect(result.prUrl).toBeUndefined();
    });

    it("skips PR when pr_on_goal_complete is false", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "remote_pr",
        pr_on_goal_complete: false,
      }));
      await mgr.createSessionBranch("sess-abc12345");
      const result = await mgr.onGoalComplete("goal-1", "Test goal");

      expect(result.pushed).toBe(true);
      expect(result.prUrl).toBeUndefined();
    });

    it("skips push when auto_push is false", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "remote_pr",
        auto_push: false,
      }));
      await mgr.createSessionBranch("sess-abc12345");
      const result = await mgr.onGoalComplete("goal-1", "Test goal");

      expect(result.pushed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Stacked-PR strategy (remote_pr + stack_prs)
  // -------------------------------------------------------------------------

  describe("remote_pr + stack_prs strategy", () => {
    // Capture every gh pr create invocation so we can assert one PR per goal
    // and verify the stacked --base chain.
    function captureGhPrCreate(prUrls: string[]) {
      const calls: { base?: string; head?: string }[] = [];
      let prIdx = 0;
      mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
        const args = rawArgs as string[];
        if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
          const baseIdx = args.indexOf("--base");
          const headIdx = args.indexOf("--head");
          calls.push({
            base: baseIdx >= 0 ? args[baseIdx + 1] : undefined,
            head: headIdx >= 0 ? args[headIdx + 1] : undefined,
          });
          cb(null, `${prUrls[prIdx++ % prUrls.length]}\n`, "");
          return;
        }
        // git merge-base / branch -f / push all succeed
        cb(null, "", "");
      });
      return calls;
    }

    it("opens one PR per goal for a 3-goal stack", async () => {
      const prCalls = captureGhPrCreate([
        "https://github.com/test/pr/1",
        "https://github.com/test/pr/2",
        "https://github.com/test/pr/3",
      ]);

      const eventBus = new SwarmEventBus();
      const prEvents: { goalId: string; branch: string; prUrl: string }[] = [];
      eventBus.on("source_control:pr_created", (e) =>
        prEvents.push(e as { goalId: string; branch: string; prUrl: string }),
      );

      const mgr = new SourceControlManager(
        "/repo",
        makeConfig({ strategy: "remote_pr", stack_prs: true }),
        eventBus,
      );
      await mgr.createSessionBranch("sess-abc12345");

      const result = await mgr.onGoalComplete([
        { goalId: "goal-1", goalDescription: "First goal" },
        { goalId: "goal-2", goalDescription: "Second goal" },
        { goalId: "goal-3", goalDescription: "Third goal" },
      ]);

      // Three distinct PRs, every goal pushed.
      expect(prCalls).toHaveLength(3);
      expect(prEvents).toHaveLength(3);
      expect(result.goals).toHaveLength(3);
      expect(result.goals.every((g) => g.pushed && g.prUrl)).toBe(true);
      expect(result.pushed).toBe(true);

      // Stacked base chain: goal-1 on the stack root (main), goal-2 on goal-1's
      // branch, goal-3 on goal-2's branch.
      expect(prCalls[0].base).toBe("main");
      expect(prCalls[1].base).toBe(prCalls[0].head);
      expect(prCalls[2].base).toBe(prCalls[1].head);
      expect(result.goals[1].base).toBe(result.goals[0].branch);
      expect(result.goals[2].base).toBe(result.goals[1].branch);
    });

    it("stacks goals reported across separate onGoalComplete calls", async () => {
      const prCalls = captureGhPrCreate([
        "https://github.com/test/pr/1",
        "https://github.com/test/pr/2",
      ]);

      const mgr = new SourceControlManager(
        "/repo",
        makeConfig({ strategy: "remote_pr", stack_prs: true }),
        new SwarmEventBus(),
      );
      await mgr.createSessionBranch("sess-abc12345");

      await mgr.onGoalComplete("goal-1", "First goal");
      await mgr.onGoalComplete("goal-2", "Second goal");

      expect(prCalls).toHaveLength(2);
      expect(prCalls[0].base).toBe("main");
      expect(prCalls[1].base).toBe(prCalls[0].head);
    });

    it("throws a clear error if a goal branch fails to push (no local-only landing)", async () => {
      mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
        const args = rawArgs as string[];
        if (cmd === "git" && args.includes("push")) {
          cb(new Error("remote rejected"), "", "");
          return;
        }
        cb(null, cmd === "gh" ? "https://github.com/test/pr/1\n" : "", "");
      });

      const mgr = new SourceControlManager(
        "/repo",
        makeConfig({ strategy: "remote_pr", stack_prs: true }),
        new SwarmEventBus(),
      );
      await mgr.createSessionBranch("sess-abc12345");

      await expect(
        mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First goal" }]),
      ).rejects.toThrow(/local-only/);
    });

    it("throws a clear error if a pushed branch gets no PR URL", async () => {
      mockExecFile.mockImplementation((cmd: string, _rawArgs: unknown, _opts: unknown, cb: Function) => {
        // gh returns empty stdout — branch pushed but PR not opened.
        cb(null, cmd === "gh" ? "  \n" : "", "");
      });

      const mgr = new SourceControlManager(
        "/repo",
        makeConfig({ strategy: "remote_pr", stack_prs: true }),
        new SwarmEventBus(),
      );
      await mgr.createSessionBranch("sess-abc12345");

      await expect(
        mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First goal" }]),
      ).rejects.toThrow(/no PR URL/);
    });
  });

  // -------------------------------------------------------------------------
  // Session end
  // -------------------------------------------------------------------------

  describe("onSessionEnd", () => {
    it("pushes for remote_pr strategy when not already pushed", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
        const args = _args as string[];
        // Fail push during onGoalComplete so _pushed stays false
        if (_cmd === "git" && args.includes("push")) {
          cb(new Error("push failed"), "", "");
        } else {
          cb(null, "", "");
        }
      });

      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "remote_pr" }));
      await mgr.createSessionBranch("sess-abc12345");
      await mgr.onGoalComplete("goal-1", "Test goal"); // push fails, _pushed stays false

      // Reset so onSessionEnd push succeeds
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
        cb(null, "", "");
      });

      await mgr.onSessionEnd();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["push"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("skips push if onGoalComplete already pushed", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "remote_pr" }));
      await mgr.createSessionBranch("sess-abc12345");
      await mgr.onGoalComplete("goal-1", "Test goal"); // push succeeds, _pushed = true

      vi.resetAllMocks();
      mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
        cb(null, "", "");
      });

      await mgr.onSessionEnd();

      // Should not have called any git commands since _pushed is already true
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("is no-op for ephemeral strategy", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "ephemeral" }));
      await mgr.onSessionEnd();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Restore base branch
  // -------------------------------------------------------------------------

  describe("restoreBaseBranch", () => {
    it("checks out main by default", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));
      await mgr.restoreBaseBranch();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["checkout", "main"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("checks out custom base branch", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({
        strategy: "local_branch",
        base_branch: "develop",
      }));
      await mgr.restoreBaseBranch();

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["checkout", "develop"],
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Default config values
  // -------------------------------------------------------------------------

  describe("defaults", () => {
    it("uses origin as default remote", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "remote_pr" }));
      await mgr.createSessionBranch("sess-abc12345");
      await mgr.onGoalComplete("goal-1", "Test goal");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["origin"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses swarm/ as default branch prefix", async () => {
      const mgr = new SourceControlManager("/repo", makeConfig({ strategy: "local_branch" }));
      const branch = await mgr.createSessionBranch("sess-abc12345");
      expect(branch).toMatch(/^swarm\//);
    });
  });
});

// ---------------------------------------------------------------------------
// PR titles: the whole goal description, capped only at GitHub's 256-char
// title limit and never cut mid-word.
// ---------------------------------------------------------------------------

describe("formatPrTitle", () => {
  it("keeps a long description whole when it fits", () => {
    const desc = "Add the weekly summary panel to the dashboard, with each project's open items and who owns them";
    expect(desc.length).toBeGreaterThan(60);
    expect(formatPrTitle(desc)).toBe(`swarm: ${desc}`);
  });

  it("caps at 256 characters, cutting on a word boundary with an ellipsis", () => {
    const desc = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const title = formatPrTitle(desc);
    expect([...title].length).toBeLessThanOrEqual(256);
    expect(title.endsWith("…")).toBe(true);
    const body = title.slice("swarm: ".length, -1);
    // Every kept word is a whole word from the description.
    expect(desc.startsWith(body)).toBe(true);
    expect(desc.charAt(body.length)).toBe(" ");
  });

  it("hard-cuts a single word longer than the limit", () => {
    const title = formatPrTitle("x".repeat(400));
    expect([...title].length).toBe(256);
    expect(title.endsWith("x…")).toBe(true);
  });

  it("puts a multi-line description on one line", () => {
    expect(formatPrTitle("Fix the summary panel\n\nIt shows the wrong  owner")).toBe(
      "swarm: Fix the summary panel It shows the wrong owner",
    );
  });
});

describe("PR titles passed to gh", () => {
  const LONG = "Add the weekly summary panel to the dashboard, with each project's open items and who owns them";

  function captureTitles(): string[] {
    const titles: string[] = [];
    mockExecFile.mockImplementation((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
      const args = rawArgs as string[];
      if (cmd === "gh") {
        titles.push(args[args.indexOf("--title") + 1]);
        cb(null, "https://github.com/test/pr/1\n", "");
        return;
      }
      cb(null, "", "");
    });
    return titles;
  }

  it("uses the full description for a stacked PR", async () => {
    const titles = captureTitles();
    const mgr = new SourceControlManager("/repo", { strategy: "remote_pr", stack_prs: true });
    await mgr.createSessionBranch("sess-abc12345");
    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: LONG }]);
    expect(titles).toEqual([`swarm: ${LONG}`]);
  });

  it("uses the full description for a session PR", async () => {
    const titles = captureTitles();
    const mgr = new SourceControlManager("/repo", { strategy: "remote_pr" });
    await mgr.createSessionBranch("sess-abc12345");
    await mgr.onGoalComplete("goal-1", LONG);
    expect(titles).toEqual([`swarm: ${LONG}`]);
  });
});
