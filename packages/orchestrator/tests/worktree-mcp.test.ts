/**
 * MCP copied to worktrees
 * .claude/ copied to worktrees
 *
 * Tests that WorktreeManager.create() copies .mcp.json and .claude/settings.json
 * from repo root into the new worktree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../src/worktree/index.js";

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(async () => {}),
}));

import { execFile } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = vi.mocked(existsSync);
const mockCopyFileSync = vi.mocked(copyFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// ---------------------------------------------------------------------------
// Helper to set up execFile responses
// ---------------------------------------------------------------------------

function setupGitSuccess() {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, "main\n", "");
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeManager copies .mcp.json to worktree", () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees" });
  });

  afterEach(() => {
    manager.stopPolling();
  });

  it("copies .mcp.json when it exists at repo root", async () => {
    setupGitSuccess();

    // .mcp.json exists at repo root
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      return path === "/repo/.mcp.json";
    });

    await manager.create("task-mcp");

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/repo/.mcp.json",
      expect.stringContaining(".mcp.json"),
    );
  });

  it("does not copy .mcp.json when it does not exist at repo root", async () => {
    setupGitSuccess();

    // .mcp.json does NOT exist
    mockExistsSync.mockReturnValue(false);

    await manager.create("task-no-mcp");

    const mcpCopyCalls = mockCopyFileSync.mock.calls.filter(
      ([_src, dst]) => String(dst).endsWith(".mcp.json"),
    );
    expect(mcpCopyCalls).toHaveLength(0);
  });

  it("copies .mcp.json to the worktree path (not repo root)", async () => {
    setupGitSuccess();

    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/repo/.mcp.json";
    });

    const info = await manager.create("task-mcp-path");

    const mcpCopyCall = mockCopyFileSync.mock.calls.find(
      ([_src, dst]) => String(dst).endsWith(".mcp.json"),
    );
    expect(mcpCopyCall).toBeDefined();

    const [src, dst] = mcpCopyCall!;
    expect(String(src)).toBe("/repo/.mcp.json");
    // Destination should be inside the worktree path
    expect(String(dst)).toContain(info.path);
    expect(String(dst)).toContain(".mcp.json");
  });
});

describe("WorktreeManager copies .claude/settings.json to worktree", () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorktreeManager("/repo", { baseDir: "/repo/.swarm/worktrees" });
  });

  afterEach(() => {
    manager.stopPolling();
  });

  it("copies .claude/settings.json when it exists", async () => {
    setupGitSuccess();

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      // .claude/ dir and settings.json exist, .mcp.json does not
      return path === "/repo/.claude" || path === "/repo/.claude/settings.json";
    });

    await manager.create("task-claude-settings");

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/repo/.claude/settings.json",
      expect.stringContaining("settings.json"),
    );
  });

  it("does NOT copy .claude/settings.local.json — security: keeps personal tokens out of worker worktrees", async () => {
    setupGitSuccess();

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      return path === "/repo/.claude"
        || path === "/repo/.claude/settings.json"
        || path === "/repo/.claude/settings.local.json";
    });

    await manager.create("task-claude-local");

    // settings.json SHOULD be copied
    const copiedPaths = mockCopyFileSync.mock.calls.map((c) => String(c[0]));
    expect(copiedPaths).toContain("/repo/.claude/settings.json");

    // settings.local.json MUST NOT be copied (contains gitignored personal data)
    expect(copiedPaths).not.toContain("/repo/.claude/settings.local.json");
  });

  it("creates .claude/ directory in worktree before copying", async () => {
    setupGitSuccess();

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      return path === "/repo/.claude" || path === "/repo/.claude/settings.json";
    });

    const info = await manager.create("task-claude-mkdir");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(info.path),
      { recursive: true },
    );
  });

  it("does not copy .claude/ files when .claude/ dir does not exist at repo root", async () => {
    setupGitSuccess();

    // Neither .mcp.json nor .claude/ exists
    mockExistsSync.mockReturnValue(false);

    await manager.create("task-no-claude");

    const settingsCopyCalls = mockCopyFileSync.mock.calls.filter(
      ([_src, dst]) => String(dst).includes("settings.json"),
    );
    expect(settingsCopyCalls).toHaveLength(0);
  });

  it("copies settings to the correct worktree .claude/ path", async () => {
    setupGitSuccess();

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      return path === "/repo/.claude" || path === "/repo/.claude/settings.json";
    });

    const info = await manager.create("task-settings-path");

    const settingsCopyCall = mockCopyFileSync.mock.calls.find(
      ([_src, dst]) => String(dst).endsWith("settings.json"),
    );

    expect(settingsCopyCall).toBeDefined();
    const [src, dst] = settingsCopyCall!;
    expect(String(src)).toBe("/repo/.claude/settings.json");
    expect(String(dst)).toContain(info.path);
    expect(String(dst)).toContain(".claude");
  });
});
