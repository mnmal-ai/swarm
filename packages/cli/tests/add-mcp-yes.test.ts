import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scaffoldSwarmWithMeta(projectName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-add-mcp-yes-"));
  // Minimal .swarm layout — just enough for resolveProjectName + findConfigPath
  const swarmDir = join(dir, ".swarm");
  mkdirSync(join(swarmDir, "domains", projectName), { recursive: true });
  writeFileSync(
    join(swarmDir, ".swarm-meta.json"),
    JSON.stringify({ project_name: projectName }, null, 2),
  );
  // Empty-but-valid config.json so writeMcpToAllBackends can load + write it
  writeFileSync(
    join(swarmDir, "domains", projectName, "config.json"),
    JSON.stringify({ project: projectName, backends: {} }, null, 2),
  );
  return swarmDir;
}

function createTrackedClient(): {
  client: SubstrateClient;
  mutateCalls: Array<{ op: string; params: Record<string, unknown> }>;
} {
  const mutateCalls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const client = {
    query: vi.fn(async () => []),
    mutate: vi.fn(async (op: string, params: Record<string, unknown>) => {
      mutateCalls.push({ op, params });
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

// @clack/prompts mocks — every prompt is wired to throw so we can prove it
// was never awaited. `runAdd` does an unconditional `await import(...)` of
// this module, so we need to mock it before loading add.ts.
const promptCalls: string[] = [];
const p = {
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  log: { message: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  isCancel: vi.fn(() => false),
  select: vi.fn(async () => { promptCalls.push("select"); throw new Error("p.select should not have been called"); }),
  text: vi.fn(async () => { promptCalls.push("text"); throw new Error("p.text should not have been called"); }),
  confirm: vi.fn(async () => { promptCalls.push("confirm"); throw new Error("p.confirm should not have been called"); }),
};
vi.mock("@clack/prompts", () => p);

// Picocolors — any identity function is fine, the tests never assert on colors.
vi.mock("picocolors", () => ({
  default: new Proxy({}, { get: () => (s: string) => s }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("swarm add mcp --yes non-interactive path", () => {
  let swarmDir: string;

  beforeEach(() => {
    promptCalls.length = 0;
    vi.clearAllMocks();
    swarmDir = scaffoldSwarmWithMeta("test-project");
  });

  afterEach(() => {
    rmSync(join(swarmDir, ".."), { recursive: true, force: true });
  });

  it("writes the popular-MCP entry to config.json without any prompts", async () => {
    const { runAdd } = await import("../src/cli/add.js");
    const { client } = createTrackedClient();

    await runAdd(
      { yes: "true", dir: swarmDir },
      ["mcp", "xcodebuild"],
      client,
    );

    expect(promptCalls).toEqual([]); // no prompts awaited

    const cfg = JSON.parse(
      readFileSync(join(swarmDir, "domains", "test-project", "config.json"), "utf-8"),
    );
    for (const role of ["worker", "reviewer", "arbiter"] as const) {
      expect(cfg.backends[role].mcpServers.xcodebuild).toMatchObject({
        type: "stdio",
        command: "npx",
        args: ["-y", "xcodebuildmcp@latest", "mcp"],
      });
    }
  });

  it("dual-writes the same entry into Substrate via addMcpToSubstrate", async () => {
    const { runAdd } = await import("../src/cli/add.js");
    const { client, mutateCalls } = createTrackedClient();

    await runAdd(
      { yes: "true", dir: swarmDir },
      ["mcp", "xcodebuild"],
      client,
    );

    const create = mutateCalls.find((c) => c.op === "createMcpServer");
    expect(create, "addMcpToSubstrate should be called when substrateClient is present").toBeDefined();
    expect(create!.params.name).toBe("xcodebuild");
    expect(create!.params.command).toBe("npx");
    expect(JSON.parse(create!.params.args as string)).toEqual(["-y", "xcodebuildmcp@latest", "mcp"]);
    expect(create!.params.projectId).toBe("test-project");
    expect(create!.params.type).toBe("stdio");
  });

  it("uses resolveProjectName for projectId (infers from .swarm-meta.json)", async () => {
    // Reset the scaffold with a name only reachable via the meta file —
    // no domains/<name>/config.json — and instead put config at .swarm/config.json.
    // Current behavior should still resolve to the meta-file name, not basename(dirname(configPath)).
    rmSync(join(swarmDir, ".."), { recursive: true, force: true });
    const dir = mkdtempSync(join(tmpdir(), "swarm-add-mcp-yes-"));
    const b = join(dir, ".swarm");
    mkdirSync(join(b, "domains", "placeholder"), { recursive: true });
    writeFileSync(
      join(b, ".swarm-meta.json"),
      JSON.stringify({ project_name: "inferred-from-meta" }, null, 2),
    );
    writeFileSync(
      join(b, "domains", "placeholder", "config.json"),
      JSON.stringify({ project: "whatever", backends: {} }, null, 2),
    );

    const { runAdd } = await import("../src/cli/add.js");
    const { client, mutateCalls } = createTrackedClient();

    await runAdd({ yes: "true", dir: b }, ["mcp", "xcodebuild"], client);

    const create = mutateCalls.find((c) => c.op === "createMcpServer");
    expect(create!.params.projectId).toBe("inferred-from-meta");

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not invoke the Substrate dual-write when no substrateClient is passed", async () => {
    const { runAdd } = await import("../src/cli/add.js");

    await runAdd({ yes: "true", dir: swarmDir }, ["mcp", "xcodebuild"], undefined);

    expect(promptCalls).toEqual([]);

    const cfg = JSON.parse(
      readFileSync(join(swarmDir, "domains", "test-project", "config.json"), "utf-8"),
    );
    // config.json write still happens
    expect(cfg.backends.worker.mcpServers.xcodebuild).toBeDefined();
  });
});
