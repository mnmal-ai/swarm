import { describe, it, expect, beforeEach, vi } from "vitest";
import { Router } from "../src/index.js";

/**
 * Canned SwarmRoute entities matching the real swarm.json routes.
 * keywords and contentPaths are JSON-serialized arrays, as stored in Substrate.
 */
const MOCK_SWARM_ROUTES = [
  {
    intent: "code-review",
    description: "Review code changes for quality, conventions, and correctness.",
    keywords: JSON.stringify([
      "review",
      "PR",
      "pull request",
      "code review",
      "check this",
      "look at this diff",
    ]),
    contentPaths: JSON.stringify([
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/code-review.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md",
    ]),
  },
  {
    intent: "implementation",
    description: "Build a feature or fix a bug.",
    keywords: JSON.stringify([
      "build",
      "implement",
      "create",
      "add",
      "feature",
      "fix",
      "refactor",
      "write",
    ]),
    contentPaths: JSON.stringify([
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/implementation.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md",
      "capabilities/testing.md",
    ]),
  },
  {
    intent: "investigation",
    description: "Debug an issue or research a question.",
    keywords: JSON.stringify([
      "debug",
      "investigate",
      "why",
      "broken",
      "error",
      "failing",
      "research",
      "understand",
    ]),
    contentPaths: JSON.stringify([
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/investigation.md",
      "oversight/review-policy.json",
    ]),
  },
  {
    intent: "onboarding",
    description: "Initialize the swarm for a new project.",
    keywords: JSON.stringify([
      "init",
      "onboard",
      "new project",
      "get started",
      "initialize",
      "adopt",
      "setup project",
    ]),
    contentPaths: JSON.stringify([
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/onboarding.md",
      "oversight/review-policy.json",
    ]),
  },
  {
    intent: "orchestration",
    description: "Coordinate multi-task execution toward project goals.",
    keywords: JSON.stringify([
      "orchestrate",
      "dispatch",
      "coordinate",
      "run goals",
      "execute goals",
      "plan execution",
    ]),
    contentPaths: JSON.stringify([
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/orchestration.md",
      "oversight/review-policy.json",
    ]),
  },
];

/**
 * Canned SwarmConfig entities matching the real swarm.json context_budget.
 */
const MOCK_SWARM_CONFIGS = [
  { key: "default_max_tokens", value: "15000", category: "budget" },
  { key: "model_override:claude-opus-4-6", value: "20000", category: "budget" },
  { key: "model_override:claude-sonnet-4-6", value: "14000", category: "budget" },
  // Recall tuning knobs — sibling category off the same SwarmConfig query.
  { key: "recall_similarity_threshold", value: "0", category: "recall" },
  { key: "recall_top_k", value: "8", category: "recall" },
];

/**
 * Create a mock SubstrateClient that returns canned SwarmRoute and SwarmConfig
 * entities from query(). Only the query method is needed for Router tests.
 */
function createMockSubstrateClient() {
  return {
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") return MOCK_SWARM_ROUTES;
      if (typeName === "SwarmConfig") return MOCK_SWARM_CONFIGS;
      return [];
    }),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

