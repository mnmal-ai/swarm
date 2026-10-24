import { describe, it, expect, beforeEach, vi } from "vitest";
import { Loader } from "../src/loader/index.js";
import type { Route, LoadingPriorityEntry } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Substrate SwarmContent entity shape (as returned by SubstrateClient.query)
// ---------------------------------------------------------------------------

interface MockSwarmContent {
  path: string;
  tier: string;
  intent: string;
  content: string;
  tokenEstimate: number;
  lastReviewed: string;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a SwarmContent entity for the mock store.
 * tokenEstimate defaults to Math.ceil(content.length / 4).
 */
function makeEntity(
  path: string,
  tier: string,
  content: string,
  opts: { intent?: string; projectId?: string } = {},
): MockSwarmContent {
  return {
    path,
    tier,
    intent: opts.intent ?? "",
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    lastReviewed: "2026-03-01",
    projectId: opts.projectId ?? "",
  };
}

/**
 * Build a Route object pointing to the given skill paths.
 * After the Router migration, all paths live under `all`.
 */
function makeRoute(intent: string, skillPaths: string[]): Route {
  return {
    intent,
    description: `Test route for ${intent}`,
    load: {
      all: skillPaths,
    },
    keywords: [intent],
  };
}

/**
 * Standard priority config that loads skills_vetted as an optional tier.
 */
const SKILL_PRIORITY: LoadingPriorityEntry[] = [
  { tier: "skills_vetted", required: false },
];

/**
 * Priority config with skills_vetted as required (always loads).
 */
const SKILL_PRIORITY_REQUIRED: LoadingPriorityEntry[] = [
  { tier: "skills_vetted", required: true },
];

/**
 * Create a mock SubstrateClient that returns the given SwarmContent entities.
 */
function createMockSubstrateClient(entities: MockSwarmContent[]) {
  return {
    query: vi.fn(async () => entities),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Loader — skill loading and intent filtering via Substrate", () => {
  // -------------------------------------------------------------------------
  // Glob-style prefix matching
  // -------------------------------------------------------------------------

  describe("glob-style prefix matching with skills/vetted/*.md", () => {
    it("matches all .md entities under the directory prefix", async () => {
      const entities = [
        makeEntity("skills/vetted/git-workflow.md", "skills_vetted", "# Git Workflow\nGit tips."),
        makeEntity("skills/vetted/testing.md", "skills_vetted", "# Testing\nTest tips."),
        makeEntity("skills/vetted/readme.txt", "skills_vetted", "Not a markdown file"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/*.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      const loadedPaths = result.files.map((f) => f.path);
      expect(loadedPaths).toContain("skills/vetted/git-workflow.md");
      expect(loadedPaths).toContain("skills/vetted/testing.md");
      // .txt file should not be included (does not match *.md)
      expect(loadedPaths).not.toContain("skills/vetted/readme.txt");
    });

    it("returns files in sorted order", async () => {
      const entities = [
        makeEntity("skills/vetted/zebra.md", "skills_vetted", "# Zebra"),
        makeEntity("skills/vetted/alpha.md", "skills_vetted", "# Alpha"),
        makeEntity("skills/vetted/middle.md", "skills_vetted", "# Middle"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/*.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      const loadedPaths = result.files.map((f) => f.path);
      expect(loadedPaths).toEqual([
        "skills/vetted/alpha.md",
        "skills/vetted/middle.md",
        "skills/vetted/zebra.md",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Intent filtering via SwarmContent entity tier
  // -------------------------------------------------------------------------

  describe("intent filtering via SwarmContent entity", () => {
    it("loads entity with matching intent", async () => {
      const entities = [
        makeEntity(
          "skills/vetted/impl-skill.md",
          "skills_vetted",
          "# Implementation Skill\nSome content.",
          { intent: "implementation" },
        ),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/impl-skill.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("skills/vetted/impl-skill.md");
    });

    it("skips entity when intent does not match", async () => {
      const entities = [
        makeEntity(
          "skills/vetted/impl-only.md",
          "skills_vetted",
          "# Implementation Only\nThis skill is only for implementation.",
          { intent: "implementation" },
        ),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("code-review", ["skills/vetted/impl-only.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      expect(result.files).toHaveLength(0);
    });

    it("loads an entity whose intent is \"all\", as swarm sync and swarm add skill write it, on any route", async () => {
      const entities = [
        makeEntity("skills/vetted/everywhere.md", "skills_vetted", "# Everywhere", { intent: "all" }),
      ];
      const loader = new Loader(createMockSubstrateClient(entities) as any);
      for (const intent of ["implementation", "code-review", "investigation"]) {
        const result = await loader.load(makeRoute(intent, ["skills/vetted/everywhere.md"]), 100000, SKILL_PRIORITY);
        expect(result.files).toHaveLength(1);
      }
    });

    it("loads entity without intent field on any route", async () => {
      // Empty intent means "loads on all intents"
      const entities = [
        makeEntity(
          "skills/vetted/universal.md",
          "skills_vetted",
          "# Universal\nAvailable on all intents.",
        ),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);

      // Test on implementation route
      const resultImpl = await loader.load(
        makeRoute("implementation", ["skills/vetted/universal.md"]),
        100000,
        SKILL_PRIORITY,
      );
      expect(resultImpl.files).toHaveLength(1);

      // Test on code-review route
      const resultReview = await loader.load(
        makeRoute("code-review", ["skills/vetted/universal.md"]),
        100000,
        SKILL_PRIORITY,
      );
      expect(resultReview.files).toHaveLength(1);
    });

    it("handles comma-separated intents on an entity", async () => {
      const entities = [
        makeEntity(
          "skills/vetted/multi.md",
          "skills_vetted",
          "# Multi-Intent Skill",
          { intent: "implementation,code-review" },
        ),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);

      // Should load on implementation
      const r1 = await loader.load(
        makeRoute("implementation", ["skills/vetted/multi.md"]),
        100000,
        SKILL_PRIORITY,
      );
      expect(r1.files).toHaveLength(1);

      // Should load on code-review
      const r2 = await loader.load(
        makeRoute("code-review", ["skills/vetted/multi.md"]),
        100000,
        SKILL_PRIORITY,
      );
      expect(r2.files).toHaveLength(1);

      // Should NOT load on investigation
      const r3 = await loader.load(
        makeRoute("investigation", ["skills/vetted/multi.md"]),
        100000,
        SKILL_PRIORITY,
      );
      expect(r3.files).toHaveLength(0);
    });

    it("filters by intent when glob expands to multiple entities", async () => {
      const entities = [
        makeEntity(
          "skills/vetted/impl.md",
          "skills_vetted",
          "# Impl Skill",
          { intent: "implementation" },
        ),
        makeEntity(
          "skills/vetted/review.md",
          "skills_vetted",
          "# Review Skill",
          { intent: "code-review" },
        ),
        makeEntity(
          "skills/vetted/universal.md",
          "skills_vetted",
          "# Universal\nNo intent means load always.",
        ),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/*.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      const loadedPaths = result.files.map((f) => f.path);
      expect(loadedPaths).toContain("skills/vetted/impl.md");
      expect(loadedPaths).toContain("skills/vetted/universal.md");
      expect(loadedPaths).not.toContain("skills/vetted/review.md");
    });
  });

  // -------------------------------------------------------------------------
  // ** glob pattern handling
  // -------------------------------------------------------------------------

  describe("** glob pattern", () => {
    it("does not crash on ** pattern (handles gracefully)", async () => {
      const entities = [
        makeEntity("skills/vetted/deep/nested.md", "skills_vetted", "# Deep Nested"),
        makeEntity("skills/vetted/top-level.md", "skills_vetted", "# Top Level"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      // ** patterns are silently skipped — no files should be loaded.
      const route = makeRoute("implementation", ["skills/**/nested.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      expect(result.files).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Empty results
  // -------------------------------------------------------------------------

  describe("empty results", () => {
    it("returns no files when glob matches no entities", async () => {
      // No entities at all
      const client = createMockSubstrateClient([]);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/*.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      expect(result.files).toEqual([]);
      expect(result.totalTokens).toBe(0);
    });

    it("returns no files when no entities match the path", async () => {
      const entities = [
        makeEntity("skills/vetted/existing.md", "skills_vetted", "# Existing"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/nonexistent/*.md"]);
      const result = await loader.load(route, 100000, SKILL_PRIORITY);

      expect(result.files).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Budget enforcement with skills
  // -------------------------------------------------------------------------

  describe("budget enforcement", () => {
    it("truncates optional skill files that exceed the budget", async () => {
      const entities = [
        makeEntity("skills/vetted/big.md", "skills_vetted", "x".repeat(400)),
        makeEntity("skills/vetted/small.md", "skills_vetted", "tiny"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/*.md"]);
      // Budget of 50 tokens — the big file (~100 tokens) won't fit after small loads
      const result = await loader.load(route, 50, SKILL_PRIORITY);

      // small.md (1 token) should load, big.md (~100 tokens) should be truncated
      // (sorted order: big.md first, small.md second — big exceeds budget, small fits)
      const loadedPaths = result.files.map((f) => f.path);
      expect(loadedPaths).toContain("skills/vetted/small.md");
      expect(result.truncated).toContain("skills/vetted/big.md");
    });

    it("loads all skill files when required regardless of budget", async () => {
      const entities = [
        makeEntity("skills/vetted/big.md", "skills_vetted", "x".repeat(400)),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["skills/vetted/big.md"]);
      // Budget of 10 tokens — far too small, but required tier loads anyway
      const result = await loader.load(route, 10, SKILL_PRIORITY_REQUIRED);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("skills/vetted/big.md");
    });
  });

  // -------------------------------------------------------------------------
  // Substrate query behavior
  // -------------------------------------------------------------------------

  describe("Substrate integration", () => {
    it("queries SwarmContent from SubstrateClient", async () => {
      const entities = [
        makeEntity("core/values.md", "core", "# Values"),
      ];
      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["core/values.md"]);
      const priority: LoadingPriorityEntry[] = [
        { tier: "core", required: true },
      ];
      await loader.load(route, 100000, priority);

      expect(client.query).toHaveBeenCalledWith(
        "SwarmContent",
        {},
        {
          path: true,
          tier: true,
          intent: true,
          content: true,
          tokenEstimate: true,
          lastReviewed: true,
          projectId: true,
        },
      );
    });

    it("uses tokenEstimate from entity instead of computing from content", async () => {
      // Create an entity with an explicit tokenEstimate that differs from
      // what Math.ceil(content.length / 4) would give
      const entity: MockSwarmContent = {
        path: "core/values.md",
        tier: "core",
        intent: "",
        content: "# Values\nBe excellent.",
        tokenEstimate: 999,  // Deliberately different from content-based estimate
        lastReviewed: "2026-03-01",
        projectId: "",
      };

      const client = createMockSubstrateClient([entity]);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["core/values.md"]);
      const priority: LoadingPriorityEntry[] = [
        { tier: "core", required: true },
      ];
      const result = await loader.load(route, 100000, priority);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].estimatedTokens).toBe(999);
      expect(result.totalTokens).toBe(999);
    });
  });

  // -------------------------------------------------------------------------
  // assembleContext
  // -------------------------------------------------------------------------

  describe("assembleContext", () => {
    it("joins loaded files with headers", () => {
      const client = createMockSubstrateClient([]);
      const loader = new Loader(client as any);

      const assembled = loader.assembleContext([
        { path: "core/values.md", tier: "core", content: "# Values", estimatedTokens: 3 },
        { path: "modes/code-review.md", tier: "mode", content: "# Code Review", estimatedTokens: 4 },
      ]);

      expect(assembled).toContain("--- swarm: core/values.md (core) ---");
      expect(assembled).toContain("# Values");
      expect(assembled).toContain("--- swarm: modes/code-review.md (mode) ---");
      expect(assembled).toContain("# Code Review");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-tier loading with entity tier field
  // -------------------------------------------------------------------------

  describe("multi-tier loading", () => {
    it("groups entities by their tier field and respects priority order", async () => {
      const entities = [
        makeEntity("core/values.md", "core", "# Values"),
        makeEntity("core/rules.md", "core", "# Rules"),
        makeEntity("modes/code-review.md", "mode", "# Code Review"),
        makeEntity("capabilities/git-workflow.md", "capabilities", "# Git Workflow"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("code-review", [
        "core/values.md",
        "core/rules.md",
        "modes/code-review.md",
        "capabilities/git-workflow.md",
      ]);
      const priority: LoadingPriorityEntry[] = [
        { tier: "core", required: true },
        { tier: "mode", required: true },
        { tier: "capabilities", required: false },
      ];
      const result = await loader.load(route, 100000, priority);

      expect(result.files).toHaveLength(4);
      // Core and mode loaded as required, capabilities as optional
      expect(result.files.map((f) => f.tier)).toEqual([
        "core",
        "core",
        "mode",
        "capabilities",
      ]);
    });

    it("truncates optional tiers when budget is exceeded", async () => {
      const entities = [
        makeEntity("core/values.md", "core", "# Values\n" + "x".repeat(200)),
        makeEntity("modes/impl.md", "mode", "# Impl\n" + "x".repeat(200)),
        makeEntity("capabilities/git.md", "capabilities", "# Git\n" + "x".repeat(400)),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", [
        "core/values.md",
        "modes/impl.md",
        "capabilities/git.md",
      ]);
      const priority: LoadingPriorityEntry[] = [
        { tier: "core", required: true },
        { tier: "mode", required: true },
        { tier: "capabilities", required: false },
      ];
      // Budget is 120 tokens: core (~53) + mode (~53) = ~106, capabilities (~103) exceeds
      const result = await loader.load(route, 120, priority);

      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.tier)).toEqual(["core", "mode"]);
      expect(result.truncated).toContain("capabilities/git.md");
    });
  });

  // -------------------------------------------------------------------------
  // {project} placeholder replacement
  // -------------------------------------------------------------------------

  describe("{project} placeholder", () => {
    it("replaces {project} in paths before matching", async () => {
      const entities = [
        makeEntity("domains/ios-app/conventions.md", "domain", "# iOS Conventions"),
      ];

      const client = createMockSubstrateClient(entities);
      const loader = new Loader(client as any);
      const route = makeRoute("implementation", ["domains/{project}/conventions.md"]);
      const priority: LoadingPriorityEntry[] = [
        { tier: "domain", required: false },
      ];
      const result = await loader.load(route, 100000, priority, "ios-app");

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("domains/ios-app/conventions.md");
    });
  });

  // -------------------------------------------------------------------------
  // Several projects sharing one Substrate
  // -------------------------------------------------------------------------

  describe("project scoping", () => {
    const entities = [
      makeEntity("core/values.md", "core", "# Legacy values", { projectId: "global" }),
      makeEntity("core/values.md", "core", "# B values", { projectId: "project-b" }),
      makeEntity("core/values.md", "core", "# A values", { projectId: "project-a" }),
      makeEntity("core/rules.md", "core", "# Legacy rules", { projectId: "global" }),
      makeEntity("core/rules.md", "core", "# B rules", { projectId: "project-b" }),
    ];
    const route = makeRoute("implementation", ["core/values.md", "core/rules.md"]);
    const priority: LoadingPriorityEntry[] = [{ tier: "core", required: true }];

    it("loads the project's own rows, then legacy rows, never another project's", async () => {
      const loader = new Loader(createMockSubstrateClient(entities) as any);
      const result = await loader.load(route, 100000, priority, "project-a");

      expect(result.files.map((f) => f.content).sort()).toEqual(["# A values", "# Legacy rules"]);
    });
  });
});
