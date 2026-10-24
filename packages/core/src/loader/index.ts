import type {
  SwarmQueryClient,
  LoadContextFile,
} from "@mnmal-ai/swarm-substrate";
import { selectProjectContent } from "@mnmal-ai/swarm-substrate";
import type {
  Route,
  ContextTier,
  LoadedFile,
  LoadResult,
  LoadingPriorityEntry,
  OmittedFile,
} from "@mnmal-ai/swarm-types";

/**
 * Shape of a SwarmContent entity returned from Substrate.
 * `intent` may be empty (loads on all intents) or comma-separated
 * (e.g. "implementation,code-review").
 */
interface SubstrateSwarmContent {
  path: string;
  tier: string;
  intent: string;
  content: string;
  tokenEstimate: number;
  lastReviewed: string;
  projectId: string;
  sourceUrl?: string;
  fetchedAt?: string;
  skillName?: string;
}

export class Loader {
  private client: SwarmQueryClient;

  constructor(client: SwarmQueryClient) {
    this.client = client;
  }

  /**
   * Load swarm files for a route, respecting the context budget.
   *
   * Two paths, same observable result:
   *
   *   - **Server-side** (preferred): when the injected client exposes the
   *     `loadContext` resolver (a Substrate sidecar with the swarm coordinator
   *     plugin) AND a `modelId` is supplied, route lookup + budget-aware
   *     assembly run in one resolver round trip instead of querying every
   *     SwarmContent row and assembling client-side. The resolver's blob is
   *     byte-equal to `assembleContext()` by contract, so the returned
   *     LoadResult is indistinguishable from the per-tier path.
   *
   *   - **Per-tier** (fallback): when `loadContext` is absent (FileQueryAdapter
   *     / file-only mode, or any mock transport) or no `modelId` is available,
   *     query all SwarmContent entities, match client-side against the route's
   *     content paths, and enforce the budget by tier priority. Unchanged.
   *
   * Remote URLs (https://) in route paths are now stored as SwarmContent
   * entities in Substrate with sourceUrl populated. The Loader matches them
   * by their stored path, not by URL.
   */
  async load(
    route: Route,
    budget: number,
    priority: LoadingPriorityEntry[],
    projectId?: string,
    modelId?: string,
  ): Promise<LoadResult> {
    // Prefer server-side assembly when the transport can do it. `loadContext`
    // needs `modelId` to resolve the budget server-side; without one we cannot
    // form a valid request, so we fall through. `loadViaServer` also returns
    // null if its reconstructed files don't reassemble byte-for-byte into the
    // server blob — a defensive guard that keeps the two paths interchangeable.
    if (typeof this.client.loadContext === "function" && modelId) {
      const serverResult = await this.loadViaServer(route, projectId, modelId);
      if (serverResult) {
        return serverResult;
      }
      // Guard failed (no route matched, or blob couldn't be reconstructed).
      // Fall through to the per-tier path for an authoritative result.
    }

    return this.loadViaQuery(route, budget, priority, projectId);
  }

  /**
   * The files at `paths` for this project, whatever the route or the budget:
   * for content a role must always see in full, such as the project's binding
   * rules. Paths with no content are skipped; the order of `paths` is kept.
   */
  async loadByPaths(paths: string[], projectId?: string): Promise<LoadedFile[]> {
    if (paths.length === 0) return [];
    // Only the rows at these paths: `path` is indexed, so the sidecar filters.
    // A transport that ignores params (file-only mode) returns every row, and
    // the match below still keeps just these paths.
    const queried = await this.client.query<SubstrateSwarmContent>(
      "SwarmContent",
      { where: { path: { in: [...new Set(paths)] } } },
      { path: true, tier: true, intent: true, content: true, tokenEstimate: true, lastReviewed: true, projectId: true },
    );
    const entities = selectProjectContent(queried, projectId);
    const files: LoadedFile[] = [];
    for (const path of paths) {
      const entity = entities.find((e) => e.path === path);
      if (!entity || !entity.content?.trim()) continue;
      files.push({
        path: entity.path,
        tier: entity.tier as ContextTier,
        content: entity.content,
        estimatedTokens: entity.tokenEstimate ?? Math.ceil(entity.content.length / 4),
      });
    }
    return files;
  }

