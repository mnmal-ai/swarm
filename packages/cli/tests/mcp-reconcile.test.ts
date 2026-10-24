import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

function scaffoldSwarmDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-reconcile-"));
  const domainDir = join(dir, "domains", "todo-test");
  mkdirSync(domainDir, { recursive: true });
  const config = {
    backends: {
      worker: {
        type: "claude-code",
        mcpServers: {
          xcodebuild: { type: "stdio", command: "npx", args: ["-y", "xcodebuildmcp@latest", "mcp"] },
          postgres: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"] },
        },
      },
      reviewer: {
        type: "claude-code",
        mcpServers: {
          xcodebuild: { type: "stdio", command: "npx", args: ["-y", "xcodebuildmcp@latest", "mcp"] },
        },
      },
      arbiter: { type: "claude-code" },
    },
  };
  writeFileSync(join(domainDir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function createClient(
  existing: Array<{ name: string; projectId: string }> = [],
): { client: SubstrateClient; mutateCalls: Array<Record<string, unknown>> } {
  const mutateCalls: Array<Record<string, unknown>> = [];
  const client = {
    query: vi.fn(async (typeName: string) =>
      typeName === "McpServer" ? existing : [],
    ),
    mutate: vi.fn(async (_op: string, params: Record<string, unknown>) => {
      mutateCalls.push(params);
      return { id: mutateCalls.length };
    }),
    isHealthy: vi.fn(async () => true),
    hasType: vi.fn(async () => true),
    getSchema: vi.fn(async () => ({ types: {}, mutations: {} })),
    invalidateSchema: vi.fn(),
    propose: vi.fn(async () => ({ accepted: true, schema: {} })),
    ingest: vi.fn(async () => ({ accepted: 1, typeName: "McpServer" })),
    close: vi.fn(),
  } as unknown as SubstrateClient;
  return { client, mutateCalls };
}

describe("reconcileMcpServers", () => {
  let swarmDir: string;

  beforeEach(() => { swarmDir = scaffoldSwarmDir(); });
  afterEach(() => { rmSync(swarmDir, { recursive: true, force: true }); });

  it("creates McpServer entities for every unique MCP in config.json", async () => {
    const { reconcileMcpServers } = await import("../src/cli/mcp-manage.js");
    const { client, mutateCalls } = createClient();

    const created = await reconcileMcpServers(client, swarmDir, "todo-test");

    expect(new Set(created)).toEqual(new Set(["xcodebuild", "postgres"]));
    expect(mutateCalls).toHaveLength(2);
    for (const call of mutateCalls) {
      expect(call.projectId).toBe("todo-test");
      expect(call.type).toBe("stdio");
    }
  });

  it("is idempotent: skips servers already present for the same projectId", async () => {
    const { reconcileMcpServers } = await import("../src/cli/mcp-manage.js");
    const { client, mutateCalls } = createClient([
      { name: "xcodebuild", projectId: "todo-test" },
    ]);

    const created = await reconcileMcpServers(client, swarmDir, "todo-test");

    expect(created).toEqual(["postgres"]);
    expect(mutateCalls).toHaveLength(1);
    expect(mutateCalls[0].name).toBe("postgres");
  });

  it("treats the same name under a different projectId as missing", async () => {
    const { reconcileMcpServers } = await import("../src/cli/mcp-manage.js");
    const { client, mutateCalls } = createClient([
      { name: "xcodebuild", projectId: "other-project" },
    ]);

    const created = await reconcileMcpServers(client, swarmDir, "todo-test");

    expect(new Set(created)).toEqual(new Set(["xcodebuild", "postgres"]));
    expect(mutateCalls).toHaveLength(2);
    for (const call of mutateCalls) {
      expect(call.projectId).toBe("todo-test");
    }
  });

  it("returns empty when swarmDir has no config.json", async () => {
    const { reconcileMcpServers } = await import("../src/cli/mcp-manage.js");
    const { client, mutateCalls } = createClient();
    const emptyDir = mkdtempSync(join(tmpdir(), "swarm-empty-"));
    try {
      const created = await reconcileMcpServers(client, emptyDir, "todo-test");
      expect(created).toEqual([]);
      expect(mutateCalls).toHaveLength(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
