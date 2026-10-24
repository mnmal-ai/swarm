import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ---------------------------------------------------------------------------
// Mock SubstrateClient
// ---------------------------------------------------------------------------

function createMockClient(entities: Record<string, unknown[]> = {}): SubstrateClient {
  return {
    query: vi.fn(async (typeName: string) => entities[typeName] ?? []),
    mutate: vi.fn(async () => ({ id: 1 })),
    isHealthy: vi.fn(async () => true),
    hasType: vi.fn(async () => true),
    getSchema: vi.fn(async () => ({ types: {}, mutations: {} })),
    invalidateSchema: vi.fn(),
    propose: vi.fn(async () => ({ accepted: true, schema: {} })),
    ingest: vi.fn(async () => ({ accepted: 1, typeName: "McpServer" })),
    close: vi.fn(),
  } as unknown as SubstrateClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP management — addMcpToSubstrate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores an MCP server in Substrate", async () => {
    const { addMcpToSubstrate } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient();

    await addMcpToSubstrate(client, "postgres", "npx", ["-y", "@modelcontextprotocol/server-postgres"], "my-project");

    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("createMcpServer");
    expect(call[1]).toMatchObject({
      name: "postgres",
      command: "npx",
      args: JSON.stringify(["-y", "@modelcontextprotocol/server-postgres"]),
      type: "stdio",
      toolCount: 0,
      projectId: "my-project",
    });
  });

  it("handles Substrate mutation failure gracefully", async () => {
    const { addMcpToSubstrate } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient();
    vi.mocked(client.mutate).mockRejectedValueOnce(new Error("Connection refused"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    await addMcpToSubstrate(client, "test-mcp", "node", ["server.js"], "test-project");

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("MCP management — listMcp", () => {
  it("lists MCP servers from Substrate", async () => {
    const { listMcp } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient({
      McpServer: [
        {
          name: "postgres",
          command: "npx",
          args: JSON.stringify(["-y", "@modelcontextprotocol/server-postgres"]),
          type: "stdio",
          toolCount: 5,
          projectId: "my-project",
          lastIntrospected: "2026-01-01T00:00:00Z",
        },
        {
          name: "filesystem",
          command: "npx",
          args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem"]),
          type: "stdio",
          toolCount: 0,
          projectId: "my-project",
          lastIntrospected: "",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await listMcp(client);

    expect(client.query).toHaveBeenCalledOnce();
    // Should have printed something for each server
    expect(consoleSpy).toHaveBeenCalled();
    // toolCount is a number on Substrate: a count of 0 shows no "(0 tools)".
    const lines = consoleSpy.mock.calls.flat().map(String);
    expect(lines.find((l) => l.includes("postgres") && l.includes("server-postgres"))).toMatch(/\(5 tools\)/);
    expect(lines.find((l) => l.includes("server-filesystem"))).not.toMatch(/tools\)/);

    consoleSpy.mockRestore();
  });

  it("shows empty message when no MCP servers exist", async () => {
    const { listMcp } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient({ McpServer: [] });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await listMcp(client);

    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("No MCP servers registered");

    consoleSpy.mockRestore();
  });
});

describe("MCP management — removeMcp", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "swarm-mcp-test-"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes an MCP server from Substrate and config.json", async () => {
    const { removeMcp } = await import("../src/cli/mcp-manage.js");

    // Create a fake swarm directory with config.json
    const swarmDir = join(tempDir, ".swarm");
    const domainDir = join(swarmDir, "domains", "test-project");
    mkdirSync(domainDir, { recursive: true });

    const config = {
      backends: {
        worker: {
          type: "claude-code",
          mcpServers: {
            postgres: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-postgres"],
            },
            filesystem: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem"],
            },
          },
        },
      },
    };
    writeFileSync(join(domainDir, "config.json"), JSON.stringify(config, null, 2));

    const client = createMockClient({
      McpServer: [
        { id: 42, name: "postgres" },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await removeMcp(client, "postgres", swarmDir);

    // Should have called deleteMcpServer mutation
    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("deleteMcpServer");
    expect(call[1]).toMatchObject({ id: 42 });

    // Config.json should no longer have postgres
    const updatedConfig = JSON.parse(readFileSync(join(domainDir, "config.json"), "utf-8"));
    expect(updatedConfig.backends.worker.mcpServers).not.toHaveProperty("postgres");
    expect(updatedConfig.backends.worker.mcpServers).toHaveProperty("filesystem");

    consoleSpy.mockRestore();
  });

  it("exits with error if MCP server not found", async () => {
    const { removeMcp } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient({ McpServer: [] });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(removeMcp(client, "nonexistent")).rejects.toThrow("process.exit called");

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("MCP management — showMcp", () => {
  it("displays MCP server details and tools", async () => {
    const { showMcp } = await import("../src/cli/mcp-manage.js");

    const client = createMockClient({
      McpServer: [
        {
          name: "postgres",
          command: "npx",
          args: JSON.stringify(["-y", "@modelcontextprotocol/server-postgres"]),
          type: "stdio",
          toolCount: 3,
          tools: JSON.stringify(["query", "list_tables", "describe_table"]),
          projectId: "my-project",
          lastIntrospected: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await showMcp(client, "postgres");

    const allOutput = consoleSpy.mock.calls.flat().join("\n");
    expect(allOutput).toContain("postgres");
    expect(allOutput).toContain("query");
    expect(allOutput).toContain("list_tables");
    expect(allOutput).toContain("describe_table");

    consoleSpy.mockRestore();
  });
});
