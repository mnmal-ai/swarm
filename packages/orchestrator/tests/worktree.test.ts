import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../src/worktree/index.js";
import type { ISwarmEventBus, WorktreeConfig } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

function setupExecFile(responses: Record<string, { stdout?: string; stderr?: string; error?: Error & { code?: number } }>) {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const key = `${cmd} ${args.join(" ")}`;
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          if (response.error) {
            cb(response.error, response.stdout ?? "", response.stderr ?? "");
          } else {
            cb(null, response.stdout ?? "", response.stderr ?? "");
          }
          return;
        }
      }
      // Default: success with empty output
      cb(null, "", "");
    },
  );
}

// ---------------------------------------------------------------------------
// Mock event bus
// ---------------------------------------------------------------------------

function createMockEventBus(): ISwarmEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    onAny: vi.fn(() => () => {}),
    removeAllListeners: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeManager", () => {
  let manager: WorktreeManager;
  let eventBus: ISwarmEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees" }, eventBus);
  });

  afterEach(() => {
    manager.stopPolling();
  });

  describe("create()", () => {
    it("runs git worktree add and emits worktree:created", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      const info = await manager.create("task-1");

      expect(info.id).toBe("task-1");
      expect(info.taskId).toBe("task-1");
      expect(info.branch).toMatch(/^swarm-worker\/task-1-[a-z0-9]{4}$/);
      expect(info.baseBranch).toBe("main");
      expect(info.path).toBe("/repo/.swarm/worktrees/task-1");
      expect(info.status).toBe("active");

      expect(eventBus.emit).toHaveBeenCalledWith("worktree:created", expect.objectContaining({
        worktreeId: "task-1",
        taskId: "task-1",
        path: "/repo/.swarm/worktrees/task-1",
        branch: expect.stringMatching(/^swarm-worker\/task-1-[a-z0-9]{4}$/),
        baseBranch: "main",
      }));
    });

    it("uses custom baseBranch when provided", async () => {
      setupExecFile({
        "worktree add": { stdout: "" },
      });

      const info = await manager.create("task-2", "develop");

      expect(info.baseBranch).toBe("develop");
    });

    it("uses custom branchPrefix from config", async () => {
      manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees", branchPrefix: "wt/" }, eventBus);

      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      const info = await manager.create("task-3");

      expect(info.branch).toMatch(/^wt\/task-3-[a-z0-9]{4}$/);
    });

    it("rejects task IDs that would escape the base directory", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      });

      await expect(manager.create("..")).rejects.toThrow("would escape base directory");
    });
  });

  describe("get() / getAll()", () => {
    it("returns WorktreeInfo after creation", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      await manager.create("task-1");
      const info = manager.get("task-1");

      expect(info).toBeDefined();
      expect(info!.taskId).toBe("task-1");
    });

    it("returns undefined for unknown task", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("getAll() returns all active worktrees", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      await manager.create("task-1");
      await manager.create("task-2");

      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(w => w.id)).toEqual(["task-1", "task-2"]);
    });
  });

  describe("pollChanges()", () => {
    it("parses git status --porcelain and git diff --stat output", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n?? src/bar.ts\n" },
        "diff --stat HEAD": { stdout: " src/foo.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)\n" },
      });

      await manager.create("task-1");
      const info = await manager.pollChanges("task-1");

      expect(info.filesChanged).toEqual(["src/foo.ts", "src/bar.ts"]);
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:changed", expect.objectContaining({
        worktreeId: "task-1",
        filesChanged: ["src/foo.ts", "src/bar.ts"],
        insertions: 3,
        deletions: 2,
      }));
    });

    it("emits nothing when no files changed", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: "" },
        "diff --stat HEAD": { stdout: "" },
      });

      await manager.create("task-1");
      // Reset emit calls from creation
      (eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      await manager.pollChanges("task-1");

      // Should not emit worktree:changed when no files
      const changedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "worktree:changed"
      );
      expect(changedCalls).toHaveLength(0);
    });
  });

  describe("merge()", () => {
    it("runs git merge --no-ff on success and emits worktree:merged", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n" },
        "diff --stat HEAD": { stdout: " src/foo.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n" },
        "checkout main": { stdout: "" },
        "merge --no-ff": { stdout: "" },
      });

      await manager.create("task-1");
      const result = await manager.merge("task-1");

      expect(result.success).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:merged", expect.objectContaining({
        worktreeId: "task-1",
        branch: expect.stringMatching(/^swarm-worker\/task-1-[a-z0-9]{4}$/),
        targetBranch: "main",
      }));
    });

    it("detects merge conflicts and emits worktree:conflict", async () => {
      const mergeError = new Error("merge conflict") as Error & { code?: number };
      mergeError.code = 1;

      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n" },
        "diff --stat HEAD": { stdout: "" },
        "checkout main": { stdout: "" },
        "merge --no-ff": { error: mergeError, stderr: "" },
        "diff --name-only --diff-filter=U": { stdout: "src/foo.ts\nsrc/bar.ts\n" },
        "merge --abort": { stdout: "" },
      });

      await manager.create("task-1");
      const result = await manager.merge("task-1");

      expect(result.success).toBe(false);
      expect(result.conflictFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:conflict", expect.objectContaining({
        worktreeId: "task-1",
        conflictFiles: ["src/foo.ts", "src/bar.ts"],
      }));
    });

    it("serializes concurrent merge() calls via mergeLock", async () => {
      // Track the order of merge operations
      const mergeOrder: string[] = [];

      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n" },
        "diff --stat HEAD": { stdout: "" },
        "checkout main": { stdout: "" },
      });

      // Override merge to track call order with artificial delay
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          const key = `${cmd} ${args.join(" ")}`;
          if (key.includes("merge --no-ff")) {
            const branch = args[args.length - 1];
            setTimeout(() => {
              mergeOrder.push(branch);
              cb(null, "", "");
            }, 20);
            return;
          }
          // Default: immediate success
          cb(null, key.includes("status --porcelain") ? " M src/foo.ts\n" : key.includes("rev-parse --abbrev-ref") ? "main\n" : "", "");
        },
      );

      await manager.create("task-1");
      await manager.create("task-2");

      // Fire both merges concurrently
      const [result1, result2] = await Promise.all([
        manager.merge("task-1"),
        manager.merge("task-2"),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Merges must have been serialized — task-1 completes before task-2 starts
      expect(mergeOrder).toHaveLength(2);
      expect(mergeOrder[0]).toMatch(/^swarm-worker\/task-1-/);
      expect(mergeOrder[1]).toMatch(/^swarm-worker\/task-2-/);
    });
  });

  describe("destroy()", () => {
    it("runs git worktree remove and optionally deletes branch", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "worktree remove": { stdout: "" },
        "branch -d": { stdout: "" },
      });

      await manager.create("task-1");
      await manager.destroy("task-1", true);

      expect(manager.get("task-1")).toBeUndefined();
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:destroyed", expect.objectContaining({
        worktreeId: "task-1",
        reason: "manual",
      }));
    });
  });

  describe("cleanup()", () => {
    it("auto-merge: merges then destroys on task success", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n" },
        "diff --stat HEAD": { stdout: "" },
        "checkout main": { stdout: "" },
        "merge --no-ff": { stdout: "" },
        "worktree remove": { stdout: "" },
        "branch -d": { stdout: "" },
      });

      manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees", cleanupStrategy: "auto-merge" }, eventBus);
      await manager.create("task-1");
      await manager.cleanup("task-1", true);

      expect(manager.get("task-1")).toBeUndefined();
    });

    it("auto-merge: leaves worktree on task failure", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees", cleanupStrategy: "auto-merge" }, eventBus);
      await manager.create("task-1");
      await manager.cleanup("task-1", false);

      // Worktree should still exist
      expect(manager.get("task-1")).toBeDefined();
    });

    it("leave-for-review: leaves worktree intact regardless", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees", cleanupStrategy: "leave-for-review" }, eventBus);
      await manager.create("task-1");
      await manager.cleanup("task-1", true);

      expect(manager.get("task-1")).toBeDefined();
    });

    it("discard: destroys without merging", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "worktree remove": { stdout: "" },
        "branch -D": { stdout: "" },
      });

      manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees", cleanupStrategy: "discard" }, eventBus);
      await manager.create("task-1");
      await manager.cleanup("task-1", true);

      expect(manager.get("task-1")).toBeUndefined();
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:destroyed", expect.objectContaining({
        reason: "discarded",
      }));
    });
  });

  describe("destroyAll()", () => {
    it("cleans up all managed worktrees", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "worktree remove": { stdout: "" },
        "branch -D": { stdout: "" },
      });

      await manager.create("task-1");
      await manager.create("task-2");

      expect(manager.getAll()).toHaveLength(2);

      await manager.destroyAll();

      expect(manager.getAll()).toHaveLength(0);
    });
  });

  describe("commitChanges()", () => {
    it("commits dirty worktree files and returns true", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: " M src/foo.ts\n?? src/bar.ts\n" },
        "add -A": { stdout: "" },
        "commit -m": { stdout: "" },
      });

      await manager.create("task-1");
      const result = await manager.commitChanges("task-1", "swarm(task-1): fix concurrency");

      expect(result).toBe(true);

      // Verify git add -A and git commit were called in the worktree
      const calls = mockExecFile.mock.calls.map((c: unknown[]) => {
        const args = c[1] as string[];
        return args.join(" ");
      });
      expect(calls.some((c: string) => c.includes("add -A"))).toBe(true);
      expect(calls.some((c: string) => c.includes("commit -m"))).toBe(true);
    });

    it("returns false when worktree is clean", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: "" },
      });

      await manager.create("task-1");
      const result = await manager.commitChanges("task-1", "swarm(task-1): no changes");

      expect(result).toBe(false);
    });

    it("returns false for unknown taskId", async () => {
      const result = await manager.commitChanges("nonexistent", "some message");
      expect(result).toBe(false);
    });

    it("after commitChanges, merge brings changes to target branch", async () => {
      // Stateful mock: status returns dirty before commit, clean after
      let committed = false;

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          const key = `${cmd} ${args.join(" ")}`;
          if (key.includes("commit -m")) {
            committed = true;
            cb(null, "", "");
          } else if (key.includes("status --porcelain")) {
            cb(null, committed ? "" : " M src/foo.ts\n", "");
          } else if (key.includes("rev-parse --abbrev-ref HEAD")) {
            cb(null, "main\n", "");
          } else {
            cb(null, "", "");
          }
        },
      );

      await manager.create("task-1");

      // Commit first
      const commitResult = await manager.commitChanges("task-1", "swarm(task-1): fix");
      expect(commitResult).toBe(true);

      // Now merge — status should be clean, no uncommitted-changes warning
      const mergeResult = await manager.merge("task-1");
      expect(mergeResult.success).toBe(true);

      expect(eventBus.emit).toHaveBeenCalledWith("worktree:merged", expect.objectContaining({
        worktreeId: "task-1",
        branch: expect.stringMatching(/^swarm-worker\/task-1-[a-z0-9]{4}$/),
        targetBranch: "main",
      }));

      // Defense-in-depth should NOT fire since worktree is clean after commit
      const uncommittedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "worktree:uncommitted-changes"
      );
      expect(uncommittedCalls).toHaveLength(0);
    });
  });

  describe("branch name sanitization", () => {
    it("sanitizes task IDs with special characters", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
      });

      const info = await manager.create("task/with spaces&special!");

      expect(info.branch).toMatch(/^swarm-worker\/task-with-spaces-special--[a-z0-9]{4}$/);
      expect(info.id).toBe("task/with spaces&special!");
    });
  });

  describe("isGitRepo()", () => {
    it("returns true when git rev-parse succeeds", async () => {
      setupExecFile({
        "rev-parse --git-dir": { stdout: ".git\n" },
      });

      const result = await manager.isGitRepo();
      expect(result).toBe(true);
    });

    it("returns false when git rev-parse fails", async () => {
      setupExecFile({
        "rev-parse --git-dir": { error: new Error("not a git repo") },
      });

      const result = await manager.isGitRepo();
      expect(result).toBe(false);
    });
  });

  describe("getCurrentBranch()", () => {
    it("returns current branch name", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      });

      const branch = await manager.getCurrentBranch();
      expect(branch).toBe("main");
    });
  });

  describe("pruneStale()", () => {
    it("runs git worktree prune and deletes orphaned swarm-worker branches", async () => {
      setupExecFile({
        "worktree prune": { stdout: "" },
        "worktree list --porcelain": {
          stdout: [
            "worktree /repo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo/.swarm/worktrees/task-active",
            "HEAD def456",
            "branch refs/heads/swarm-worker/task-active",
            "",
          ].join("\n"),
        },
        "for-each-ref --format=%(refname:short) refs/heads/swarm-worker/*": {
          stdout: "swarm-worker/task-active\nswarm-worker/task-stale-1\nswarm-worker/task-stale-2\n",
        },
        "branch -D swarm-worker/task-stale-1": { stdout: "" },
        "branch -D swarm-worker/task-stale-2": { stdout: "" },
      });

      const result = await manager.pruneStale();

      expect(result.prunedWorktrees).toBe(1);
      expect(result.deletedBranches).toEqual(["swarm-worker/task-stale-1", "swarm-worker/task-stale-2"]);
      expect(eventBus.emit).toHaveBeenCalledWith("worktree:pruned", expect.objectContaining({
        prunedWorktrees: 1,
        deletedBranches: ["swarm-worker/task-stale-1", "swarm-worker/task-stale-2"],
      }));
    });

    it("does not delete branches that have active worktrees", async () => {
      setupExecFile({
        "worktree prune": { stdout: "" },
        "worktree list --porcelain": {
          stdout: [
            "worktree /repo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo/.swarm/worktrees/task-1",
            "HEAD def456",
            "branch refs/heads/swarm-worker/task-1",
            "",
          ].join("\n"),
        },
        "for-each-ref --format=%(refname:short) refs/heads/swarm-worker/*": {
          stdout: "swarm-worker/task-1\n",
        },
      });

      const result = await manager.pruneStale();

      expect(result.deletedBranches).toEqual([]);
    });

    it("handles no matching branches gracefully", async () => {
      setupExecFile({
        "worktree prune": { stdout: "" },
        "worktree list --porcelain": {
          stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n",
        },
        "for-each-ref --format=%(refname:short) refs/heads/swarm-worker/*": {
          stdout: "",
        },
      });

      const result = await manager.pruneStale();

      expect(result.deletedBranches).toEqual([]);
    });

    it("skips branch deletion if git worktree list fails (prevents data loss)", async () => {
      setupExecFile({
        "worktree prune": { stdout: "" },
        "worktree list --porcelain": { error: new Error("git error") },
      });

      const result = await manager.pruneStale();

      // When we can't enumerate active worktrees, we must NOT delete any
      // branches — an empty active set would cause all branches to look orphaned
      expect(result.deletedBranches).toEqual([]);
      expect(result.prunedWorktrees).toBe(1); // prune itself succeeded
    });

    it("continues with branch cleanup if git worktree prune fails", async () => {
      setupExecFile({
        "worktree prune": { error: new Error("prune failed") },
        "worktree list --porcelain": {
          stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n",
        },
        "for-each-ref --format=%(refname:short) refs/heads/swarm-worker/*": {
          stdout: "swarm-worker/orphan\n",
        },
        "branch -D swarm-worker/orphan": { stdout: "" },
      });

      const result = await manager.pruneStale();

      // prune failed but branch cleanup still ran
      expect(result.prunedWorktrees).toBe(0);
      expect(result.deletedBranches).toEqual(["swarm-worker/orphan"]);
    });
  });

  describe("startPolling() / stopPolling()", () => {
    it("starts and stops polling interval", async () => {
      setupExecFile({
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
        "worktree add": { stdout: "" },
        "status --porcelain": { stdout: "" },
        "diff --stat HEAD": { stdout: "" },
      });

      await manager.create("task-1");

      manager.startPolling(50);

      // Wait for one poll cycle
      await new Promise(resolve => setTimeout(resolve, 100));

      manager.stopPolling();

      // Verify that polling actually called git status --porcelain
      const calls = mockExecFile.mock.calls.map((c: unknown[]) => {
        const args = c[1] as string[];
        return args.join(" ");
      });
      expect(calls.some((c: string) => c.includes("status --porcelain"))).toBe(true);
    });
  });
});
