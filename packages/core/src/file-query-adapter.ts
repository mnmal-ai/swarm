import { readFile, readdir, stat, access } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { constants } from "node:fs";
import type { SwarmQueryClient, FieldSelection } from "@mnmal-ai/swarm-substrate";

/** Maximum file size (in bytes) the adapter will read. Files larger than this are skipped. */
const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MB

/**
 * Shape of swarm.json as stored on disk.
 */
interface SwarmJson {
  version?: string;
  context_budget?: {
    default_max_tokens?: number;
    model_overrides?: Record<string, number>;
  };
  routes?: Array<{
    intent: string;
    description?: string;
    keywords?: string[];
    load?: Record<string, string[]>;
  }>;
}

/**
 * Maps a directory segment to a swarm content tier string.
 */
const DIR_TO_TIER: Record<string, string> = {
  core: "core",
  modes: "mode",
  capabilities: "capabilities",
  domains: "domain",
  oversight: "oversight",
};

/** Directories to skip when walking for SwarmContent. */
const SKIP_DIRS = new Set(["designs", "node_modules", ".git", "tests", "telemetry", "docs", "meta"]);

/**
 * Infer the tier for a file path relative to the .swarm directory.
 *
 * Examples:
 *   "core/values.md"              → "core"
 *   "modes/code-review.md"        → "mode"
 *   "skills/vetted/drizzle.md"    → "skills_vetted"
 *   "skills/community/foo.md"     → "skills_community"
 *   "skills/core/bar.md"          → "skills_core"
 *   "capabilities/git-workflow.md"→ "capabilities"
 *   "oversight/review-policy.json"→ "oversight"
 *   "domains/my-project/arch.md"  → "domain"
 */
function inferTier(relPath: string): string {
  const parts = relPath.split("/");
  const top = parts[0];

  if (top === "skills" && parts.length >= 2) {
    const sub = parts[1];
    if (sub === "core") return "skills_core";
    if (sub === "vetted") return "skills_vetted";
    if (sub === "community") return "skills_community";
    return "skills_vetted"; // Fallback
  }

  return DIR_TO_TIER[top] ?? top;
}

/**
 * FileQueryAdapter — implements SwarmQueryClient by reading from the
 * .swarm/ directory on disk. This enables swarm to work without a Substrate
 * database or network connection.
 *
 * Supports three query types:
 *   - SwarmRoute   → reads routes from swarm.json
 *   - SwarmConfig  → reads context_budget from swarm.json
 *   - SwarmContent → walks .swarm/ directory for .md and .json files
 *
 * All other type names return an empty array.
 *
 * This implements only the required `query` member of `SwarmQueryClient`. The
 * optional `loadContext` / `persistTaskTelemetry` members (server-side resolvers
 * on a Substrate sidecar) are intentionally NOT implemented: file-only mode has no
 * engine to run them. Consumers feature-detect those methods and fall back to
 * the per-row `query`-driven path, which is exactly what keeps this adapter
 * working without a database.
 */
export class FileQueryAdapter implements SwarmQueryClient {
  readonly #swarmDir: string;
  #swarmJsonCache: SwarmJson | null = null;
  #validated = false;

  constructor(swarmDir: string) {
    // Resolve to absolute path to prevent relative path confusion
    this.#swarmDir = resolve(swarmDir);
  }