  /**
   * Server-side load via the `loadContext` resolver. Returns a LoadResult whose
   * files were assembled by the sidecar, or null when the caller should fall
   * back to the per-tier path (no route matched server-side, or the assembled
   * blob could not be split back into per-file content byte-equally).
   */
  private async loadViaServer(
    route: Route,
    projectId: string | undefined,
    modelId: string,
  ): Promise<LoadResult | null> {
    // Non-null assertion is safe: the caller only enters here after a
    // `typeof this.client.loadContext === "function"` check.
    const response = await this.client.loadContext!({
      intent: route.intent,
      projectId: projectId ?? "",
      modelId,
    });

    // No SwarmRoute matched the intent server-side. The per-tier path still has
    // a concrete route object to work with, so defer to it.
    if (!response.routeMatched) {
      return null;
    }

    const files = this.reconstructFiles(
      response.content,
      response.filesIncluded,
    );
    if (!files) {
      return null;
    }

    // Byte-equality guard: the reconstructed per-file content must reassemble
    // into exactly the server blob. If it doesn't, we don't trust the split —
    // fall back rather than emit a context that diverges from the resolver's.
    if (this.assembleContext(files) !== response.content) {
      return null;
    }

    const totalTokens = response.tokensUsed;
    const budgetMax = response.budgetTokens;
    return {
      files,
      totalTokens,
      budgetMax,
      budgetUsedPercent: budgetMax > 0 ? (totalTokens / budgetMax) * 100 : 0,
      // The resolver reports what the budget left out (and unseeded remote
      // URLs) rather than dropping it silently; forward both. Older sidecars
      // omit `omitted`.
      truncated: response.truncated ?? [],
      omitted: (response.omitted ?? []).map((f) => ({
        path: f.path,
        tier: f.tier as ContextTier,
        estimatedTokens: f.tokens,
      })),
    };
  }

  /**
   * Split the server's assembled blob back into per-file `LoadedFile`s using the
   * `filesIncluded` manifest. The blob is `assembleContext()`'s output:
   * `--- swarm: <path> (<tier>) ---\n<content>` blocks joined by `\n\n`. We
   * anchor on each known delimiter in manifest order; the `assembleContext`
   * round-trip check in `loadViaServer` catches any reconstruction that drifts.
   *
   * Returns null if a delimiter can't be located (signals "fall back").
   */
  private reconstructFiles(
    content: string,
    filesIncluded: LoadContextFile[],
  ): LoadedFile[] | null {
    if (filesIncluded.length === 0) {
      // An empty manifest must correspond to an empty blob.
      return content === "" ? [] : null;
    }

    const delimiters = filesIncluded.map(
      (f) => `--- swarm: ${f.path} (${f.tier}) ---\n`,
    );
    const files: LoadedFile[] = [];
    let cursor = 0;

    for (let i = 0; i < filesIncluded.length; i++) {
      const start = content.indexOf(delimiters[i], cursor);
      if (start === -1) {
        return null;
      }
      const contentStart = start + delimiters[i].length;

      let contentEnd: number;
      if (i + 1 < filesIncluded.length) {
        const nextStart = content.indexOf(delimiters[i + 1], contentStart);
        if (nextStart === -1) {
          return null;
        }
        // Strip the `\n\n` block separator that precedes the next delimiter.
        contentEnd = nextStart - 2;
        cursor = nextStart;
      } else {
        contentEnd = content.length;
      }
      if (contentEnd < contentStart) {
        return null;
      }

      files.push({
        path: filesIncluded[i].path,
        tier: filesIncluded[i].tier as ContextTier,
        content: content.slice(contentStart, contentEnd),
        estimatedTokens: filesIncluded[i].tokens,
      });
    }

    return files;
  }

