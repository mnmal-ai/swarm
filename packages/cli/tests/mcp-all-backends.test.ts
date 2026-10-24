/**
 * MCP copied to all backends
 *
 * Tests that writeMcpToAllBackends writes the MCP server entry to all three
 * backends (worker, reviewer, arbiter) in config.json, not just worker.
 *
 * Exercises the real exported function from add.ts by mocking the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs before imports
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  readdirSync: vi.fn(() => []),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { writeMcpToAllBackends } from "../src/cli/add.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

// Helper: get the config object that was written to disk
function getWrittenConfig(): Record<string, any> | null {
  const calls = mockWriteFileSync.mock.calls;
  if (calls.length === 0) return null;
  const content = String(calls[calls.length - 1][1]);
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeMcpToAllBackends — real function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds MCP server to worker backend", () => {
    const config = {
      project: "my-project",
      backends: {
        worker: { type: "claude-code", fallback: "api" },
        reviewer: { type: "claude-code", fallback: "api" },
        arbiter: { type: "claude-code", fallback: "api" },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    writeMcpToAllBackends(
      "/fake/.swarm/domains/proj/config.json",
      "postgres",
      "npx",
      ["-y", "@modelcontextprotocol/server-postgres"],
      undefined,
    );

    const written = getWrittenConfig();
    expect(written?.backends?.worker?.mcpServers?.postgres).toBeDefined();
    expect(written?.backends?.worker?.mcpServers?.postgres?.command).toBe("npx");
  });

  it("adds MCP server to reviewer backend", () => {
    const config = {
      backends: {
        worker: { type: "claude-code" },
        reviewer: { type: "claude-code" },
        arbiter: { type: "claude-code" },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    writeMcpToAllBackends("/fake/config.json", "postgres", "npx", ["-y", "pg"], undefined);

    const written = getWrittenConfig();
    expect(written?.backends?.reviewer?.mcpServers?.postgres).toBeDefined();
  });

  it("adds MCP server to arbiter backend", () => {
    const config = {
      backends: {
        worker: { type: "claude-code" },
        reviewer: { type: "claude-code" },
        arbiter: { type: "claude-code" },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    writeMcpToAllBackends("/fake/config.json", "postgres", "npx", ["-y", "pg"], undefined);

    const written = getWrittenConfig();
    expect(written?.backends?.arbiter?.mcpServers?.postgres).toBeDefined();
  });

  it("creates backends and roles that don't exist", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({})); // no backends

    writeMcpToAllBackends("/fake/config.json", "postgres", "npx", ["-y", "pg"], undefined);

    const written = getWrittenConfig();
    expect(written?.backends?.worker?.type).toBe("claude-code");
    expect(written?.backends?.reviewer?.type).toBe("claude-code");
    expect(written?.backends?.arbiter?.type).toBe("claude-code");
    expect(written?.backends?.worker?.mcpServers?.postgres).toBeDefined();
    expect(written?.backends?.reviewer?.mcpServers?.postgres).toBeDefined();
    expect(written?.backends?.arbiter?.mcpServers?.postgres).toBeDefined();
  });

  it("preserves existing mcpServers entries in each backend", () => {
    const config = {
      backends: {
        worker: {
          type: "claude-code",
          mcpServers: { existing: { type: "stdio", command: "old-cmd" } },
        },
        reviewer: {
          type: "claude-code",
          mcpServers: { existing: { type: "stdio", command: "old-cmd" } },
        },
        arbiter: {
          type: "claude-code",
          mcpServers: { existing: { type: "stdio", command: "old-cmd" } },
        },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    writeMcpToAllBackends("/fake/config.json", "postgres", "npx", ["-y", "pg"], undefined);

    const written = getWrittenConfig();
    for (const role of ["worker", "reviewer", "arbiter"]) {
      expect(written?.backends?.[role]?.mcpServers?.existing?.command).toBe("old-cmd");
      expect(written?.backends?.[role]?.mcpServers?.postgres).toBeDefined();
    }
  });

  it("includes env vars when provided", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    writeMcpToAllBackends(
      "/fake/config.json",
      "github",
      "npx",
      ["-y", "@modelcontextprotocol/server-github"],
      { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN" },
    );

    const written = getWrittenConfig();
    expect(written?.backends?.worker?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("$GITHUB_TOKEN");
    expect(written?.backends?.reviewer?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("$GITHUB_TOKEN");
    expect(written?.backends?.arbiter?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("$GITHUB_TOKEN");
  });

  it("omits args when mcpArgs is empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    writeMcpToAllBackends("/fake/config.json", "simple", "my-cmd", [], undefined);

    const written = getWrittenConfig();
    expect(written?.backends?.worker?.mcpServers?.simple?.args).toBeUndefined();
    expect(written?.backends?.worker?.mcpServers?.simple?.command).toBe("my-cmd");
  });
});
