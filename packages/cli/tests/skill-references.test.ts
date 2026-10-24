/**
 * Skill reference fetch
 * Skill ingest to Substrate
 *
 * Tests for fetchReferencesFromSkill() and ingestSkillToSubstrate().
 * These exercise the real exported functions from add.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs before imports
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  copyFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  readdirSync: vi.fn(() => []),
}));

// Mock @clack/prompts since fetchReferencesFromSkill uses p.log.success/warn
vi.mock("@clack/prompts", () => ({
  log: {
    success: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  isCancel: vi.fn(() => false),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
}));

// Mock picocolors
vi.mock("picocolors", () => ({
  default: {
    dim: (s: string) => s,
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    bold: (s: string) => s,
  },
}));

import { writeFileSync, mkdirSync } from "node:fs";
import { fetchReferencesFromSkill, ingestSkillToSubstrate, findSkillPathInRepo } from "../src/cli/add.js";

const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// ---------------------------------------------------------------------------
// Mock globalThis.fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Default: repo API returns "main" as default branch; reference files return content
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("api.github.com/repos/")) {
      return { ok: true, json: async () => ({ default_branch: "main" }) };
    }
    return { ok: true, text: async () => "# Reference content" };
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ---------------------------------------------------------------------------
// Helper: collect raw.githubusercontent.com URLs from mockFetch calls
// ---------------------------------------------------------------------------

function getRawUrls(): string[] {
  return mockFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("https://raw.githubusercontent.com/"));
}

// ---------------------------------------------------------------------------
// Tests: skill reference fetch
// ---------------------------------------------------------------------------

describe("fetchReferencesFromSkill — reference detection", () => {
  it("detects both reference paths from SKILL.md content", async () => {
    const skillContent = `# My Skill

See references/actors.md for actor patterns.
See references/testing.md for testing guidance.

## Usage
Use these patterns consistently.
`;
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "myorg",
      "myrepo",
      "main",
      "",
    );

    const urls = getRawUrls();
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("references/actors.md"))).toBe(true);
    expect(urls.some((url) => url.includes("references/testing.md"))).toBe(true);
  });

  it("constructs correct GitHub raw URLs", async () => {
    const skillContent = `# Skill
references/actors.md contains the actor definitions.
`;
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "twostraws",
      "SwiftUI-Skill",
      "main",
      "",
    );

    const urls = getRawUrls();
    expect(urls[0]).toBe(
      "https://raw.githubusercontent.com/twostraws/SwiftUI-Skill/main/references/actors.md",
    );
  });

  it("includes skill subdirectory in URL when skillPathInRepo is provided", async () => {
    const skillContent = "see references/actors.md";
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "skills/swift-skill/SKILL.md",
    );

    const urls = getRawUrls();
    expect(urls[0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/skills/swift-skill/references/actors.md",
    );
  });

  it("writes files to the references/ directory", async () => {
    const skillContent = "See references/actors.md for details.\nAlso references/testing.md.";
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    const writes = mockWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.includes("references") && p.includes("actors.md"))).toBe(true);
    expect(writes.some((p) => p.includes("references") && p.includes("testing.md"))).toBe(true);
  });

  it("creates the references/ directory via mkdirSync", async () => {
    const skillContent = "See references/actors.md";
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("references"),
      { recursive: true },
    );
  });

  it("deduplicates repeated reference paths", async () => {
    const skillContent = `references/actors.md
references/actors.md
references/actors.md`;
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    const urls = getRawUrls();
    expect(urls).toHaveLength(1);
  });

  it("returns empty when no references found", async () => {
    const skillContent = "# A skill with no references";
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    // fetch may be called for the repo API probe (default branch lookup)
    // but not for any raw.githubusercontent.com URLs
    expect(getRawUrls()).toHaveLength(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("skips writing when fetch returns non-ok response on all branches", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("api.github.com/repos/")) {
        return { ok: true, json: async () => ({ default_branch: "main" }) };
      }
      return { ok: false, text: async () => "Not Found" };
    });

    const skillContent = "See references/actors.md";
    await fetchReferencesFromSkill(
      skillContent,
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the default branch when the given branch 404s", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("api.github.com/repos/")) {
        return { ok: true, json: async () => ({ default_branch: "develop" }) };
      }
      // main branch returns 404, develop branch returns content
      if (url.includes("/main/")) {
        return { ok: false, text: async () => "Not Found" };
      }
      if (url.includes("/develop/")) {
        return { ok: true, text: async () => "# Actors reference" };
      }
      return { ok: false, text: async () => "Not Found" };
    });

    await fetchReferencesFromSkill(
      "See references/actors.md",
      "/fake/.swarm/skills/vetted",
      "owner",
      "repo",
      "main",
      "",
    );

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const urls = getRawUrls();
    expect(urls.some((u) => u.includes("/main/"))).toBe(true);
    expect(urls.some((u) => u.includes("/develop/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findSkillPathInRepo — locate SKILL.md in the upstream repo tree
// ---------------------------------------------------------------------------

describe("findSkillPathInRepo", () => {
  function mockTree(paths: string[]): void {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return {
          ok: true,
          json: async () => ({
            tree: paths.map((p) => ({ path: p, type: "blob" })),
          }),
        };
      }
      return { ok: false };
    });
  }

  it("returns 'SKILL.md' when upstream has SKILL.md at repo root", async () => {
    mockTree(["README.md", "SKILL.md", "references/foo.md"]);
    const path = await findSkillPathInRepo("owner", "repo", "main");
    expect(path).toBe("SKILL.md");
  });

  it("returns the subdirectory path when SKILL.md is nested", async () => {
    mockTree([
      "README.md",
      "swift-testing-expert/SKILL.md",
      "swift-testing-expert/references/fundamentals.md",
    ]);
    const path = await findSkillPathInRepo("owner", "repo", "main");
    expect(path).toBe("swift-testing-expert/SKILL.md");
  });

  it("prefers the matching subdirectory in a multi-skill repo", async () => {
    mockTree([
      "skill-a/SKILL.md",
      "skill-a/references/foo.md",
      "skill-b/SKILL.md",
      "skill-b/references/bar.md",
    ]);
    const pathA = await findSkillPathInRepo("owner", "repo", "main", "skill-a");
    expect(pathA).toBe("skill-a/SKILL.md");
    const pathB = await findSkillPathInRepo("owner", "repo", "main", "skill-b");
    expect(pathB).toBe("skill-b/SKILL.md");
  });

  it("falls back to 'SKILL.md' when the API call fails", async () => {
    mockFetch.mockImplementation(async () => ({ ok: false }));
    const path = await findSkillPathInRepo("owner", "repo", "main");
    expect(path).toBe("SKILL.md");
  });

  it("falls back to 'SKILL.md' when no SKILL.md exists in the tree", async () => {
    mockTree(["README.md", "LICENSE"]);
    const path = await findSkillPathInRepo("owner", "repo", "main");
    expect(path).toBe("SKILL.md");
  });

  it("picks the shallowest SKILL.md when preferredSubdir doesn't match", async () => {
    mockTree([
      "deep/nested/path/SKILL.md",
      "shallow/SKILL.md",
    ]);
    const path = await findSkillPathInRepo("owner", "repo", "main", "nonexistent");
    expect(path).toBe("shallow/SKILL.md");
  });

  it("falls back to 'SKILL.md' when fetch rejects (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const path = await findSkillPathInRepo("owner", "repo", "main");
    expect(path).toBe("SKILL.md");
  });

  it("sends Authorization header when GITHUB_TOKEN is set", async () => {
    mockTree(["SKILL.md"]);
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "fake-token";
    try {
      await findSkillPathInRepo("owner", "repo", "main");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("git/trees"));
    const opts = (call?.[1] ?? {}) as { headers?: Record<string, string> };
    expect(opts.headers?.Authorization).toBe("Bearer fake-token");
  });

  it("encodes owner, repo, and branch in the API URL", async () => {
    mockTree(["SKILL.md"]);
    await findSkillPathInRepo("my/org", "my repo", "feature/x");
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("git/trees"));
    const url = String(call?.[0] ?? "");
    expect(url).toContain("my%2Forg");
    expect(url).toContain("my%20repo");
    expect(url).toContain("feature%2Fx");
  });
});

// ---------------------------------------------------------------------------
// Tests: skill ingest to Substrate
// ---------------------------------------------------------------------------

describe("ingestSkillToSubstrate — correct SwarmContent entity shape", () => {
  it("calls ingest with correct SwarmContent entity shape", async () => {
    const mockIngest = vi.fn(async () => ({ accepted: 1, typeName: "SwarmContent" }));
    const mockClient = { ingest: mockIngest } as unknown as Parameters<typeof ingestSkillToSubstrate>[0];

    const skillContent = "# My Skill\n\n## Patterns\n\nUse this pattern.\n";
    await ingestSkillToSubstrate(mockClient, "skills/vetted/my-skill.md", skillContent);

    expect(mockIngest).toHaveBeenCalledOnce();
    const [typeName, entities, mode] = mockIngest.mock.calls[0];

    expect(typeName).toBe("SwarmContent");
    expect(mode).toBe("extend");
    expect(entities).toHaveLength(1);

    const entity = entities[0] as Record<string, unknown>;
    expect(entity.path).toBe("skills/vetted/my-skill.md");
    expect(entity.tier).toBe("skills_vetted");
    expect(entity.intent).toBe("all");
    expect(entity.content).toBe(skillContent);
    expect(entity.projectId).toBe("global");
  });

  it("computes tokenEstimate as ceil(length / 4)", async () => {
    const mockIngest = vi.fn(async () => ({ accepted: 1, typeName: "SwarmContent" }));
    const mockClient = { ingest: mockIngest } as unknown as Parameters<typeof ingestSkillToSubstrate>[0];

    const skillContent = "A".repeat(100); // 100 chars → 25 tokens
    await ingestSkillToSubstrate(mockClient, "skills/vetted/test.md", skillContent);

    const entity = mockIngest.mock.calls[0][1][0] as Record<string, unknown>;
    expect(entity.tokenEstimate).toBe(25);
  });

  it("uses 'extend' mode for ingest", async () => {
    const mockIngest = vi.fn(async () => ({ accepted: 1, typeName: "SwarmContent" }));
    const mockClient = { ingest: mockIngest } as unknown as Parameters<typeof ingestSkillToSubstrate>[0];

    await ingestSkillToSubstrate(mockClient, "skills/vetted/test.md", "content");

    expect(mockIngest.mock.calls[0][2]).toBe("extend");
  });

  it("does nothing when substrateClient is undefined", async () => {
    // Should not throw
    await expect(
      ingestSkillToSubstrate(undefined, "skills/vetted/test.md", "content"),
    ).resolves.toBeUndefined();
  });

  it("is non-fatal when ingest throws", async () => {
    const mockIngest = vi.fn(async () => {
      throw new Error("Substrate unavailable");
    });
    const mockClient = { ingest: mockIngest } as unknown as Parameters<typeof ingestSkillToSubstrate>[0];

    // Should not throw
    await expect(
      ingestSkillToSubstrate(mockClient, "skills/vetted/test.md", "content"),
    ).resolves.toBeUndefined();
  });
});
