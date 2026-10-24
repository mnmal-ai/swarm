/**
 * WorktreeManager — Git worktree isolation for concurrent agent execution.
 *
 * Creates and manages git worktrees so multiple workers can operate on the
 * same repo without file conflicts. Each worker gets its own worktree with
 * a dedicated branch, and changes are merged back after task completion.
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import type {
  WorktreeInfo,
  WorktreeConfig,
  WorktreeCleanupStrategy,
  ISwarmEventBus,
  PruneResult,
  GitIdentity,
  CommitStyle,
} from "@mnmal-ai/swarm-types";
import { recordConflict } from "../orchestrator/conflict-history.js";
import { gitIdentityEnv, mergeCommitMessage } from "../source-control/commit-policy.js";

function execFileAsync(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/-+/g, "-");
}

function parseInsertionsDeletions(diffStatOutput: string): { insertions: number; deletions: number } {
  // Parse summary line: " 2 files changed, 10 insertions(+), 3 deletions(-)"
  const match = diffStatOutput.match(/(\d+)\s+insertion|(\d+)\s+deletion/g);
  let insertions = 0;
  let deletions = 0;
  if (match) {
    for (const m of match) {
      const num = parseInt(m, 10);
      if (m.includes("insertion")) insertions = num;
      if (m.includes("deletion")) deletions = num;
    }
  }
  return { insertions, deletions };
}

function parsePorcelainFiles(output: string): string[] {
  return output
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => line.slice(3).trim());
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly baseDir: string;
  private readonly branchPrefix: string;
  private readonly cleanupStrategy: WorktreeCleanupStrategy;
  private readonly eventBus?: ISwarmEventBus;
  private readonly conflictHistoryPath?: string;
  private readonly gitIdentity?: GitIdentity;
  private readonly commitStyle?: CommitStyle;
  private readonly worktrees = new Map<string, WorktreeInfo>();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private mergeLock: Promise<void> = Promise.resolve();

  constructor(repoRoot: string, config?: WorktreeConfig, eventBus?: ISwarmEventBus) {
    this.repoRoot = repoRoot;
    this.baseDir = config?.baseDir ?? join(repoRoot, ".swarm", "worktrees");
    this.branchPrefix = config?.branchPrefix ?? "swarm-worker/";
    this.cleanupStrategy = config?.cleanupStrategy ?? "auto-merge";
    this.eventBus = eventBus;
    this.conflictHistoryPath = config?.conflictHistoryPath;
    this.gitIdentity = config?.gitIdentity;
    this.commitStyle = config?.commitStyle;
  }

  /**
   * Clean up stale worktrees and orphaned swarm-worker branches.
   *
   * Should be called at the start of every orchestration run to prevent
   * "branch already exists" / "worktree path already exists" failures
   * from previous runs.
   *
   * Steps:
   * 1. `git worktree prune` — clean up stale worktree metadata
   * 2. List all active worktree branches
   * 3. List all `swarm-worker/*` branches
   * 4. Delete branches that have no active worktree (orphans from prior runs)
   */
  async pruneStale(): Promise<PruneResult> {
    const deletedBranches: string[] = [];
    let worktreesPruned = 0;

    // Step 1: Prune stale worktree metadata (isolated try/catch so failure
    // does not block branch cleanup in Steps 3-4)
    try {
      await this.git(this.repoRoot, ["worktree", "prune"]);
      worktreesPruned = 1;
    } catch {
      // git worktree prune may fail in some edge cases — continue to branch cleanup
    }

    // Step 2: List active worktree branches. If this fails, we MUST skip
    // branch deletion (Step 4) because an empty set would cause us to
    // delete ALL prefixed branches — including those with active worktrees.
    let worktreeListSucceeded = false;
    const activeWorktreeBranches = new Set<string>();
    try {
      const { stdout: worktreeList } = await this.git(this.repoRoot, ["worktree", "list", "--porcelain"]);
      for (const line of worktreeList.split("\n")) {
        if (line.startsWith("branch ")) {
          // "branch refs/heads/swarm-worker/task-1" → "swarm-worker/task-1"
          activeWorktreeBranches.add(line.replace("branch refs/heads/", ""));
        }
      }
      worktreeListSucceeded = true;
    } catch {
      // Transient failure — skip branch deletion to avoid data loss
    }

    // Steps 3-4 only run if we successfully enumerated active worktrees
    if (worktreeListSucceeded) {
      // Step 3: List all branches matching our prefix
      const allPrefixedBranches: string[] = [];
      try {
        const { stdout: branchList } = await this.git(this.repoRoot, [
          "for-each-ref",
          "--format=%(refname:short)",
          `refs/heads/${this.branchPrefix}*`,
        ]);
        for (const line of branchList.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) allPrefixedBranches.push(trimmed);
        }
      } catch {
        // No matching branches — nothing to clean
      }

      // Step 4: Delete orphaned branches (exist as branches but have no worktree)
      for (const branch of allPrefixedBranches) {
        if (!activeWorktreeBranches.has(branch)) {
          try {
            await this.git(this.repoRoot, ["branch", "-D", branch]);
            deletedBranches.push(branch);
          } catch {
            // Branch may be checked out or otherwise locked — skip
          }
        }
      }
    }

    const result: PruneResult = {
      prunedWorktrees: worktreesPruned,
      deletedBranches,
    };

    this.eventBus?.emit("worktree:pruned", {
      prunedWorktrees: result.prunedWorktrees,
      deletedBranches: result.deletedBranches,
      timestamp: Date.now(),
    });

    return result;
  }

  async create(taskId: string, baseBranch?: string): Promise<WorktreeInfo> {
    const resolvedBase = baseBranch ?? await this.getCurrentBranch();
    // Append a short random suffix to avoid branch name collisions across runs
    const suffix = randomUUID().slice(0, 4);
    const sanitized = sanitizeBranchName(taskId);
    const branch = `${this.branchPrefix}${sanitized}-${suffix}`;
    const worktreePath = resolve(join(this.baseDir, sanitized));

    // Prevent path traversal — taskId must not escape baseDir
    if (!worktreePath.startsWith(resolve(this.baseDir) + "/")) {
      throw new Error(`Invalid taskId — would escape base directory: ${taskId}`);
    }

    // If the worktree path already exists (stale from a previous run), clean it up.
    // Try git worktree remove first, then fall back to removing the directory
    // (handles cases where the path exists but isn't registered as a worktree).
    try {
      await this.git(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      // Not a registered worktree — remove the directory if it exists
      const { rm } = await import("node:fs/promises");
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Directory doesn't exist — that's fine
      }
    }
    // Prune any stale worktree references that point to deleted directories
    try {
      await this.git(this.repoRoot, ["worktree", "prune"]);
    } catch {
      // Non-fatal
    }

    await this.git(this.repoRoot, ["worktree", "add", "-b", branch, worktreePath, resolvedBase]);

    // Copy .mcp.json into the worktree so MCP tools are available to workers
    const mcpJsonSrc = join(this.repoRoot, ".mcp.json");
    const mcpJsonDst = join(worktreePath, ".mcp.json");
    if (existsSync(mcpJsonSrc)) {
      copyFileSync(mcpJsonSrc, mcpJsonDst);
    }

    // Copy .claude/ settings files into the worktree so Claude Code picks
    // up project-level settings (permissions, commands, etc.)
    const claudeDirSrc = join(this.repoRoot, ".claude");
    const claudeDirDst = join(worktreePath, ".claude");
    if (existsSync(claudeDirSrc)) {
      // Only copy project-level settings.json (checked into git).
      // settings.local.json is gitignored and typically contains personal
      // tokens, env overrides, and tool permissions — do NOT propagate
      // it to worker worktrees where worker code could read it.
      const src = join(claudeDirSrc, "settings.json");
      if (existsSync(src)) {
        mkdirSync(claudeDirDst, { recursive: true });
        copyFileSync(src, join(claudeDirDst, "settings.json"));
      }
    }

    const info: WorktreeInfo = {
      id: taskId,
      path: worktreePath,
      branch,
      baseBranch: resolvedBase,
      taskId,
      status: "active",
      filesChanged: [],
      createdAt: Date.now(),
      lastCheckedAt: Date.now(),
    };

    this.worktrees.set(taskId, info);

    this.eventBus?.emit("worktree:created", {
      worktreeId: taskId,
      taskId,
      path: worktreePath,
      branch,
      baseBranch: resolvedBase,
      timestamp: Date.now(),
    });

    return info;
  }

  get(taskId: string): WorktreeInfo | undefined {
    return this.worktrees.get(taskId);
  }

  getAll(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  async pollChanges(taskId: string): Promise<WorktreeInfo> {
    const info = this.worktrees.get(taskId);
    if (!info) throw new Error(`No worktree found for task: ${taskId}`);

    const { stdout: statusOutput } = await this.git(info.path, ["status", "--porcelain"]);
    const files = parsePorcelainFiles(statusOutput);

    const previousFiles = [...info.filesChanged];
    info.filesChanged = files;
    info.lastCheckedAt = Date.now();

    // Only emit if there are changed files and the list actually changed
    if (files.length > 0 && JSON.stringify(files) !== JSON.stringify(previousFiles)) {
      const { stdout: diffOutput } = await this.git(info.path, ["diff", "--stat", "HEAD"]);
      const { insertions, deletions } = parseInsertionsDeletions(diffOutput);

      this.eventBus?.emit("worktree:changed", {
        worktreeId: taskId,
        taskId,
        path: info.path,
        filesChanged: files,
        insertions,
        deletions,
        timestamp: Date.now(),
      });
    }

    return info;
  }

  startPolling(intervalMs = 3000): void {
    if (this.pollingInterval) return;
    this.pollingInterval = setInterval(async () => {
      if (this.pollInFlight) return; // Skip if previous cycle still running
      this.pollInFlight = true;
      try {
        for (const [taskId, info] of this.worktrees) {
          if (info.status === "active") {
            try {
              await this.pollChanges(taskId);
            } catch {
              // Polling failure is not critical — skip this cycle
            }
          }
        }
      } finally {
        this.pollInFlight = false;
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Stage and commit all changes in a worktree. Must be called before merge()
   * to ensure the worktree branch has commits that can be merged.
   * Returns true if a commit was created, false if the worktree was clean.
   *
   * Uses `git add -A` which respects .gitignore but stages all other changes.
   * Uses `--no-verify` to skip pre-commit hooks — these are automated agent
   * commits in isolated worktree branches that are merged and deleted. Hooks
   * on the target branch run during the merge step.
   */
  async commitChanges(taskId: string, message: string): Promise<boolean> {
    const info = this.worktrees.get(taskId);
    if (!info) return false;

    const { stdout } = await this.git(info.path, ["status", "--porcelain"]);
    if (!stdout.trim()) return false;

    await this.git(info.path, ["add", "-A"]);
    await this.gitCommitting(info.path, ["commit", "-m", message, "--no-verify"]);

    return true;
  }

  /**
   * Merge a worktree branch back into the target branch.
   *
   * **Important:** This method temporarily switches HEAD in `repoRoot` via
   * `git checkout`. Callers must not read from `repoRoot` during cleanup.
   * During parallel dispatch this is safe because workers operate in their
   * own worktrees and merges are serialized via `mergeLock`. The original
   * branch is restored in a `finally` block.
   */
  async merge(taskId: string, targetBranch?: string): Promise<{ success: boolean; conflictFiles?: string[] }> {
    const info = this.worktrees.get(taskId);
    if (!info) throw new Error(`No worktree found for task: ${taskId}`);

    const target = targetBranch ?? info.baseBranch;
    info.status = "merging";

    // Serialize merges to prevent race conditions
    const result = await new Promise<{ success: boolean; conflictFiles?: string[] }>((resolve, reject) => {
      this.mergeLock = this.mergeLock.then(async () => {
        // Capture the original branch so we can restore it after merge
        let originalBranch: string | null = null;
        try {
          const { stdout } = await this.git(this.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
          originalBranch = stdout.trim();
        } catch {
          // If we can't determine the original branch, proceed anyway
        }

        try {
          // Get files that changed for the event
          const { stdout: statusOutput } = await this.git(info.path, ["status", "--porcelain"]);
          const filesChanged = parsePorcelainFiles(statusOutput);

          // Defense-in-depth: warn if uncommitted changes exist on a branch
          // with no commits ahead of target — they'll be lost after merge + destroy.
          // This means commitChanges() was not called or failed silently.
          if (filesChanged.length > 0) {
            try {
              const { stdout: aheadOutput } = await this.git(this.repoRoot, ["rev-list", "--count", `${target}..${info.branch}`]);
              if (parseInt(aheadOutput.trim(), 10) === 0) {
                this.eventBus?.emit("worktree:uncommitted-changes", {
                  worktreeId: taskId,
                  taskId,
                  branch: info.branch,
                  uncommittedFiles: filesChanged,
                  timestamp: Date.now(),
                });
              }
            } catch {
              // rev-list may fail — non-blocking diagnostic
            }
          }

          // Capture committed file diff before merging (porcelain status
          // is empty after commitChanges() — we need the branch diff).
          let committedFiles: string[] = [];
          try {
            const { stdout: diffOutput } = await this.git(this.repoRoot, ["diff", "--name-only", `${target}...${info.branch}`]);
            committedFiles = diffOutput.split("\n").filter(f => f.trim().length > 0);
          } catch {
            // diff may fail on new branches with no common ancestor — non-blocking
          }

          // Merge from the repo root
          await this.git(this.repoRoot, ["checkout", target]);
          const mergeMessage = mergeCommitMessage(info.branch, this.commitStyle);
          await this.gitCommitting(this.repoRoot, [
            "merge", "--no-ff", ...(mergeMessage ? ["-m", mergeMessage] : []), info.branch,
          ]);

          info.status = "merged";

          this.eventBus?.emit("worktree:merged", {
            worktreeId: taskId,
            taskId,
            branch: info.branch,
            targetBranch: target,
            filesChanged: committedFiles,
            timestamp: Date.now(),
          });

          resolve({ success: true });
        } catch {
          // Merge failed — likely a conflict
          try {
            const { stdout: conflictOutput } = await this.git(this.repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
            const conflictFiles = conflictOutput.split("\n").filter(f => f.trim().length > 0);

            // Abort the failed merge
            try {
              await this.git(this.repoRoot, ["merge", "--abort"]);
            } catch {
              // merge --abort may fail if no merge in progress
            }

            info.status = "conflict";

            this.eventBus?.emit("worktree:conflict", {
              worktreeId: taskId,
              taskId,
              branch: info.branch,
              conflictFiles,
              timestamp: Date.now(),
            });

            // Record conflict in history for automatic serialization learning
            if (this.conflictHistoryPath && conflictFiles.length > 0) {
              try {
                recordConflict(this.conflictHistoryPath, conflictFiles);
              } catch {
                // Conflict recording is best-effort — don't fail the merge flow
              }
            }

            resolve({ success: false, conflictFiles });
          } catch {
            info.status = "failed";
            resolve({ success: false, conflictFiles: [] });
          }
        } finally {
          // Restore the original branch to avoid leaving the repo in an unexpected state
          if (originalBranch && originalBranch !== target) {
            try {
              await this.git(this.repoRoot, ["checkout", originalBranch]);
            } catch {
              // Best-effort restore — if this fails, the repo is on the target branch
            }
          }
        }
      }).catch((err: unknown) => {
        // Unexpected synchronous or unhandled error — reject outer Promise
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    return result;
  }

  async destroy(taskId: string, deleteBranch = false): Promise<void> {
    const info = this.worktrees.get(taskId);
    if (!info) return;

    try {
      await this.git(this.repoRoot, ["worktree", "remove", info.path]);
    } catch {
      // Force remove if normal remove fails
      try {
        await this.git(this.repoRoot, ["worktree", "remove", "--force", info.path]);
      } catch {
        // Already removed or doesn't exist
      }
    }

    if (deleteBranch) {
      try {
        await this.git(this.repoRoot, ["branch", "-d", info.branch]);
      } catch {
        // Branch may not exist or may not be fully merged
      }
    }

    this.worktrees.delete(taskId);

    this.eventBus?.emit("worktree:destroyed", {
      worktreeId: taskId,
      taskId,
      reason: "manual",
      timestamp: Date.now(),
    });
  }

  async cleanup(taskId: string, taskSucceeded: boolean): Promise<void> {
    const info = this.worktrees.get(taskId);
    if (!info) return;

    switch (this.cleanupStrategy) {
      case "auto-merge":
        if (taskSucceeded) {
          const mergeResult = await this.merge(taskId);
          if (mergeResult.success) {
            await this.forceDestroy(taskId, "merged");
          }
          // On conflict, leave worktree in place
        }
        // On failure, leave worktree in place
        break;

      case "leave-for-review":
        // Always leave worktree intact
        break;

      case "discard":
        await this.forceDestroy(taskId, "discarded");
        break;
    }
  }

  async destroyAll(): Promise<void> {
    const taskIds = [...this.worktrees.keys()];
    for (const taskId of taskIds) {
      await this.forceDestroy(taskId, "manual");
    }
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git(this.repoRoot, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    const { stdout } = await this.git(this.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { stdout, stderr };
  }

  /** A git command that creates a commit: runs as the configured identity. */
  private async gitCommitting(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { cwd, env: gitIdentityEnv(this.gitIdentity) });
  }

  private async forceDestroy(taskId: string, reason: "merged" | "discarded" | "failed" | "manual"): Promise<void> {
    const info = this.worktrees.get(taskId);
    if (!info) return;

    try {
      await this.git(this.repoRoot, ["worktree", "remove", info.path]);
    } catch {
      try {
        await this.git(this.repoRoot, ["worktree", "remove", "--force", info.path]);
      } catch {
        // Already removed
      }
    }

    try {
      await this.git(this.repoRoot, ["branch", "-D", info.branch]);
    } catch {
      // Branch may not exist
    }

    this.worktrees.delete(taskId);

    this.eventBus?.emit("worktree:destroyed", {
      worktreeId: taskId,
      taskId,
      reason,
      timestamp: Date.now(),
    });
  }
}
