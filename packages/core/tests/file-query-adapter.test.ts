import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock node:fs/promises before importing the adapter ---
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
}));

// Mock node:fs for the constants import
vi.mock("node:fs", () => ({
  constants: { R_OK: 4 },
}));

import { readFile, readdir, stat, access } from "node:fs/promises";
import { FileQueryAdapter } from "../src/file-query-adapter.js";

// --- Helpers ---

const SWARM_DIR = "/fake/.swarm";

/**
 * Minimal swarm.json that matches the shape the adapter expects.
 */
const SWARM_JSON = JSON.stringify({
  version: "0.1.0",
  context_budget: {
    default_max_tokens: 15000,
    model_overrides: {
      "claude-opus-4-6": 20000,
      "claude-sonnet-4-6": 14000,
    },
  },
  routes: [
    {
      intent: "code-review",
      description: "Review code changes for quality, conventions, and correctness.",
      keywords: ["review", "PR", "pull request", "code review"],
      load: {
        core: ["core/values.md", "core/rules.md", "core/voice.md"],
        mode: ["modes/code-review.md"],
        oversight: ["oversight/review-policy.json"],
        capabilities: ["capabilities/git-workflow.md"],
      },
    },
    {
      intent: "implementation",
      description: "Build a feature or fix a bug.",
      keywords: ["build", "implement", "create", "fix"],
      load: {
        core: ["core/values.md", "core/rules.md", "core/voice.md"],
        mode: ["modes/implementation.md"],
        oversight: ["oversight/review-policy.json"],
      },
    },
  ],
});

// Cast mocks to vi.Mock for type-safe .mockImplementation calls
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as unknown as ReturnType<typeof vi.fn>;
const mockStat = stat as unknown as ReturnType<typeof vi.fn>;
const mockAccess = access as unknown as ReturnType<typeof vi.fn>;

