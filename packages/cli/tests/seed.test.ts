import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs (existsSync) and node:fs/promises (readFile, readdir) before
// importing the module under test.
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
import { seedSwarmContent, seedSwarmContentForce } from "../src/cli/seed.js";
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

/** Build a Dirent-like object accepted by the mock. */
function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir } as ReturnType<typeof readdir> extends Promise<infer T> ? T extends (infer U)[] ? U : never : never;
}

/** Create a mock SubstrateClient whose ingest returns { accepted: data.length }. */
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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockReadFile.mockReset();
  mockReadFile.mockRejectedValue(new Error("not found"));
  mockReaddir.mockReset();
  mockReaddir.mockResolvedValue([]);
});

describe("seedSwarmContent — missing swarm.json", () => {
  it("returns { configs: 0, content: 0, routes: 0 } when swarm.json does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const client = makeMockClient();
    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    expect(result).toEqual({ configs: 0, content: 0, routes: 0 });
    expect(vi.mocked(client.ingest)).not.toHaveBeenCalled();
  });
});

describe("seedSwarmContent — valid swarm.json", () => {
  beforeEach(() => {
    // swarm.json exists and is readable
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify(SWARM_JSON);
      }
      // Content files return minimal markdown
      return "# content";
    });

    // Top-level readdir: return core/ and modes/ directories
    mockReaddir.mockImplementation(async (dir, _opts?: unknown) => {
      const d = String(dir);

      if (d.endsWith("/.swarm") || d === "/fake/.swarm") {
        return [
          makeDirent("core", true),
          makeDirent("modes", true),
        ];
      }

      if (d.endsWith("/core")) {
        return [makeDirent("values.md", false)];
      }

      if (d.endsWith("/modes")) {
        return [makeDirent("code-review.md", false)];
      }

      return [];
    });
  });

  it("returns correct counts for configs, content, and routes", async () => {
    const client = makeMockClient();
    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // SwarmConfig: default_max_tokens (1) + model_override:claude-opus-4-6 (1) = 2
    expect(result.configs).toBe(2);

    // SwarmContent: core/values.md + modes/code-review.md = 2
    expect(result.content).toBe(2);

    // SwarmRoute: 1 route
    expect(result.routes).toBe(1);
  });

  it("sends SwarmContent.tokenEstimate as a number, which Substrate's field.number() requires", async () => {
    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");
    const rows = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent")![1] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.tokenEstimate).toBe("number");
      expect(row.tokenEstimate).toBe(Math.ceil(String(row.content).length / 4));
    }
  });

  it("calls ingest with 'extend' mode for all entity types (dedup handled before ingest)", async () => {
    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const modes = ingestMock.mock.calls.map((c) => c[2]);
    expect(modes.every((m) => m === "extend")).toBe(true);
  });

  it("queries existing entities before ingest for dedup", async () => {
    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const queryMock = vi.mocked(client.query);
    const queriedTypes = queryMock.mock.calls.map((c) => c[0]);
    expect(queriedTypes).toContain("SwarmConfig");
    expect(queriedTypes).toContain("SwarmContent");
    expect(queriedTypes).toContain("SwarmRoute");
  });

  it("skips entities that already exist in Substrate (dedup by key)", async () => {
    const client = makeMockClient();
    // Simulate Substrate already containing one config + one content row + one route.
    // For SwarmContent the dedup is content-aware, so the mock must also
    // return the same content the on-disk file produces ("# content" per the
    // outer beforeEach mock).
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmConfig") return [{ key: "default_max_tokens" }] as any;
      if (typeName === "SwarmContent") return [{ id: "row-1", path: "core/values.md", content: "# content", projectId: "proj-1" }] as any;
      if (typeName === "SwarmRoute") return [{ intent: "code-review", projectId: "proj-1" }] as any;
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // Only model_override should be ingested for config (default_max_tokens skipped)
    const ingestCalls = vi.mocked(client.ingest).mock.calls;
    const configCall = ingestCalls.find((c) => c[0] === "SwarmConfig");
    expect(configCall).toBeDefined();
    const configKeys = configCall![1].map((e: Record<string, unknown>) => e.key);
    expect(configKeys).not.toContain("default_max_tokens");
    expect(configKeys).toContain("model_override:claude-opus-4-6");

    // core/values.md content matches what Substrate already stores — skip from ingest
    const contentCall = ingestCalls.find((c) => c[0] === "SwarmContent");
    if (contentCall) {
      const contentPaths = contentCall[1].map((e: Record<string, unknown>) => e.path);
      expect(contentPaths).not.toContain("core/values.md");
    }
    // No delete should be needed when content matches
    expect(vi.mocked(client.mutate)).not.toHaveBeenCalledWith(
      "deleteSwarmContent", expect.anything(), expect.anything(),
    );

    // code-review route should be skipped (only one route in mock)
    const routeCall = ingestCalls.find((c) => c[0] === "SwarmRoute");
    expect(routeCall).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Content-aware SwarmContent dedup
  //
  // The previous path-only dedup at seed.ts:164 silently dropped on-disk edits
  // because matching paths were skipped without comparing content. These tests
  // pin the new behaviour: equal content skips, changed content deletes-then-
  // inserts, missing content inserts fresh.
  // ---------------------------------------------------------------------------

  it("re-ingests SwarmContent when the on-disk content has changed", async () => {
    const client = makeMockClient();
    // Substrate has core/values.md but with stale content
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [{ id: "row-stale", path: "core/values.md", content: "# OLD content", projectId: "proj-1" }] as any;
      }
      return [];
    });

    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // Stale row should have been deleted before insert
    expect(vi.mocked(client.mutate)).toHaveBeenCalledWith(
      "deleteSwarmContent", { id: "row-stale" }, { id: true },
    );

    // New content should be in the ingest payload
    const contentCall = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();
    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);
    expect(paths).toContain("core/values.md");
  });

  it("deletes every stale duplicate before inserting the new SwarmContent row", async () => {
    const client = makeMockClient();
    // Simulate the seedSwarmContentForce historical behaviour: same path,
    // multiple rows, all with stale content
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [
          { id: "row-a", path: "core/values.md", content: "# very old", projectId: "proj-1" },
          { id: "row-b", path: "core/values.md", content: "# also old", projectId: "proj-1" },
          { id: "row-c", path: "core/values.md", content: "# stale too", projectId: "proj-1" },
        ] as any;
      }
      return [];
    });

    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // All three stale rows should be deleted
    const deleteCalls = vi.mocked(client.mutate).mock.calls.filter(
      (c) => c[0] === "deleteSwarmContent",
    );
    const deletedIds = deleteCalls.map((c) => (c[1] as Record<string, unknown>).id);
    expect(deletedIds).toEqual(expect.arrayContaining(["row-a", "row-b", "row-c"]));
  });

  it("skips SwarmContent ingest + delete when an existing row already matches", async () => {
    const client = makeMockClient();
    // One stale row + one matching row → matching wins, no delete, no insert
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [
          { id: "row-stale", path: "core/values.md", content: "# OLD", projectId: "proj-1" },
          { id: "row-match", path: "core/values.md", content: "# content", projectId: "proj-1" },
        ] as any;
      }
      return [];
    });

    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // No delete attempts when a matching row exists
    expect(vi.mocked(client.mutate)).not.toHaveBeenCalledWith(
      "deleteSwarmContent", expect.anything(), expect.anything(),
    );

    // No content ingest call for this path (the only content file in the mock)
    const contentCall = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent");
    if (contentCall) {
      const paths = (contentCall[1] as Record<string, unknown>[]).map((e) => e["path"]);
      expect(paths).not.toContain("core/values.md");
    }
  });

  it("tolerates delete failures by warning and proceeding with insert", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [{ id: "row-stale", path: "core/values.md", content: "# OLD", projectId: "proj-1" }] as any;
      }
      return [];
    });
    vi.mocked(client.mutate).mockImplementation(async (mutationName: string) => {
      if (mutationName === "deleteSwarmContent") {
        throw new Error("delete refused by substrate");
      }
      return {};
    });

    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    // Warning was logged
    expect(warnSpy).toHaveBeenCalled();
    const warnedMessage = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnedMessage).toContain("row-stale");
    expect(warnedMessage).toContain("core/values.md");

    // New row still queued for insertion despite the failed delete
    const contentCall = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();
    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);
    expect(paths).toContain("core/values.md");

    warnSpy.mockRestore();
  });

  it("returns count of only newly inserted entities", async () => {
    const client = makeMockClient();
    // All config keys already exist
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmConfig") return [
        { key: "default_max_tokens" },
        { key: "model_override:claude-opus-4-6" },
      ] as any;
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "proj-1");
    // No new config entities to ingest
    expect(result.configs).toBe(0);
  });

  it("ingests SwarmConfig with correct key/value/category fields", async () => {
    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const configCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmConfig");
    expect(configCall).toBeDefined();

    const entities = configCall![1] as Record<string, unknown>[];
    const keys = entities.map((e) => e["key"]);
    expect(keys).toContain("default_max_tokens");
    expect(keys).toContain("model_override:claude-opus-4-6");

    const defaultEntity = entities.find((e) => e["key"] === "default_max_tokens");
    expect(defaultEntity?.["value"]).toBe("15000");
    expect(defaultEntity?.["category"]).toBe("budget");
  });

  it("ingests SwarmRoute with correct intent/keywords/contentPaths", async () => {
    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const routeCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmRoute");
    expect(routeCall).toBeDefined();

    const entities = routeCall![1] as Record<string, unknown>[];
    expect(entities).toHaveLength(1);

    const route = entities[0];
    expect(route["intent"]).toBe("code-review");
    expect(route["description"]).toBe("Review code");

    // Keywords and contentPaths are stored as JSON strings
    expect(JSON.parse(route["keywords"] as string)).toEqual(["review", "PR"]);
    expect(JSON.parse(route["contentPaths"] as string)).toEqual([
      "core/values.md",
      "modes/code-review.md",
    ]);
  });
});

