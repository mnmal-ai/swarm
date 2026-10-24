import type {
  SwarmQueryClient,
  ClassifyIntentRequest,
  ClassifyIntentResponse,
} from "@mnmal-ai/swarm-substrate";
import { coerceSimilarityThreshold } from "@mnmal-ai/swarm-substrate";
import type {
  ClassificationResult,
  Route,
  LoadingPriorityEntry,
  ContextTier,
  RecallConfig,
} from "@mnmal-ai/swarm-types";

/**
 * Shape of a SwarmRoute entity returned from Substrate.
 * `keywords` and `contentPaths` are JSON-serialized arrays.
 */
interface SubstrateSwarmRoute {
  intent: string;
  description: string;
  keywords: string;
  contentPaths: string;
}

/**
 * Shape of a SwarmConfig entity returned from Substrate.
 */
interface SubstrateSwarmConfig {
  key: string;
  value: string;
  category: string;
}

/**
 * Structural shape of the optional server-side classifier.
 *
 * `SubstrateClient` implements `classifyIntent`; `FileQueryAdapter` (file-only mode)
 * does not. It is NOT declared on `SwarmQueryClient` — Router feature-detects it
 * on the injected client and falls back to the local keyword-scoring path when
 * absent. Declared locally (rather than widening the shared interface) to keep
 * this change scoped to the router. `intentOverride` rides on top of the
 * canonical `ClassifyIntentRequest` to preserve `Router.classify`'s legacy
 * contract — it is the resolver's only path to `confidence: "exact"`.
 */
type ClassifyIntentCapable = {
  classifyIntent(
    args: ClassifyIntentRequest & { intentOverride?: string },
  ): Promise<ClassifyIntentResponse>;
};

/**
 * The synthetic fallback route. It is not a stored `SwarmRoute`, so it lives
 * here and is shared by both classify paths (server-delegated and local) so they
 * return an identical result when no route matches.
 */
export const FALLBACK_ROUTE: Route = {
  intent: "fallback",
  description:
    "When no intent matches, load core only and ask for clarification.",
  load: { core: ["core/values.md", "core/rules.md", "core/voice.md"] },
  keywords: [],
};

/**
 * The `SwarmConfig.category` the recall tuning knobs live under — sibling to the
 * `"budget"` category. Kept as a literal here (mirroring the budget filter
 * below) rather than imported from the substrate package, to keep the budget/recall
 * surfacing pattern symmetric and self-contained in this file.
 */
const RECALL_CONFIG_CATEGORY = "recall";

/** `SwarmConfig.key` holding the cosine-similarity cutoff (0..1) forwarded to
 *  the recall substrate as `RecallConfig.similarityThreshold`. */
const RECALL_SIMILARITY_THRESHOLD_KEY = "recall_similarity_threshold";

/** `SwarmConfig.key` holding the max nearest-neighbor hits per recall, forwarded
 *  as `RecallConfig.topK`. */
const RECALL_TOP_K_KEY = "recall_top_k";

export class Router {
  private routes: Route[] | null = null;
  private budgetConfigs: SubstrateSwarmConfig[] | null = null;
  private recallConfigs: SubstrateSwarmConfig[] | null = null;
  private client: SwarmQueryClient;
  private projectId: string;

  /**
   * @param projectId The project whose routes and content rows classification
   *   reads when a `classify` call names none. Empty (the default) means no
   *   project is known: every row passes through, as for the Loader and the
   *   resolvers' own `projectId ?? ""`.
   */
  constructor(client: SwarmQueryClient, projectId = "") {
    this.client = client;
    this.projectId = projectId;
  }

