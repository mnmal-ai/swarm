/**
 * Auto-sync always runs
 *
 * Tests that seedSwarmContent ingests new files even when Substrate already
 * has some content (dedup-aware but not skip-all). The sync should always
 * run and add any files not yet present.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs before imports
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    throw new Error("not found");
  }),
  readdir: vi.fn(async () => []),
}));

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { seedSwarmContent } from "../src/cli/seed.js";
import type { IngestResponse, SubstrateClient } from "@mnmal-ai/swarm-substrate";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SWARM_JSON = {
  context_budget: {
    default_max_tokens: 15000,
    model_overrides: { "claude-opus-4-6": 20000 },
  },
  routes: [
    {
      intent: "code-review",
      description: "Review code",
      keywords: ["review", "PR"],
      load: { core: ["core/values.md"], mode: ["modes/code-review.md"] },
    },
  ],
};

function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir } as ReturnType<typeof readdir> extends Promise<infer T> ? T extends (infer U)[] ? U : never : never;
}

function makeMockClient(): SubstrateClient {
  return {
    ingest: vi.fn(async (_typeName: string, data: Record<string, unknown>[], _mode: string): Promise<IngestResponse> => ({
      accepted: data.length,
      typeName: _typeName,
    })),
    query: vi.fn(async () => []),
    mutate: vi.fn(async () => ({})),
  } as unknown as SubstrateClient;
}

// ---------------------------------------------------------------------------
// Setup filesystem mocks for a swarm with core/ and modes/
// ---------------------------------------------------------------------------

function setupSwarmFs() {
  mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
  mockReadFile.mockImplementation(async (p) => {
    if (String(p).endsWith("swarm.json")) return JSON.stringify(SWARM_JSON);
    return "# content";
  });
  mockReaddir.mockImplementation(async (dir) => {
    const d = String(dir);
    if (d === "/fake/.swarm") {
      return [makeDirent("core", true), makeDirent("modes", true)];
    }
    if (d.endsWith("/core")) return [makeDirent("values.md", false)];
    if (d.endsWith("/modes")) return [makeDirent("code-review.md", false)];
    return [];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-sync always ingests new files even when Substrate has content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSwarmFs();
  });

  it("syncs new files even when Substrate already has some content", async () => {
    const client = makeMockClient();
    // Simulate: Substrate has core/values.md (matching on-disk content) but NOT
    // modes/code-review.md. The sync's content-aware dedup needs the stored
    // content to match the on-disk fixture ("# content") for the row to be
    // skipped — the test's intent is that matching rows skip, new rows ingest.
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") return [{ id: "row-1", path: "core/values.md", content: "# content", projectId: "proj-1" }] as any;
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // Should still ingest modes/code-review.md
    expect(result.content).toBeGreaterThan(0);

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();

    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);
    // core/values.md should be skipped (already exists)
    expect(paths).not.toContain("core/values.md");
    // modes/code-review.md should be ingested (new)
    expect(paths).toContain("modes/code-review.md");
  });

  it("ingests all files when Substrate has no content at all", async () => {
    const client = makeMockClient();
    // Substrate is empty
    vi.mocked(client.query).mockResolvedValue([]);

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    expect(result.content).toBeGreaterThan(0);

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);
    expect(paths).toContain("core/values.md");
    expect(paths).toContain("modes/code-review.md");
  });

  it("skips nothing when Substrate already has ALL files", async () => {
    const client = makeMockClient();
    // Substrate already has both files with matching content (content-aware dedup).
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [
          { id: "row-1", path: "core/values.md", content: "# content", projectId: "proj-1" },
          { id: "row-2", path: "modes/code-review.md", content: "# content", projectId: "proj-1" },
        ] as any;
      }
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // content count should be 0 — nothing new to ingest
    expect(result.content).toBe(0);
  });

  it("still queries Substrate to check for existing content before syncing", async () => {
    const client = makeMockClient();

    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // seedSwarmContent must query to check what's already there
    const queryMock = vi.mocked(client.query);
    expect(queryMock).toHaveBeenCalled();
    const queriedTypes = queryMock.mock.calls.map((c) => c[0]);
    expect(queriedTypes).toContain("SwarmContent");
  });

  it("returns content count equal to number of newly ingested files", async () => {
    const client = makeMockClient();
    // Substrate has core/values.md only (with matching content, so the content-aware dedup skips it)
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") return [{ id: "row-1", path: "core/values.md", content: "# content", projectId: "proj-1" }] as any;
      return [];
    });
    // Override ingest to reflect actual accepted count
    vi.mocked(client.ingest).mockImplementation(async (_typeName, data) => ({
      accepted: data.length,
      typeName: _typeName,
    }));

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // Only modes/code-review.md is new
    expect(result.content).toBe(1);
  });
});