  /**
   * Per-tier load: query all SwarmContent entities, match client-side against
   * the route's content paths, and enforce the budget by tier priority. This is
   * the original `load()` body — the fallback when `loadContext` is unavailable.
   */
  private async loadViaQuery(
    route: Route,
    budget: number,
    priority: LoadingPriorityEntry[],
    projectId?: string,
  ): Promise<LoadResult> {
    // 1. Collect all content paths from the route (flatten Record<string, string[]>)
    const allRoutePaths = this.collectRoutePaths(route, projectId);

    // 2. Separate local paths from remote URLs
    const localPaths: string[] = [];
    const _remoteUrls: string[] = [];
    for (const p of allRoutePaths) {
      if (p.startsWith("https://")) {
        _remoteUrls.push(p);
      } else {
        localPaths.push(p);
      }
    }
    // Remote URLs are now stored as SwarmContent entities in Substrate.
    // Any raw URLs that slip through here are silently ignored.

    // 3. Query ALL SwarmContent entities from Substrate, then keep the ones this
    //    project reads: its own row at a path, else the legacy one; never
    //    another project's.
    const queriedEntities = await this.client.query<SubstrateSwarmContent>(
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
    const allEntities = selectProjectContent(queriedEntities, projectId);

    // 4. Match entities against the route's local paths
    const matchedEntities = this.matchEntities(allEntities, localPaths);

    // 5. Filter skill entities by intent
    const filteredEntities = this.filterByIntent(matchedEntities, route.intent);

    // 6. Group matched entities by tier
    const entitiesByTier = new Map<string, SubstrateSwarmContent[]>();
    for (const entity of filteredEntities) {
      const existing = entitiesByTier.get(entity.tier) ?? [];
      existing.push(entity);
      entitiesByTier.set(entity.tier, existing);
    }

    // 7. Apply budget enforcement in priority order
    const files: LoadedFile[] = [];
    const truncated: string[] = [];
    const omitted: OmittedFile[] = [];
    let totalTokens = 0;

    for (const entry of priority) {
      const tier = entry.tier;
      const tierEntities = entitiesByTier.get(tier) ?? [];

      // Sort entities within a tier by path for deterministic order
      tierEntities.sort((a, b) => a.path.localeCompare(b.path));

      for (const entity of tierEntities) {
        const tokens = typeof entity.tokenEstimate === "string"
          ? Number(entity.tokenEstimate)
          : entity.tokenEstimate;

        // Required tiers always load regardless of budget
        if (entry.required) {
          files.push({
            path: entity.path,
            tier: entity.tier as ContextTier,
            content: entity.content,
            estimatedTokens: tokens,
          });
          totalTokens += tokens;
          continue;
        }

        // Optional tiers respect the budget
        if (totalTokens + tokens <= budget) {
          files.push({
            path: entity.path,
            tier: entity.tier as ContextTier,
            content: entity.content,
            estimatedTokens: tokens,
          });
          totalTokens += tokens;
        } else {
          truncated.push(entity.path);
          omitted.push({ path: entity.path, tier: entity.tier as ContextTier, estimatedTokens: tokens });
        }
      }
    }

    return {
      files,
      totalTokens,
      budgetMax: budget,
      budgetUsedPercent: budget > 0 ? (totalTokens / budget) * 100 : 0,
      truncated,
      omitted,
    };
  }

  /**
   * Assemble loaded files into a single context string for the model.
   */
  assembleContext(files: LoadedFile[]): string {
    return files
      .map(
        (f) =>
          `--- swarm: ${f.path} (${f.tier}) ---\n${f.content}`,
      )
      .join("\n\n");
  }

  /**
   * Collect all content paths from a route's load config.
   * Flattens Record<string, string[]> into a single array.
   * Replaces {project} placeholder if projectId is provided.
   */
  private collectRoutePaths(route: Route, projectId?: string): string[] {
    const paths: string[] = [];
    for (const entries of Object.values(route.load)) {
      if (Array.isArray(entries)) {
        paths.push(...entries);
      }
    }

    if (projectId) {
      return paths.map((p) => p.replace("{project}", projectId));
    }
    return paths;
  }

  /**
   * Match SwarmContent entities against the route's content paths.
   *
   * Exact paths match by equality. Glob patterns (containing `*` but not `**`)
   * match by prefix + extension. `**` patterns are silently skipped.
   */
  private matchEntities(
    entities: SubstrateSwarmContent[],
    paths: string[],
  ): SubstrateSwarmContent[] {
    const matched: SubstrateSwarmContent[] = [];
    const seen = new Set<string>();

    for (const routePath of paths) {
      // Skip ** recursive patterns
      if (routePath.includes("**")) {
        continue;
      }

      if (!routePath.includes("*")) {
        // Exact path match
        for (const entity of entities) {
          if (entity.path === routePath && !seen.has(entity.path)) {
            matched.push(entity);
            seen.add(entity.path);
          }
        }
      } else {
        // Glob pattern: convert to prefix + extension match
        // e.g., "skills/vetted/*.md" → prefix="skills/vetted/", ext=".md"
        const dir = routePath.substring(0, routePath.lastIndexOf("/") + 1);
        const pattern = routePath.substring(routePath.lastIndexOf("/") + 1);

        // Build regex from pattern: escape everything, then replace \* with [^/]*
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp("^" + escaped.replace(/\\\*/g, "[^/]*") + "$");

        for (const entity of entities) {
          if (
            entity.path.startsWith(dir) &&
            !seen.has(entity.path)
          ) {
            // Extract filename from entity path
            const filename = entity.path.substring(dir.length);
            // Only match direct children (no nested paths)
            if (!filename.includes("/") && regex.test(filename)) {
              matched.push(entity);
              seen.add(entity.path);
            }
          }
        }
      }
    }

    return matched;
  }

  /**
   * Filter skill entities by intent.
   *
   * Skill tiers (skills_vetted, skills_community) are filtered by intent:
   * - Empty intent, or "all", = loads on all intents (universal skill)
   * - Comma-separated intents = loads only if route intent is in the list
   *
   * Non-skill tiers pass through unfiltered.
   */
  private filterByIntent(
    entities: SubstrateSwarmContent[],
    routeIntent: string,
  ): SubstrateSwarmContent[] {
    return entities.filter((entity) => {
      // Only filter skill tiers
      if (entity.tier !== "skills_vetted" && entity.tier !== "skills_community") {
        return true;
      }

      // Empty intent means "loads on all intents"
      if (!entity.intent || entity.intent.trim() === "") {
        return true;
      }

      // Check if the route intent is in the entity's comma-separated intent list.
      // "all" is what swarm sync and swarm add skill write for a universal skill.
      const intents = entity.intent.split(",").map((s) => s.trim()).filter(Boolean);
      return intents.includes("all") || intents.includes(routeIntent);
    });
  }
}