  /**
   * Load routes, budget config, and recall config from Substrate.
   * Call this once at initialization; the data is cached.
   */
  async load(): Promise<{
    routes: Route[];
    budgetConfigs: SubstrateSwarmConfig[];
    recallConfigs: SubstrateSwarmConfig[];
  }> {
    if (this.routes && this.budgetConfigs && this.recallConfigs) {
      return {
        routes: this.routes,
        budgetConfigs: this.budgetConfigs,
        recallConfigs: this.recallConfigs,
      };
    }

    // Query all SwarmRoute entities
    const routeRows = await this.client.query<SubstrateSwarmRoute>(
      "SwarmRoute",
      {},
      { intent: true, description: true, keywords: true, contentPaths: true },
    );

    // Convert Substrate entities to Route objects
    this.routes = routeRows.map((hr) => ({
      intent: hr.intent,
      description: hr.description,
      keywords: JSON.parse(hr.keywords) as string[],
      load: { all: JSON.parse(hr.contentPaths) as string[] },
    }));

    // Query all SwarmConfig entities in the "budget" category
    const configs = await this.client.query<SubstrateSwarmConfig>(
      "SwarmConfig",
      {},
      { key: true, value: true, category: true },
    );

    // Keep only budget-related configs
    this.budgetConfigs = configs.filter((c) => c.category === "budget");

    // Surface recall tuning knobs the same way — a sibling category off the same
    // single SwarmConfig query. Substrate recall reads its own copy
    // at boot; this exposes the values to core callers via getRecallConfig().
    this.recallConfigs = configs.filter(
      (c) => c.category === RECALL_CONFIG_CATEGORY,
    );

    return {
      routes: this.routes,
      budgetConfigs: this.budgetConfigs,
      recallConfigs: this.recallConfigs,
    };
  }

  /**
   * Classify a task string against the cached routes.
   *
   * Strategy:
   * - When the injected client exposes `classifyIntent` (a Substrate-backed
   *   transport), delegate scoring server-side and map its
   *   `{intent, confidence, matchedKeywords}` into a `ClassificationResult`,
   *   resolving `route.load` locally from the cached routes (the load manifest
   *   never crosses the wire).
   * - Otherwise (file-only mode), run the local keyword scorer:
   *   1. Check for an exact intent match if intentOverride is provided.
   *   2. Score each route by counting keyword matches in the task string.
   *   3. Return the highest-scoring route, or fallback if no keywords match.
   *
   * Both paths share identical tie-breaking (strictly-greater comparison →
   * first matching route wins), intentOverride semantics (a named, existing
   * intent yields `exact`; otherwise it falls through to scoring), and the same
   * synthetic fallback route.
   *
   * `projectId` scopes the server-side classifier to that project's routes and
   * recall rows (its own, else the legacy ones); without it the router's
   * constructor project applies. The local keyword path is unscoped.
   */
  async classify(
    task: string,
    intentOverride?: string,
    projectId?: string,
  ): Promise<ClassificationResult> {
    const { routes } = await this.load();

    // Prefer the server-side classifier when the client provides it. The
    // resolver returns intent + confidence + matchedKeywords only; we resolve
    // the route (and its `load`) from the locally cached routes.
    const classifier = this.client as Partial<ClassifyIntentCapable>;
    if (typeof classifier.classifyIntent === "function") {
      const result = await classifier.classifyIntent({
        prompt: task,
        projectId: projectId ?? this.projectId,
        intentOverride,
      });
      return {
        intent: result.intent,
        // A non-fallback intent always names a cached route (the resolver reads
        // the same SwarmRoute set). Coalesce to the synthetic fallback route
        // for the `fallback` intent — and defensively if a route is missing.
        route:
          routes.find((r) => r.intent === result.intent) ?? FALLBACK_ROUTE,
        confidence: result.confidence,
        matchedKeywords: result.matchedKeywords,
      };
    }

    // --- Local keyword-scoring path (file-only mode) ---
    const taskLower = task.toLowerCase();

    // Direct override -- skip classification
    if (intentOverride) {
      const route = routes.find((r) => r.intent === intentOverride);
      if (route) {
        return {
          intent: route.intent,
          route,
          confidence: "exact",
          matchedKeywords: [],
        };
      }
    }

    // Score routes by keyword matches
    let bestRoute: Route | null = null;
    let bestScore = 0;
    let bestKeywords: string[] = [];

    for (const route of routes) {
      const matched: string[] = [];
      for (const keyword of route.keywords) {
        if (taskLower.includes(keyword.toLowerCase())) {
          matched.push(keyword);
        }
      }
      if (matched.length > bestScore) {
        bestScore = matched.length;
        bestRoute = route;
        bestKeywords = matched;
      }
    }

    if (bestRoute && bestScore > 0) {
      return {
        intent: bestRoute.intent,
        route: bestRoute,
        confidence: "keyword",
        matchedKeywords: bestKeywords,
      };
    }

    // Fallback -- no keywords matched
    return {
      intent: "fallback",
      route: FALLBACK_ROUTE,
      confidence: "fallback",
      matchedKeywords: [],
    };
  }