describe("FileQueryAdapter", () => {
  let adapter: FileQueryAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // By default, swarm.json is accessible
    mockAccess.mockResolvedValue(undefined);
    adapter = new FileQueryAdapter(SWARM_DIR);
  });

  // -------- SwarmRoute --------

  describe("query('SwarmRoute')", () => {
    beforeEach(() => {
      mockReadFile.mockResolvedValue(SWARM_JSON);
    });

    it("should return one entity per route", async () => {
      const routes = await adapter.query<{
        intent: string;
        description: string;
        keywords: string;
        contentPaths: string;
      }>("SwarmRoute", {}, {});

      expect(routes).toHaveLength(2);
      expect(routes[0].intent).toBe("code-review");
      expect(routes[1].intent).toBe("implementation");
    });

    it("should JSON-stringify keywords (not return raw array)", async () => {
      const routes = await adapter.query<{
        intent: string;
        description: string;
        keywords: string;
        contentPaths: string;
      }>("SwarmRoute", {}, {});

      const route = routes[0];
      // Must be a string, not an array
      expect(typeof route.keywords).toBe("string");
      // Must parse back to the correct keywords
      const parsed = JSON.parse(route.keywords) as string[];
      expect(parsed).toContain("review");
      expect(parsed).toContain("PR");
    });

    it("should JSON-stringify contentPaths flattened from all tiers", async () => {
      const routes = await adapter.query<{
        intent: string;
        description: string;
        keywords: string;
        contentPaths: string;
      }>("SwarmRoute", {}, {});

      const route = routes[0];
      expect(typeof route.contentPaths).toBe("string");

      const paths = JSON.parse(route.contentPaths) as string[];
      // Should contain paths from all tiers (core, mode, oversight, capabilities)
      expect(paths).toContain("core/values.md");
      expect(paths).toContain("core/rules.md");
      expect(paths).toContain("modes/code-review.md");
      expect(paths).toContain("oversight/review-policy.json");
      expect(paths).toContain("capabilities/git-workflow.md");
    });

    it("should include the description", async () => {
      const routes = await adapter.query<{
        intent: string;
        description: string;
        keywords: string;
        contentPaths: string;
      }>("SwarmRoute", {}, {});

      expect(routes[0].description).toBe(
        "Review code changes for quality, conventions, and correctness.",
      );
    });

    it("should cache swarm.json after first read", async () => {
      await adapter.query("SwarmRoute", {}, {});
      await adapter.query("SwarmRoute", {}, {});

      // readFile should only be called once (the second call uses the cache)
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });

  // -------- SwarmConfig --------

  describe("query('SwarmConfig')", () => {
    beforeEach(() => {
      mockReadFile.mockResolvedValue(SWARM_JSON);
    });

    it("should return a default_max_tokens entry", async () => {
      const configs = await adapter.query<{
        key: string;
        value: string;
        category: string;
      }>("SwarmConfig", {}, {});

      const entry = configs.find((c) => c.key === "default_max_tokens");
      expect(entry).toBeDefined();
      expect(entry?.value).toBe("15000");
      expect(entry?.category).toBe("budget");
    });

    it("should return model_override entries with string values", async () => {
      const configs = await adapter.query<{
        key: string;
        value: string;
        category: string;
      }>("SwarmConfig", {}, {});

      const opusEntry = configs.find(
        (c) => c.key === "model_override:claude-opus-4-6",
      );
      expect(opusEntry).toBeDefined();
      expect(opusEntry?.value).toBe("20000");
      expect(typeof opusEntry?.value).toBe("string");

      const sonnetEntry = configs.find(
        (c) => c.key === "model_override:claude-sonnet-4-6",
      );
      expect(sonnetEntry).toBeDefined();
      expect(sonnetEntry?.value).toBe("14000");
    });

    it("should set category to 'budget' for all entries", async () => {
      const configs = await adapter.query<{
        key: string;
        value: string;
        category: string;
      }>("SwarmConfig", {}, {});

      for (const c of configs) {
        expect(c.category).toBe("budget");
      }
    });
  });

  // -------- SwarmContent --------

  describe("query('SwarmContent')", () => {
    /**
     * Helper to set up readdir + stat + readFile mocks for a virtual
     * directory tree.
     *
     * Tree:
     *   .swarm/
     *     swarm.json           ← skipped
     *     core/
     *       values.md
     *       rules.md
     *     modes/
     *       code-review.md
     *     capabilities/
     *       git-workflow.md
     *     oversight/
     *       review-policy.json
     *     skills/
     *       vetted/
     *         drizzle.md
     *       community/
     *         foo.md
     *       core/
     *         bar.md
     *     domains/
     *       my-project/
     *         architecture.md
     */
    beforeEach(() => {
      const isDir = (name: string) =>
        [
          SWARM_DIR,
          `${SWARM_DIR}/core`,
          `${SWARM_DIR}/modes`,
          `${SWARM_DIR}/capabilities`,
          `${SWARM_DIR}/oversight`,
          `${SWARM_DIR}/skills`,
          `${SWARM_DIR}/skills/vetted`,
          `${SWARM_DIR}/skills/community`,
          `${SWARM_DIR}/skills/core`,
          `${SWARM_DIR}/domains`,
          `${SWARM_DIR}/domains/my-project`,
        ].includes(name);

      mockStat.mockImplementation(async (p: string) => ({
        isDirectory: () => isDir(p),
        isFile: () => !isDir(p),
      }));

      mockReaddir.mockImplementation(async (dir: string) => {
        const map: Record<string, string[]> = {
          [SWARM_DIR]: ["swarm.json", "core", "modes", "capabilities", "oversight", "skills", "domains"],
          [`${SWARM_DIR}/core`]: ["values.md", "rules.md"],
          [`${SWARM_DIR}/modes`]: ["code-review.md"],
          [`${SWARM_DIR}/capabilities`]: ["git-workflow.md"],
          [`${SWARM_DIR}/oversight`]: ["review-policy.json"],
          [`${SWARM_DIR}/skills`]: ["vetted", "community", "core"],
          [`${SWARM_DIR}/skills/vetted`]: ["drizzle.md"],
          [`${SWARM_DIR}/skills/community`]: ["foo.md"],
          [`${SWARM_DIR}/skills/core`]: ["bar.md"],
          [`${SWARM_DIR}/domains`]: ["my-project"],
          [`${SWARM_DIR}/domains/my-project`]: ["architecture.md"],
        };
        return map[dir as string] ?? [];
      });

      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === `${SWARM_DIR}/swarm.json`) return SWARM_JSON;
        // Return synthetic content whose length is predictable
        const name = String(filePath).split("/").pop() ?? "file";
        return `# ${name}\n${"Content ".repeat(10)}`;
      });
    });

    it("should return content entities for .md and .json files", async () => {
      const content = await adapter.query<{
        path: string;
        tier: string;
        intent: string;
        content: string;
        tokenEstimate: number;
        lastReviewed: string;
        projectId: string;
      }>("SwarmContent", {}, {});

      // Should find 8 files (values.md, rules.md, code-review.md, git-workflow.md,
      // review-policy.json, drizzle.md, foo.md, bar.md, architecture.md)
      // swarm.json itself is excluded
      expect(content.length).toBeGreaterThanOrEqual(8);

      const paths = content.map((c) => c.path);
      expect(paths).toContain("core/values.md");
      expect(paths).toContain("core/rules.md");
      expect(paths).toContain("modes/code-review.md");
      expect(paths).toContain("capabilities/git-workflow.md");
      expect(paths).toContain("oversight/review-policy.json");
      expect(paths).toContain("skills/vetted/drizzle.md");
      expect(paths).toContain("skills/community/foo.md");
      expect(paths).toContain("skills/core/bar.md");
      expect(paths).not.toContain("swarm.json");
    });

    it("should map directory names to the correct tier", async () => {
      const content = await adapter.query<{
        path: string;
        tier: string;
        intent: string;
        content: string;
        tokenEstimate: number;
        lastReviewed: string;
        projectId: string;
      }>("SwarmContent", {}, {});

      const byPath = Object.fromEntries(content.map((c) => [c.path, c]));

      expect(byPath["core/values.md"]?.tier).toBe("core");
      expect(byPath["modes/code-review.md"]?.tier).toBe("mode");
      expect(byPath["capabilities/git-workflow.md"]?.tier).toBe("capabilities");
      expect(byPath["oversight/review-policy.json"]?.tier).toBe("oversight");
      expect(byPath["skills/vetted/drizzle.md"]?.tier).toBe("skills_vetted");
      expect(byPath["skills/community/foo.md"]?.tier).toBe("skills_community");
      expect(byPath["skills/core/bar.md"]?.tier).toBe("skills_core");
      expect(byPath["domains/my-project/architecture.md"]?.tier).toBe("domain");
    });

    it("should set intent, lastReviewed, and projectId to empty strings", async () => {
      const content = await adapter.query<{
        path: string;
        tier: string;
        intent: string;
        content: string;
        tokenEstimate: number;
        lastReviewed: string;
        projectId: string;
      }>("SwarmContent", {}, {});

      for (const c of content) {
        expect(c.intent).toBe("");
        expect(c.lastReviewed).toBe("");
        expect(c.projectId).toBe("");
      }
    });

    it("should compute tokenEstimate as Math.ceil(content.length / 4)", async () => {
      const content = await adapter.query<{
        path: string;
        tier: string;
        intent: string;
        content: string;
        tokenEstimate: number;
        lastReviewed: string;
        projectId: string;
      }>("SwarmContent", {}, {});

      for (const c of content) {
        const expected = Math.ceil(c.content.length / 4);
        expect(c.tokenEstimate).toBe(expected);
      }
    });

    it("should not include files from skipped directories", async () => {
      // Add a 'designs' dir to root listing
      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === SWARM_DIR) {
          return ["swarm.json", "core", "designs", "node_modules"];
        }
        if (dir === `${SWARM_DIR}/core`) return ["values.md"];
        return [];
      });

      mockStat.mockImplementation(async (p: string) => ({
        isDirectory: () =>
          [
            SWARM_DIR,
            `${SWARM_DIR}/core`,
            `${SWARM_DIR}/designs`,
            `${SWARM_DIR}/node_modules`,
          ].includes(p),
        isFile: () =>
          ![
            SWARM_DIR,
            `${SWARM_DIR}/core`,
            `${SWARM_DIR}/designs`,
            `${SWARM_DIR}/node_modules`,
          ].includes(p),
      }));

      const content = await adapter.query<{ path: string }>(
        "SwarmContent",
        {},
        {},
      );

      const paths = content.map((c) => c.path);
      // Should only have core/values.md; no files under designs or node_modules
      expect(paths).toContain("core/values.md");
      expect(paths.some((p) => p.startsWith("designs/"))).toBe(false);
      expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    });
  });

  // -------- Unknown type --------

  describe("query (unknown type)", () => {
    it("should return empty array for unrecognized type names", async () => {
      const result = await adapter.query("WorkerResult", {}, {});
      expect(result).toEqual([]);
    });

    it("should return empty array for OversightChain type", async () => {
      const result = await adapter.query("OversightChain", {}, {});
      expect(result).toEqual([]);
    });

    it("should return empty array for SessionEvent type", async () => {
      const result = await adapter.query("SessionEvent", {}, {});
      expect(result).toEqual([]);
    });
  });
});