describe("seedSwarmContent — tier mapping", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify({ ...SWARM_JSON, routes: [] });
      }
      return "# content";
    });
  });

  const TIER_CASES: Array<{ dir: string; expectedTier: string }> = [
    { dir: "core", expectedTier: "core" },
    { dir: "modes", expectedTier: "mode" },
    { dir: "capabilities", expectedTier: "capabilities" },
    { dir: "domains", expectedTier: "domain" },
    { dir: "oversight", expectedTier: "oversight" },
    { dir: "skills", expectedTier: "skills_vetted" },
  ];

  for (const { dir, expectedTier } of TIER_CASES) {
    it(`maps ${dir}/ to tier "${expectedTier}"`, async () => {
      mockReaddir.mockImplementation(async (d) => {
        const s = String(d);
        if (s === "/fake/.swarm") {
          return [makeDirent(dir, true)];
        }
        if (s.endsWith(`/${dir}`)) {
          return [makeDirent("some-file.md", false)];
        }
        return [];
      });

      const client = makeMockClient();
      await seedSwarmContent(client, "/fake/.swarm", "proj-1");

      const ingestMock = vi.mocked(client.ingest);
      const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
      expect(contentCall).toBeDefined();

      const entities = contentCall![1] as Record<string, unknown>[];
      expect(entities).toHaveLength(1);
      expect(entities[0]["tier"]).toBe(expectedTier);
    });
  }
});

