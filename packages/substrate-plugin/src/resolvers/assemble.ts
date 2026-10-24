/**
 * Budget-aware content assembly — ported from `packages/core/src/loader/index.ts`.
 *
 * This is a deliberate duplication, NOT an import: the Substrate plugin is
 * bundled into a sidecar runtime where core is not installed. The
 * `loadContext` resolver reads `SwarmRoute` / `SwarmContent` / `SwarmConfig`
 * rows server-side and runs them through these pure functions.
 *
 * Every function below mirrors the corresponding `Loader` method byte-for-byte:
 * the assembled output MUST equal what the legacy client-side loader produces.
 * Pure data shaping only — zero LLM calls, zero I/O.
 */

import type {
  SwarmContentEntity,
  ContextTier,
  LoadContextFile,
  LoadedFile,
  LoadResult,
  LoadingPriorityEntry,
  OmittedFile,
  RouteLike,
} from "@mnmal-ai/swarm-substrate-shared";

/**
 * Collect all content paths from a route's load config. Flattens
 * `Record<string, string[]>` into a single array. Replaces the `{project}`
 * placeholder when a projectId is provided.
 *
 * Ported verbatim from `Loader.collectRoutePaths`.
 */
export function collectRoutePaths(
  route: Pick<RouteLike, "load">,
  projectId?: string,
): string[] {
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
 * Match `SwarmContent` entities against the route's content paths.
 *
 * Exact paths match by equality. Glob patterns (containing `*` but not `**`)
 * match by directory prefix + a single-segment filename regex. `**` patterns
 * are silently skipped. First-match-wins dedup via the `seen` set.
 *
 * Ported verbatim from `Loader.matchEntities`.
 */
export function matchEntities(
  entities: SwarmContentEntity[],
  paths: string[],
): SwarmContentEntity[] {
  const matched: SwarmContentEntity[] = [];
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
        if (entity.path.startsWith(dir) && !seen.has(entity.path)) {
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
 * Skill tiers (`skills_vetted`, `skills_community`) are filtered by intent:
 *   - Empty intent, or "all", = loads on all intents (universal skill).
 *   - Comma-separated intents = loads only if the route intent is in the list.
 * Non-skill tiers pass through unfiltered.
 *
 * Ported verbatim from `Loader.filterByIntent`.
 */
export function filterByIntent(
  entities: SwarmContentEntity[],
  routeIntent: string,
): SwarmContentEntity[] {
  return entities.filter((entity) => {
    // Only filter skill tiers
    if (entity.tier !== "skills_vetted" && entity.tier !== "skills_community") {
      return true;
    }

    // Empty intent means "loads on all intents"
    if (!entity.intent || entity.intent.trim() === "") {
      return true;
    }

    // Check if the route intent is in the entity's comma-separated intent list
    const intents = entity.intent
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // "all" is what swarm sync and swarm add skill write for a universal skill.
    return intents.includes("all") || intents.includes(routeIntent);
  });
}

/**
 * Apply budget enforcement in tier-priority order.
 *
 * Groups the (already path-matched, intent-filtered) entities by tier, then
 * walks `priority` in order. Within a tier, entities are sorted by `path`
 * (`localeCompare`) for deterministic output. Required tiers always load;
 * optional tiers load only while they fit under `budget`, otherwise their path
 * is recorded in `truncated`.
 *
 * Ported verbatim from steps 6–7 of `Loader.load`.
 */
export function enforceBudget(
  entities: SwarmContentEntity[],
  budget: number,
  priority: LoadingPriorityEntry[],
): LoadResult {
  // Group matched entities by tier
  const entitiesByTier = new Map<string, SwarmContentEntity[]>();
  for (const entity of entities) {
    const existing = entitiesByTier.get(entity.tier) ?? [];
    existing.push(entity);
    entitiesByTier.set(entity.tier, existing);
  }

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
      const tokens =
        typeof entity.tokenEstimate === "string"
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

/** One stored section of a swarm file, as the section-level budget fill uses it. */
export interface SectionUnit {
  path: string;
  ordinal: number;
  /** Heading texts from level 2 down; empty for the text before the first heading. */
  headingPath: string[];
  body: string;
  tokens: number;
  synopsis: string;
  /** sha256 of `body`, as stored. */
  contentHash: string;
}

/** How a left-out section is named in the context record: `path › Heading › Sub`. */
export function sectionLabel(unit: Pick<SectionUnit, "path" | "headingPath">): string {
  return `${unit.path} › ${unit.headingPath.length > 0 ? unit.headingPath.join(" › ") : "(start)"}`;
}

/**
 * `enforceBudget`, but at section granularity for files that have stored
 * sections (stage 1 of the context-sections spec).
 *
 * Same walk: tiers in priority order, files by path within a tier. Required
 * tiers load every section. An optional file's sections load in ordinal order
 * while each fits; a section that doesn't fit is left out and the walk goes
 * on, so a later, smaller one can still load. A file that loads in part is
 * included with the sections that fit, joined by "\n"; one with none loaded is
 * reported in `truncated`, as a whole file is today. Each left-out section is
 * reported in `omitted` as `path › Heading`. Files with no stored sections are
 * handled exactly as `enforceBudget` handles them. `loadedOrdinals` names,
 * for each sectioned file the walk reached, the ordinals that loaded.
 */
export function enforceBudgetBySection(
  entities: SwarmContentEntity[],
  budget: number,
  priority: LoadingPriorityEntry[],
  sectionsByPath: ReadonlyMap<string, SectionUnit[]>,
): LoadResult & { omitted: OmittedFile[]; loadedOrdinals: Map<string, Set<number>> } {
  const entitiesByTier = new Map<string, SwarmContentEntity[]>();
  for (const entity of entities) {
    const existing = entitiesByTier.get(entity.tier) ?? [];
    existing.push(entity);
    entitiesByTier.set(entity.tier, existing);
  }

  const files: LoadedFile[] = [];
  const truncated: string[] = [];
  const omitted: OmittedFile[] = [];
  const loadedOrdinals = new Map<string, Set<number>>();
  let totalTokens = 0;

  for (const entry of priority) {
    const tierEntities = [...(entitiesByTier.get(entry.tier) ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    for (const entity of tierEntities) {
      const tier = entity.tier as ContextTier;
      const sections = [...(sectionsByPath.get(entity.path) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      if (sections.length === 0) {
        const tokens = typeof entity.tokenEstimate === "string" ? Number(entity.tokenEstimate) : entity.tokenEstimate;
        if (entry.required || totalTokens + tokens <= budget) {
          files.push({ path: entity.path, tier, content: entity.content, estimatedTokens: tokens });
          totalTokens += tokens;
        } else {
          truncated.push(entity.path);
          omitted.push({ path: entity.path, tier, estimatedTokens: tokens });
        }
        continue;
      }

      const loaded: SectionUnit[] = [];
      for (const s of sections) {
        if (entry.required || totalTokens + s.tokens <= budget) {
          loaded.push(s);
          totalTokens += s.tokens;
        } else {
          omitted.push({ path: sectionLabel(s), tier, estimatedTokens: s.tokens });
        }
      }
      loadedOrdinals.set(entity.path, new Set(loaded.map((s) => s.ordinal)));
      if (loaded.length === 0) {
        truncated.push(entity.path);
        continue;
      }
      files.push({
        path: entity.path,
        tier,
        content: loaded.map((s) => s.body).join("\n"),
        estimatedTokens: loaded.reduce((sum, s) => sum + s.tokens, 0),
      });
    }
  }

  return {
    files,
    totalTokens,
    budgetMax: budget,
    budgetUsedPercent: budget > 0 ? (totalTokens / budget) * 100 : 0,
    truncated,
    omitted,
    loadedOrdinals,
  };
}

/**
 * Assemble loaded files into a single context string for the model.
 *
 * The `--- swarm: <path> (<tier>) ---` delimiter format and the `\n\n` join are
 * the load-bearing contract: clients parse it back into files. Ported verbatim
 * from `Loader.assembleContext` — must stay byte-equal.
 */
export function assembleContext(files: LoadedFile[]): string {
  return files
    .map((f) => `--- swarm: ${f.path} (${f.tier}) ---\n${f.content}`)
    .join("\n\n");
}

/**
 * Full route → context pipeline. Mirrors `Loader.load` followed by
 * `Loader.assembleContext`, returning the data the `loadContext` resolver needs
 * (minus `routeMatched`, which the resolver fills from the `SwarmRoute` row).
 *
 * Steps, in order, matching the legacy loader:
 *   1. Collect + `{project}`-substitute route paths.
 *   2. Drop remote (`https://`) URLs — those are stored as their own entities
 *      and matched by stored path, never by raw URL.
 *   3. Path-match entities (exact + single-`*` glob, dedup).
 *   4. Intent-filter skill tiers.
 *   5. Tier-priority budget enforcement.
 *   6. Delimiter-join into the assembled blob.
 */
export function assembleRouteContext(input: {
  route: RouteLike;
  entities: SwarmContentEntity[];
  budget: number;
  priority: LoadingPriorityEntry[];
  projectId?: string;
  /** Stored sections by file path. When given, the budget is filled section by section. */
  sectionsByPath?: ReadonlyMap<string, SectionUnit[]>;
}): {
  content: string;
  filesIncluded: LoadContextFile[];
  tokensUsed: number;
  budgetTokens: number;
  truncated: string[];
  omitted: LoadContextFile[];
  /** By file path, the section ordinals that loaded; only when sections were given. */
  loadedSections?: Map<string, Set<number>>;
} {
  const { route, entities, budget, priority, projectId, sectionsByPath } = input;

  // 1. Collect all content paths from the route.
  const allRoutePaths = collectRoutePaths(route, projectId);

  // 2. Drop remote URLs — they are matched as entities by their stored path,
  //    not by raw URL. Any raw URL that slips through is silently ignored.
  const localPaths = allRoutePaths.filter((p) => !p.startsWith("https://"));

  // 3. Match entities against the route's local paths.
  const matched = matchEntities(entities, localPaths);

  // 4. Filter skill entities by intent.
  const filtered = filterByIntent(matched, route.intent);

  // 5. Budget enforcement in tier-priority order, by section when sections were given.
  const bySection = sectionsByPath ? enforceBudgetBySection(filtered, budget, priority, sectionsByPath) : undefined;
  const result = bySection ?? enforceBudget(filtered, budget, priority);

  // 6. Assemble the delimiter-joined blob.
  const content = assembleContext(result.files);

  return {
    content,
    filesIncluded: result.files.map((f) => ({
      path: f.path,
      tier: f.tier,
      tokens: f.estimatedTokens,
    })),
    tokensUsed: result.totalTokens,
    budgetTokens: budget,
    truncated: result.truncated,
    omitted: (result.omitted ?? []).map((f) => ({ path: f.path, tier: f.tier, tokens: f.estimatedTokens })),
    ...(bySection ? { loadedSections: bySection.loadedOrdinals } : {}),
  };
}
