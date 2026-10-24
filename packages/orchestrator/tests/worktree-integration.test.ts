/**
 * Integration test for WorktreeManager using a real temporary git repo.
 *
 * These tests exercise actual git operations — they create temporary
 * directories, init repos, create worktrees, write files, and merge.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "../src/worktree/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { WorktreeCreatedEvent, WorktreeChangedEvent, WorktreeMergedEvent, WorktreeConflictEvent } from "@mnmal-ai/swarm-types";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

describe("WorktreeManager Integration", () => {
  let repoDir: string;
  let eventBus: SwarmEventBus;

  beforeEach(async () => {
    // Create a temp directory with a real git repo
    repoDir = await mkdtemp(join(tmpdir(), "swarm-wt-test-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@test.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);

    // Create initial commit
    await writeFile(join(repoDir, "README.md"), "# Test Repo\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "Initial commit"]);

    eventBus = new SwarmEventBus();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("creates worktrees and verifies they exist", async () => {
    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const wt1 = await manager.create("task-1");
    const wt2 = await manager.create("task-2");

    expect(wt1.status).toBe("active");
    expect(wt2.status).toBe("active");
    expect(manager.getAll()).toHaveLength(2);

    // Verify git worktree list shows them
    const listOutput = await git(repoDir, ["worktree", "list"]);
    expect(listOutput).toContain("task-1");
    expect(listOutput).toContain("task-2");

    await manager.destroyAll();
  });

  it("writes different files in each worktree and polls changes", async () => {
    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const wt1 = await manager.create("task-1");
    const wt2 = await manager.create("task-2");

    // Write different files in each worktree
    await writeFile(join(wt1.path, "file1.ts"), "export const a = 1;\n");
    await writeFile(join(wt2.path, "file2.ts"), "export const b = 2;\n");

    // Poll changes
    const info1 = await manager.pollChanges("task-1");
    const info2 = await manager.pollChanges("task-2");

    expect(info1.filesChanged).toContain("file1.ts");
    expect(info2.filesChanged).toContain("file2.ts");

    await manager.destroyAll();
  });

  it("merges non-conflicting worktrees back to main", async () => {
    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const wt1 = await manager.create("task-1");
    const wt2 = await manager.create("task-2");

    // Write and commit different files in each worktree
    await writeFile(join(wt1.path, "file1.ts"), "export const a = 1;\n");
    await git(wt1.path, ["add", "."]);
    await git(wt1.path, ["commit", "-m", "Add file1"]);

    await writeFile(join(wt2.path, "file2.ts"), "export const b = 2;\n");
    await git(wt2.path, ["add", "."]);
    await git(wt2.path, ["commit", "-m", "Add file2"]);

    // Merge first worktree
    const result1 = await manager.merge("task-1");
    expect(result1.success).toBe(true);

    // Merge second worktree
    const result2 = await manager.merge("task-2");
    expect(result2.success).toBe(true);

    // Verify main branch has both files
    const mainFiles = await git(repoDir, ["ls-files"]);
    expect(mainFiles).toContain("file1.ts");
    expect(mainFiles).toContain("file2.ts");

    await manager.destroyAll();
  });

  it("detects merge conflicts when two worktrees modify the same file", async () => {
    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    const wt1 = await manager.create("task-1");
    const wt2 = await manager.create("task-2");

    // Both worktrees modify README.md differently
    await writeFile(join(wt1.path, "README.md"), "# Modified by task 1\n");
    await git(wt1.path, ["add", "."]);
    await git(wt1.path, ["commit", "-m", "Modify README from task-1"]);

    await writeFile(join(wt2.path, "README.md"), "# Modified by task 2\n");
    await git(wt2.path, ["add", "."]);
    await git(wt2.path, ["commit", "-m", "Modify README from task-2"]);

    // First merge succeeds
    const result1 = await manager.merge("task-1");
    expect(result1.success).toBe(true);

    // Second merge should detect conflict
    const conflictEvents: WorktreeConflictEvent[] = [];
    eventBus.on("worktree:conflict", (e) => conflictEvents.push(e));

    const result2 = await manager.merge("task-2");
    expect(result2.success).toBe(false);
    expect(result2.conflictFiles).toBeDefined();
    expect(result2.conflictFiles!.length).toBeGreaterThan(0);

    // Verify conflict event was emitted
    expect(conflictEvents.length).toBeGreaterThan(0);
    expect(conflictEvents[0].conflictFiles).toContain("README.md");

    await manager.destroyAll();
  });

  it("cleanup auto-merge merges and destroys on success", async () => {
    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
      cleanupStrategy: "auto-merge",
    }, eventBus);

    const wt1 = await manager.create("task-1");

    // Write and commit a file
    await writeFile(join(wt1.path, "feature.ts"), "export function feature() {}\n");
    await git(wt1.path, ["add", "."]);
    await git(wt1.path, ["commit", "-m", "Add feature"]);

    // Cleanup should merge and destroy
    await manager.cleanup("task-1", true);

    expect(manager.get("task-1")).toBeUndefined();

    // Verify main has the file
    const mainFiles = await git(repoDir, ["ls-files"]);
    expect(mainFiles).toContain("feature.ts");
  });

  it("emits worktree:created event on creation", async () => {
    const events: WorktreeCreatedEvent[] = [];
    eventBus.on("worktree:created", (e) => events.push(e));

    const manager = new WorktreeManager(repoDir, {
      baseDir: join(repoDir, ".swarm", "worktrees"),
    }, eventBus);

    await manager.create("task-1");

    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe("task-1");
    expect(events[0].branch).toMatch(/^swarm-worker\/task-1-[a-z0-9]{4}$/);

    await manager.destroyAll();
  });
});