describe("seedSwarmContent — excluded files", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify({ ...SWARM_JSON, routes: [] });
      }
      return "# content";
    });
  });

  const EXCLUDED = ["README.md", "CLAUDE.md", "AGENTS.md", "package.json", "package-lock.json", ".swarm-meta.json"];

  for (const filename of EXCLUDED) {
    it(`skips excluded file "${filename}"`, async () => {
      mockReaddir.mockImplementation(async (d) => {
        const s = String(d);
        if (s === "/fake/.swarm") {
          return [makeDirent("core", true)];
        }
        if (s.endsWith("/core")) {
          return [
            makeDirent(filename, false),
            makeDirent("values.md", false), // Always include one real file
          ];
        }
        return [];
      });

      const client = makeMockClient();
      await seedSwarmContent(client, "/fake/.swarm", "proj-1");

      const ingestMock = vi.mocked(client.ingest);
      const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
      expect(contentCall).toBeDefined();

      const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);
      expect(paths.some((p) => String(p).endsWith(filename))).toBe(false);
    });
  }

  it("skips files that are not .md or .json", async () => {
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("core", true)];
      if (s.endsWith("/core")) {
        return [
          makeDirent("values.md", false),
          makeDirent("ignored.txt", false),
          makeDirent("ignored.ts", false),
        ];
      }
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => e["path"]);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("core/values.md");
  });
});

