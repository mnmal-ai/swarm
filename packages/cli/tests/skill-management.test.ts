import { describe, it, expect, vi, beforeEach } from "vitest";
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
    ingest: vi.fn(async () => ({ accepted: 1, typeName: "SwarmContent" })),
    close: vi.fn(),
  } as unknown as SubstrateClient;
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

describe("skill management — addSkillToSubstrate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a local skill to Substrate with sourceUrl empty", async () => {
    const { addSkillToSubstrate } = await import("../src/cli/skill.js");

    const client = createMockClient();

    // Create a temp file
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "swarm-skill-test-"));
    const filePath = join(dir, "test-patterns.md");
    writeFileSync(filePath, "# Test Patterns\n\nSome patterns here.");

    await addSkillToSubstrate(client, filePath, "skills_vetted", "my-project");

    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("createSwarmContent");
    expect(call[1]).toMatchObject({
      tier: "skills_vetted",
      sourceUrl: "",
      projectId: "my-project",
    });
    // skillName derived from filename
    expect(call[1].skillName).toBe("test-patterns");
    // A number: Substrate refuses a string in a field.number() field.
    expect(typeof call[1].tokenEstimate).toBe("number");

    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a remote skill to Substrate with sourceUrl set", async () => {
    const { addSkillToSubstrate } = await import("../src/cli/skill.js");

    const mockContent = "# Remote Skill\n\nFetched from URL.";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      // Main skill file succeeds, reference discovery returns 404
      if (url.includes("references/")) return { ok: false, status: 404 };
      return { ok: true, text: async () => mockContent };
    }));

    const client = createMockClient();

    await addSkillToSubstrate(
      client,
      "https://raw.githubusercontent.com/test/repo/main/swift-concurrency.md",
      "skills_vetted",
      "my-project",
    );

    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("createSwarmContent");
    expect(call[1]).toMatchObject({
      sourceUrl: "https://raw.githubusercontent.com/test/repo/main/swift-concurrency.md",
      tier: "skills_vetted",
      skillName: "swift-concurrency",
    });

    vi.unstubAllGlobals();
  });

  it("handles fetch failure gracefully", async () => {
    const { addSkillToSubstrate } = await import("../src/cli/skill.js");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
    })));

    const client = createMockClient();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await addSkillToSubstrate(client, "https://example.com/missing.md", "skills_vetted", "test");

    expect(client.mutate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("skill management — listSkills", () => {
  it("lists skills from Substrate grouped by tier", async () => {
    const { listSkills } = await import("../src/cli/skill.js");

    const client = createMockClient({
      SwarmContent: [
        {
          path: "skills/vetted/swift-concurrency.md",
          tier: "skills_vetted",
          skillName: "swift-concurrency",
          sourceUrl: "https://example.com/swift.md",
          tokenEstimate: 500,
          fetchedAt: "2026-01-01T00:00:00Z",
        },
        {
          path: "skills/core/project-patterns.md",
          tier: "skills_core",
          skillName: "project-patterns",
          sourceUrl: "",
          tokenEstimate: 200,
          fetchedAt: "",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await listSkills(client);

    // Should have queried SwarmContent 3 times (once per tier)
    expect(client.query).toHaveBeenCalledTimes(3);
    // Filtered server-side with an operator-keyed where: Substrate refuses a bare `{ tier }` param.
    for (const call of vi.mocked(client.query).mock.calls) {
      expect(call[1]).toEqual({ where: { tier: { eq: expect.stringMatching(/^skills_/) } } });
    }

    consoleSpy.mockRestore();
  });
});

describe("skill management — updateSkills", () => {
  it("re-fetches remote skills and updates if changed", async () => {
    const { updateSkills } = await import("../src/cli/skill.js");

    const oldContent = "# Old Content";
    const newContent = "# New Content";

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => newContent,
    })));

    const client = createMockClient({
      SwarmContent: [
        {
          id: 42,
          path: "skills/vetted/test-skill.md",
          skillName: "test-skill",
          sourceUrl: "https://example.com/test-skill.md",
          content: oldContent,
          tokenEstimate: 100,
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateSkills(client);

    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("updateSwarmContent");
    expect(call[1]).toMatchObject({
      id: 42,
      content: newContent,
      tokenEstimate: expect.any(Number),
    });

    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("skips unchanged remote skills", async () => {
    const { updateSkills } = await import("../src/cli/skill.js");

    const content = "# Same Content";

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => content,
    })));

    const client = createMockClient({
      SwarmContent: [
        {
          id: 42,
          path: "skills/vetted/test-skill.md",
          skillName: "test-skill",
          sourceUrl: "https://example.com/test-skill.md",
          content,
          tokenEstimate: 100,
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateSkills(client);

    // No mutation — content unchanged
    expect(client.mutate).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("reports no remote skills when none exist", async () => {
    const { updateSkills } = await import("../src/cli/skill.js");

    const client = createMockClient({
      SwarmContent: [
        {
          id: 1,
          path: "skills/core/local-skill.md",
          skillName: "local-skill",
          sourceUrl: "",
          content: "local",
          tokenEstimate: 50,
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateSkills(client);

    expect(client.mutate).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("skill management — removeSkill", () => {
  it("removes a skill from Substrate by skillName", async () => {
    const { removeSkill } = await import("../src/cli/skill.js");

    const client = createMockClient({
      SwarmContent: [
        {
          id: 99,
          path: "skills/vetted/swift-concurrency.md",
          skillName: "swift-concurrency",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await removeSkill(client, "swift-concurrency");

    expect(client.mutate).toHaveBeenCalledOnce();
    const call = vi.mocked(client.mutate).mock.calls[0];
    expect(call[0]).toBe("deleteSwarmContent");
    expect(call[1]).toMatchObject({ id: 99 });

    consoleSpy.mockRestore();
  });

  it("exits with error if skill not found", async () => {
    const { removeSkill } = await import("../src/cli/skill.js");

    const client = createMockClient({ SwarmContent: [] });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(removeSkill(client, "nonexistent")).rejects.toThrow("process.exit called");

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