  /**
   * Validate that swarmDir exists and contains a swarm.json file.
   * Called once on first query. Throws if the directory is not a valid swarm.
   */
  async #ensureValid(): Promise<void> {
    if (this.#validated) return;
    const swarmJsonPath = join(this.#swarmDir, "swarm.json");
    try {
      await access(swarmJsonPath, constants.R_OK);
    } catch {
      throw new Error(
        `Not a valid swarm directory: ${this.#swarmDir} (swarm.json not found or not readable)`,
      );
    }
    this.#validated = true;
  }

  // ---- SwarmQueryClient implementation ----

  async query<T>(
    typeName: string,
    _params: Record<string, unknown>,
    _fields: FieldSelection,
  ): Promise<T[]> {
    await this.#ensureValid();
    switch (typeName) {
      case "SwarmRoute":
        return this.#queryRoutes() as Promise<T[]>;
      case "SwarmConfig":
        return this.#queryConfigs() as Promise<T[]>;
      case "SwarmContent":
        return this.#queryContent() as Promise<T[]>;
      default:
        return [];
    }
  }

  // ---- Private helpers ----

  async #readSwarmJson(): Promise<SwarmJson> {
    if (this.#swarmJsonCache !== null) {
      return this.#swarmJsonCache;
    }
    const swarmJsonPath = join(this.#swarmDir, "swarm.json");
    const raw = await readFile(swarmJsonPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Basic structural validation
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid swarm.json: expected an object, got ${typeof parsed}`);
    }
    if (parsed.routes !== undefined && !Array.isArray(parsed.routes)) {
      throw new Error(`Invalid swarm.json: "routes" must be an array`);
    }
    if (parsed.context_budget !== undefined && typeof parsed.context_budget !== "object") {
      throw new Error(`Invalid swarm.json: "context_budget" must be an object`);
    }

    this.#swarmJsonCache = parsed as SwarmJson;
    return this.#swarmJsonCache;
  }

  /**
   * Convert swarm.json routes into SwarmRoute entities.
   *
   * keywords and contentPaths are JSON-serialized arrays to match the
   * Substrate entity shape the Router expects.
   * contentPaths is a flat list of all values across all tiers in route.load.
   */
  async #queryRoutes(): Promise<Array<{
    intent: string;
    description: string;
    keywords: string;
    contentPaths: string;
  }>> {
    const swarm = await this.#readSwarmJson();
    const routes = swarm.routes ?? [];

    return routes.map((route) => {
      const keywords = route.keywords ?? [];

      // Flatten all content paths from all tiers in route.load
      const allPaths: string[] = [];
      if (route.load) {
        for (const paths of Object.values(route.load)) {
          if (Array.isArray(paths)) {
            allPaths.push(...paths);
          }
        }
      }

      return {
        intent: route.intent,
        description: route.description ?? "",
        keywords: JSON.stringify(keywords),
        contentPaths: JSON.stringify(allPaths),
      };
    });
  }

  /**
   * Convert swarm.json context_budget into SwarmConfig entities.
   *
   * Shape:
   *   { key: "default_max_tokens", value: "15000", category: "budget" }
   *   { key: "model_override:claude-opus-4-6", value: "20000", category: "budget" }
   */
  async #queryConfigs(): Promise<Array<{
    key: string;
    value: string;
    category: string;
  }>> {
    const swarm = await this.#readSwarmJson();
    const budget = swarm.context_budget;
    if (!budget) return [];

    const entries: Array<{ key: string; value: string; category: string }> = [];

    if (budget.default_max_tokens !== undefined) {
      entries.push({
        key: "default_max_tokens",
        value: String(budget.default_max_tokens),
        category: "budget",
      });
    }

    if (budget.model_overrides) {
      for (const [model, tokens] of Object.entries(budget.model_overrides)) {
        entries.push({
          key: `model_override:${model}`,
          value: String(tokens),
          category: "budget",
        });
      }
    }

    return entries;
  }

  /**
   * Walk the .swarm/ directory recursively and return one SwarmContent
   * entity per .md or .json file (excluding swarm.json itself).
   */
  async #queryContent(): Promise<Array<{
    path: string;
    tier: string;
    intent: string;
    content: string;
    tokenEstimate: number;
    lastReviewed: string;
    projectId: string;
  }>> {
    const results: Array<{
      path: string;
      tier: string;
      intent: string;
      content: string;
      tokenEstimate: number;
      lastReviewed: string;
      projectId: string;
    }> = [];

    await this.#walk(this.#swarmDir, results);
    return results;
  }

  async #walk(
    dir: string,
    results: Array<{
      path: string;
      tier: string;
      intent: string;
      content: string;
      tokenEstimate: number;
      lastReviewed: string;
      projectId: string;
    }>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      const relDir = relative(this.#swarmDir, dir) || ".";
      console.warn(`[swarm] Could not read directory: ${relDir}`);
      return;
    }

    for (const entry of entries) {
      // Skip hidden files/dirs
      if (entry.startsWith(".")) continue;

      const fullPath = join(dir, entry);
      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }

      if (fileStat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        await this.#walk(fullPath, results);
      } else if (fileStat.isFile()) {
        const ext = extname(entry);
        if (ext !== ".md" && ext !== ".json") continue;

        // Compute relative path from swarmDir (use forward slashes)
        const relPath = relative(this.#swarmDir, fullPath).replace(/\\/g, "/");

        // Skip swarm.json itself
        if (relPath === "swarm.json") continue;

        // Skip files larger than the safety limit
        if (fileStat.size > MAX_FILE_SIZE_BYTES) {
          console.warn(`[swarm] Skipping oversized file (${(fileStat.size / 1024).toFixed(0)} KB): ${relPath}`);
          continue;
        }

        let content: string;
        try {
          content = await readFile(fullPath, "utf-8");
        } catch {
          console.warn(`[swarm] Could not read file: ${relPath}`);
          continue;
        }

        const tier = inferTier(relPath);
        const tokenEstimate = Math.ceil(content.length / 4);

        results.push({
          path: relPath,
          tier,
          intent: "",
          content,
          tokenEstimate,
          lastReviewed: "",
          projectId: "",
        });
      }
    }
  }
}