describe("seedSwarmContent — projectId scoping", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify({ ...SWARM_JSON, routes: [] });
      }
      return "# content";
    });
  });

  it("assigns the passed projectId to domain files", async () => {
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("domains", true)];
      if (s.endsWith("/domains")) return [makeDirent("todo.md", false)];
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "my-project");

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();

    const entities = contentCall![1] as Record<string, unknown>[];
    expect(entities).toHaveLength(1);
    expect(entities[0]["projectId"]).toBe("my-project");
  });

  // Non-domain files used to be written as projectId "global", so two
  // projects on one Substrate with different core/ files replaced each other's rows.
  it("assigns the passed projectId to non-domain files too", async () => {
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("core", true)];
      if (s.endsWith("/core")) return [makeDirent("values.md", false)];
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "my-project");

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();

    const entities = contentCall![1] as Record<string, unknown>[];
    expect(entities).toHaveLength(1);
    expect(entities[0]["projectId"]).toBe("my-project");
  });

  it("uses the passed projectId for modes, capabilities, oversight, and skills files", async () => {
    const nonDomainDirs = ["modes", "capabilities", "oversight", "skills"];

    for (const dir of nonDomainDirs) {
      vi.clearAllMocks();
      mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
      mockReadFile.mockImplementation(async (p) => {
        if (String(p).endsWith("swarm.json")) {
          return JSON.stringify({ ...SWARM_JSON, routes: [] });
        }
        return "# content";
      });

      mockReaddir.mockImplementation(async (d) => {
        const s = String(d);
        if (s === "/fake/.swarm") return [makeDirent(dir, true)];
        if (s.endsWith(`/${dir}`)) return [makeDirent("file.md", false)];
        return [];
      });

      const client = makeMockClient();
      await seedSwarmContent(client, "/fake/.swarm", "proj-xyz");

      const ingestMock = vi.mocked(client.ingest);
      const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
      const entities = contentCall![1] as Record<string, unknown>[];
      expect(entities[0]["projectId"], `${dir}/ should be scoped to the project`).toBe("proj-xyz");
    }
  });

  it("reads only its own SwarmContent and SwarmRoute rows", async () => {
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("core", true)];
      if (s.endsWith("/core")) return [makeDirent("values.md", false)];
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "my-project");

    const queryCalls = vi.mocked(client.query).mock.calls;
    for (const type of ["SwarmContent", "SwarmRoute"]) {
      const call = queryCalls.find((c) => c[0] === type);
      expect(call?.[1], type).toEqual({ where: { projectId: { eq: "my-project" } } });
    }
  });

  it("never deletes another project's or a legacy row at the same path", async () => {
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("core", true)];
      if (s.endsWith("/core")) return [makeDirent("values.md", false)];
      return [];
    });

    const client = makeMockClient();
    // A server that ignores the where-clause: the sync must still leave rows it
    // does not own alone.
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmContent") {
        return [
          { id: "row-other", path: "core/values.md", content: "# other project", projectId: "other-project" },
          { id: "row-legacy", path: "core/values.md", content: "# legacy", projectId: "global" },
          { id: "row-matching-other", path: "core/values.md", content: "# content", projectId: "other-project" },
        ] as any;
      }
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "my-project");

    expect(vi.mocked(client.mutate)).not.toHaveBeenCalled();
    // Another project's identical row does not count as this project's copy.
    expect(result.content).toBe(1);
    const contentCall = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall![1]).toEqual([
      expect.objectContaining({ path: "core/values.md", projectId: "my-project" }),
    ]);
  });

  it("registers its route when another project or a legacy row already has that intent", async () => {
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) return JSON.stringify(SWARM_JSON);
      return "# content";
    });
    const client = makeMockClient();
    vi.mocked(client.query).mockImplementation(async (typeName: string) => {
      if (typeName === "SwarmRoute") {
        return [
          { intent: "code-review" },
          { intent: "code-review", projectId: "other-project" },
        ] as any;
      }
      return [];
    });

    const result = await seedSwarmContent(client, "/fake/.swarm", "my-project");

    expect(result.routes).toBe(1);
    const routeCall = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmRoute");
    expect(routeCall![1]).toEqual([
      expect.objectContaining({ intent: "code-review", projectId: "my-project" }),
    ]);
  });
});