  /**
   * Get the context token budget for a specific model.
   */
  async getBudget(modelId: string): Promise<number> {
    const { budgetConfigs } = await this.load();

    // Look for a model-specific override
    const overrideKey = `model_override:${modelId}`;
    const override = budgetConfigs.find((c) => c.key === overrideKey);
    if (override) {
      return Number(override.value);
    }

    // Fall back to default
    const defaultConfig = budgetConfigs.find(
      (c) => c.key === "default_max_tokens",
    );
    if (defaultConfig) {
      return Number(defaultConfig.value);
    }

    // Hardcoded safety net if no config found
    return 15000;
  }

  /**
   * Get the recall tuning config surfaced from the `recall`-category
   * SwarmConfig rows. Mirrors `getBudget`'s query/parse/expose pattern.
   *
   * Returns the canonical `RecallConfig` shape (`similarityThreshold` / `topK`).
   * Both fields default to unset: when no row exists, the field is omitted so
   * the recall layer keeps its built-in defaults (no similarity filtering,
   * RECALL_TOP_K hits) — byte-identical behavior until a tuning task sets a
   * value. A row whose value is non-finite degrades to the default rather than
   * poisoning recall with a NaN.
   */
  async getRecallConfig(): Promise<RecallConfig> {
    const { recallConfigs } = await this.load();

    const config: RecallConfig = {};

    const threshold = recallConfigs.find(
      (c) => c.key === RECALL_SIMILARITY_THRESHOLD_KEY,
    );
    if (threshold) {
      // Single source of truth for coercion + range clamping. Default 0 =
      // no cutoff, matching the substrate's seeded default and knnSearch's
      // `threshold` default — no behaviour change for valid in-range values.
      // Out-of-range values are clamped + logged by coerceSimilarityThreshold
      // rather than silently passing through.
      config.similarityThreshold = coerceSimilarityThreshold(threshold.value);
    }

    const topK = recallConfigs.find((c) => c.key === RECALL_TOP_K_KEY);
    if (topK) {
      const parsed = Number(topK.value);
      if (Number.isFinite(parsed)) {
        config.topK = parsed;
      }
    }

    return config;
  }

  /**
   * Get the loading priority order.
   * This is structural and rarely changes, so it is hardcoded
   * rather than stored as a Substrate entity.
   */
  async getLoadingPriority(): Promise<LoadingPriorityEntry[]> {
    return [
      { tier: "core" as ContextTier, required: true },
      { tier: "mode" as ContextTier, required: true },
      { tier: "oversight" as ContextTier, required: true },
      { tier: "capabilities" as ContextTier, required: false },
      { tier: "domain" as ContextTier, required: false },
      { tier: "skills_vetted" as ContextTier, required: false },
      { tier: "skills_community" as ContextTier, required: false },
    ];
  }

  /**
   * Get all defined routes (useful for structural tests).
   */
  async getRoutes(): Promise<Route[]> {
    const { routes } = await this.load();
    return routes;
  }
}