describe("Router", () => {
  let router: Router;
  let mockClient: ReturnType<typeof createMockSubstrateClient>;

  beforeEach(() => {
    mockClient = createMockSubstrateClient();
    router = new Router(mockClient as any);
  });

  describe("classify", () => {
    it("should classify a code review request", async () => {
      const result = await router.classify("Review this pull request for issues");
      expect(result.intent).toBe("code-review");
      expect(result.confidence).toBe("keyword");
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });

    it("should classify an implementation request", async () => {
      const result = await router.classify("Build a new login feature");
      expect(result.intent).toBe("implementation");
      expect(result.confidence).toBe("keyword");
    });

    it("should classify a debug request", async () => {
      const result = await router.classify("Why is the auth endpoint failing?");
      expect(result.intent).toBe("investigation");
      expect(result.confidence).toBe("keyword");
    });

    it("should fallback for unrecognized tasks", async () => {
      const result = await router.classify("What is the meaning of life?");
      expect(result.intent).toBe("fallback");
      expect(result.confidence).toBe("fallback");
    });

    it("should respect intent override", async () => {
      const result = await router.classify(
        "What is the meaning of life?",
        "code-review",
      );
      expect(result.intent).toBe("code-review");
      expect(result.confidence).toBe("exact");
    });

    it("should return the route with file paths", async () => {
      const result = await router.classify("Review this PR");
      expect(result.route.load).toBeDefined();
      // Substrate routes put all paths under "all" tier
      expect(result.route.load["all"]).toBeInstanceOf(Array);
      expect(result.route.load["all"].length).toBeGreaterThan(0);
    });

    it("should query SubstrateClient for SwarmRoute and SwarmConfig", async () => {
      await router.classify("Review this PR");
      expect(mockClient.query).toHaveBeenCalledWith(
        "SwarmRoute",
        {},
        { intent: true, description: true, keywords: true, contentPaths: true },
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        "SwarmConfig",
        {},
        { key: true, value: true, category: true },
      );
    });

    it("should cache Substrate queries after first load", async () => {
      await router.classify("Review this PR");
      await router.classify("Build a new feature");
      // Only 2 query calls total (one for SwarmRoute, one for SwarmConfig),
      // not 4, because the second classify uses the cache.
      expect(mockClient.query).toHaveBeenCalledTimes(2);
    });
  });

  // The mock client above implements only `query`, so the suite above exercises
  // the local keyword-scoring path. These tests add a `classifyIntent`-capable
  // client to cover the server-delegated path: the resolver's
  // {intent, confidence, matchedKeywords} must map into the ClassificationResult
  // with `route` resolved locally from the cached routes.
  describe("classify (server-side classifyIntent path)", () => {
    function createClassifyClient(
      response: { intent: string; confidence: string; matchedKeywords: string[] },
    ) {
      const base = createMockSubstrateClient();
      return {
        ...base,
        classifyIntent: vi.fn(async () => response),
      };
    }

    it("prefers classifyIntent over local scoring and resolves the route locally", async () => {
      const client = createClassifyClient({
        intent: "implementation",
        confidence: "keyword",
        matchedKeywords: ["build"],
      });
      const r = new Router(client as any);

      const result = await r.classify("Review this PR");

      // Maps the resolver's verdict verbatim (a router built without a project
      // asks for no project scope)...
      expect(client.classifyIntent).toHaveBeenCalledWith({
        prompt: "Review this PR",
        projectId: "",
        intentOverride: undefined,
      });
      expect(result.intent).toBe("implementation");
      expect(result.confidence).toBe("keyword");
      expect(result.matchedKeywords).toEqual(["build"]);
      // ...while the route (and its load manifest) comes from the cached routes,
      // not from the resolver response.
      expect(result.route.intent).toBe("implementation");
      expect(result.route.load["all"].length).toBeGreaterThan(0);
    });

    it("passes the intentOverride through to the resolver", async () => {
      const client = createClassifyClient({
        intent: "code-review",
        confidence: "exact",
        matchedKeywords: [],
      });
      const r = new Router(client as any);

      const result = await r.classify("anything", "code-review");

      expect(client.classifyIntent).toHaveBeenCalledWith({
        prompt: "anything",
        projectId: "",
        intentOverride: "code-review",
      });
      expect(result.confidence).toBe("exact");
      expect(result.route.intent).toBe("code-review");
    });

    it("scopes the resolver to the project a call names, else the constructor's", async () => {
      const client = createClassifyClient({
        intent: "implementation",
        confidence: "keyword",
        matchedKeywords: ["build"],
      });
      const r = new Router(client as any, "constructor-project");

      await r.classify("build it", undefined, "run-project");
      await r.classify("build it");

      expect(client.classifyIntent).toHaveBeenNthCalledWith(1, {
        prompt: "build it",
        projectId: "run-project",
        intentOverride: undefined,
      });
      expect(client.classifyIntent).toHaveBeenNthCalledWith(2, {
        prompt: "build it",
        projectId: "constructor-project",
        intentOverride: undefined,
      });
    });

    it("maps a fallback verdict to the synthetic fallback route", async () => {
      const client = createClassifyClient({
        intent: "fallback",
        confidence: "fallback",
        matchedKeywords: [],
      });
      const r = new Router(client as any);

      const result = await r.classify("xyzzy nonsense");

      expect(result.intent).toBe("fallback");
      expect(result.confidence).toBe("fallback");
      // The fallback intent names no stored route; the synthetic route's
      // core-only load config must still be present.
      expect(result.route.load["core"].length).toBeGreaterThan(0);
    });

    it("honors a custom projectId in the resolver request", async () => {
      const client = createClassifyClient({
        intent: "implementation",
        confidence: "keyword",
        matchedKeywords: ["build"],
      });
      const r = new Router(client as any, "my-project");

      await r.classify("build something");

      expect(client.classifyIntent).toHaveBeenCalledWith({
        prompt: "build something",
        projectId: "my-project",
        intentOverride: undefined,
      });
    });
  });

  describe("getBudget", () => {
    it("should return model-specific budget when defined", async () => {
      const budget = await router.getBudget("claude-opus-4-6");
      expect(budget).toBe(20000);
    });

    it("should return default budget for unknown models", async () => {
      const budget = await router.getBudget("unknown-model");
      expect(budget).toBe(15000);
    });
  });

  describe("getRecallConfig", () => {
    it("surfaces similarityThreshold and topK from recall-category configs", async () => {
      const config = await router.getRecallConfig();
      expect(config.similarityThreshold).toBe(0);
      expect(config.topK).toBe(8);
    });

    it("parses a non-zero similarity threshold once a tuning task sets one", async () => {
      const client = createMockSubstrateClient();
      client.query = vi.fn(async (typeName: string) => {
        if (typeName === "SwarmRoute") return MOCK_SWARM_ROUTES;
        if (typeName === "SwarmConfig")
          return [
            { key: "recall_similarity_threshold", value: "0.72", category: "recall" },
            { key: "recall_top_k", value: "12", category: "recall" },
          ];
        return [];
      }) as any;
      const r = new Router(client as any);

      const config = await r.getRecallConfig();
      expect(config.similarityThreshold).toBe(0.72);
      expect(config.topK).toBe(12);
    });

    it("leaves fields unset when no recall-category rows exist (no behavior change)", async () => {
      const client = createMockSubstrateClient();
      client.query = vi.fn(async (typeName: string) => {
        if (typeName === "SwarmRoute") return MOCK_SWARM_ROUTES;
        // Only budget configs — no recall category.
        if (typeName === "SwarmConfig")
          return [{ key: "default_max_tokens", value: "15000", category: "budget" }];
        return [];
      }) as any;
      const r = new Router(client as any);

      const config = await r.getRecallConfig();
      expect(config.similarityThreshold).toBeUndefined();
      expect(config.topK).toBeUndefined();
    });

    it("degrades a non-finite threshold to the 0 default rather than NaN", async () => {
      const client = createMockSubstrateClient();
      client.query = vi.fn(async (typeName: string) => {
        if (typeName === "SwarmRoute") return MOCK_SWARM_ROUTES;
        if (typeName === "SwarmConfig")
          return [{ key: "recall_similarity_threshold", value: "not-a-number", category: "recall" }];
        return [];
      }) as any;
      const r = new Router(client as any);

      const config = await r.getRecallConfig();
      expect(config.similarityThreshold).toBe(0);
      expect(config.topK).toBeUndefined();
    });

    it("does not add a second Substrate query — recall reuses the SwarmConfig load", async () => {
      await router.getBudget("claude-opus-4-6");
      await router.getRecallConfig();
      // One SwarmRoute + one SwarmConfig query total, shared across both getters.
      expect(mockClient.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("getLoadingPriority", () => {
    it("should return hardcoded loading priority", async () => {
      const priority = await router.getLoadingPriority();
      expect(priority.length).toBeGreaterThanOrEqual(5);
      expect(priority[0].tier).toBe("core");
      expect(priority[0].required).toBe(true);
      expect(priority[1].tier).toBe("mode");
      expect(priority[1].required).toBe(true);
    });
  });

  describe("getRoutes", () => {
    it("should return all defined routes", async () => {
      const routes = await router.getRoutes();
      expect(routes.length).toBeGreaterThanOrEqual(3);
      expect(routes.map((r) => r.intent)).toContain("code-review");
      expect(routes.map((r) => r.intent)).toContain("implementation");
      expect(routes.map((r) => r.intent)).toContain("investigation");
    });
  });
});