describe("seedSwarmContent — Windows path normalization", () => {
  it("normalizes backslashes in relative paths to forward slashes", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify({ ...SWARM_JSON, routes: [] });
      }
      return "# content";
    });

    // Simulate what walkDir returns on Windows: paths with backslashes
    // by crafting the readdir to return a path that would produce backslash
    // relative paths. We do this by having the file path itself contain
    // a backslash (the seed.ts module normalizes via relPath.replace(/\\/g, "/")).
    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("core", true)];
      if (s.endsWith("/core")) {
        // Return a dirent whose name uses a forward slash — the relative path
        // produced by path.relative will be "core/values.md" on POSIX,
        // "core\\values.md" on Windows. We verify the stored path is always
        // normalized (no backslashes).
        return [makeDirent("values.md", false)];
      }
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    expect(contentCall).toBeDefined();

    const paths = (contentCall![1] as Record<string, unknown>[]).map((e) => String(e["path"]));
    for (const p of paths) {
      expect(p).not.toContain("\\");
    }
  });

  it("correctly identifies tier from a path that originally used backslashes", async () => {
    // Directly verify getTier-level behavior: the function normalizes before
    // looking up in TIER_MAP, so "modes\\code-review.md" should resolve to "mode".
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) {
        return JSON.stringify({ ...SWARM_JSON, routes: [] });
      }
      return "# content";
    });

    mockReaddir.mockImplementation(async (d) => {
      const s = String(d);
      if (s === "/fake/.swarm") return [makeDirent("modes", true)];
      if (s.endsWith("/modes")) return [makeDirent("code-review.md", false)];
      return [];
    });

    const client = makeMockClient();
    await seedSwarmContent(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const contentCall = ingestMock.mock.calls.find((c) => c[0] === "SwarmContent");
    const entities = contentCall![1] as Record<string, unknown>[];
    expect(entities).toHaveLength(1);
    expect(entities[0]["tier"]).toBe("mode");
  });
});

// ---------------------------------------------------------------------------
// seedSwarmContentForce tests
// ---------------------------------------------------------------------------

describe("seedSwarmContentForce", () => {
  beforeEach(() => {
    // Same filesystem setup as the valid swarm.json tests
    mockExistsSync.mockImplementation((p) => String(p).endsWith("swarm.json"));
    mockReadFile.mockImplementation(async (p) => {
      if (String(p).endsWith("swarm.json")) return JSON.stringify(SWARM_JSON);
      return "# content";
    });
    mockReaddir.mockImplementation(async (dir, _opts?: unknown) => {
      const d = String(dir);
      if (d.endsWith("/.swarm") || d === "/fake/.swarm") {
        return [makeDirent("core", true), makeDirent("modes", true)];
      }
      if (d.endsWith("/core")) return [makeDirent("values.md", false)];
      if (d.endsWith("/modes")) return [makeDirent("code-review.md", false)];
      return [];
    });
  });

  it("does NOT call client.query for dedup", async () => {
    const client = makeMockClient();
    await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");

    expect(vi.mocked(client.query)).not.toHaveBeenCalled();
  });

  it("calls ingest with 'extend' mode for all entity types", async () => {
    const client = makeMockClient();
    await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");

    const ingestMock = vi.mocked(client.ingest);
    const modes = ingestMock.mock.calls.map((c) => c[2]);
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((m) => m === "extend")).toBe(true);
  });

  it("returns accurate counts", async () => {
    const client = makeMockClient();
    const result = await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");

    // Should have configs (2: default + model_override), content (from mocked dirs), routes (1)
    expect(result.configs).toBeGreaterThan(0);
    expect(result.routes).toBeGreaterThan(0);
  });

  it("ingests all entities even when they already exist in Substrate", async () => {
    const client = makeMockClient();
    // Even if query would return existing entities, force doesn't check
    vi.mocked(client.query).mockResolvedValue([
      { key: "default_max_tokens" },
      { path: "core/values.md" },
      { intent: "code-review" },
    ] as any);

    const result = await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");

    // query should NOT have been called (force skips dedup)
    expect(vi.mocked(client.query)).not.toHaveBeenCalled();
    // All entities should be ingested regardless
    expect(result.configs).toBeGreaterThan(0);
    expect(result.routes).toBeGreaterThan(0);
  });

  it("sends SwarmContent.tokenEstimate as a number, as the incremental sync does", async () => {
    const client = makeMockClient();
    await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");
    const rows = vi.mocked(client.ingest).mock.calls.find((c) => c[0] === "SwarmContent")![1] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(typeof row.tokenEstimate).toBe("number");
  });

  it("scopes every content row and route to the project, like the incremental sync", async () => {
    const client = makeMockClient();
    await seedSwarmContentForce(client, "/fake/.swarm", "proj-1");

    const calls = vi.mocked(client.ingest).mock.calls;
    for (const type of ["SwarmContent", "SwarmRoute"]) {
      const rows = calls.find((c) => c[0] === type)![1] as Record<string, unknown>[];
      expect(rows.length, type).toBeGreaterThan(0);
      expect(rows.every((r) => r.projectId === "proj-1"), type).toBe(true);
    }
  });
});
