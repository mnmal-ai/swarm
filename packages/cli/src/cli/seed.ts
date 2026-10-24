/**
 * swarm sync — Seed .swarm/ files into Substrate.
 *
 * Reads swarm.json, walks the .swarm/ directory, and ingests all content
 * into the Substrate store. Uses dedup-by-key to prevent duplicates —
 * queries existing entities first and only inserts new ones.
 *
 * Used by:
 *   - swarm init (after DB setup)
 *   - swarm run (auto-sync before execution)
 *   - swarm sync (manual command)
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ---------------------------------------------------------------------------
// Tier mapping
// ---------------------------------------------------------------------------

const TIER_MAP: Record<string, string> = {
  core: "core",
  modes: "mode",
  capabilities: "capabilities",
  domains: "domain",
  oversight: "oversight",
  skills: "skills_vetted",
};

const EXCLUDED_FILES = new Set([
  "README.md", "CLAUDE.md", "AGENTS.md",
  "package.json", "package-lock.json", ".swarm-meta.json",
  "config.json", // runtime config, not swarm content
]);

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      results.push(...await walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function getTier(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  const topDir = normalized.split("/")[0];
  return TIER_MAP[topDir] ?? null;
}

// ---------------------------------------------------------------------------
// Dedup helper
// ---------------------------------------------------------------------------

type StoredRoute = { id: unknown; description: unknown; keywords: unknown; contentPaths: unknown };

/**
 * This project's own route rows, by intent. Null when they can't be read:
 * the caller then writes no routes at all, since treating a failed read as
 * "no routes" would add every route again as a duplicate. (The swarm plugin
 * registers SwarmRoute before any sync, so there is no "type missing" case.)
 */
async function getProjectRoutes(client: SubstrateClient, projectId: string): Promise<Map<string, StoredRoute> | null> {
  let rows: Record<string, unknown>[] | Record<string, unknown>;
  try {
    rows = await client.query<Record<string, unknown>>(
      "SwarmRoute",
      { where: { projectId: { eq: projectId } } },
      { id: true, intent: true, description: true, keywords: true, contentPaths: true, projectId: true },
    );
  } catch (err) {
    console.warn(
      `[swarm] Could not read this project's routes, so none were synced this time: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const routes = new Map<string, StoredRoute>();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (row.projectId !== projectId || typeof row.intent !== "string" || row.intent === "") continue;
    if (!routes.has(row.intent)) routes.set(row.intent, row as StoredRoute);
  }
  return routes;
}

/**
 * Query existing entities from Substrate and return a set of their key values.
 * Used to avoid inserting duplicates.
 *
 * With `projectId`, only that project's rows count: the server
 * filters by `projectId`, and the rows are filtered again here so a server that
 * ignores the where-clause cannot widen the set.
 */
async function getExistingKeys(
  client: SubstrateClient,
  typeName: string,
  keyField: string,
  projectId?: string,
): Promise<Set<string>> {
  try {
    const existing = projectId === undefined
      ? await client.query<Record<string, unknown>>(typeName, {}, { [keyField]: true })
      : await client.query<Record<string, unknown>>(
          typeName,
          { where: { projectId: { eq: projectId } } },
          { [keyField]: true, projectId: true },
        );
    return new Set(
      (Array.isArray(existing) ? existing : [existing])
        .filter((e) => projectId === undefined || e.projectId === projectId)
        .map((e) => String(e[keyField] ?? ""))
        .filter(Boolean),
    );
  } catch {
    // Type may not exist yet — no existing entities
    return new Set();
  }
}

/**
 * Query this project's existing SwarmContent rows and group them by path,
 * capturing each row's id + content. Used by the content-aware sync path: a
 * path-only dedup (the `getExistingKeys` helper above) silently skips files
 * whose content on disk has changed since the last sync. This helper lets the
 * caller compare disk content to stored content and replace stale rows instead
 * of skipping them.
 *
 * Only rows whose `projectId` is `projectId` are returned: several
 * projects can share one Substrate, and a project's sync must never compare
 * against, or delete, another project's rows or the legacy `global` rows. The
 * server filters by `projectId`; the rows are filtered again here so a server
 * that ignores the where-clause cannot widen the set.
 *
 * Returns a map of `path -> array of rows` because earlier `seedSwarmContentForce`
 * calls can have left multiple rows with the same path. The caller treats any
 * matching content (across the array) as "still in sync" and otherwise deletes
 * every stale row before inserting the new one.
 */
async function getExistingSwarmContent(
  client: SubstrateClient,
  projectId: string,
): Promise<Map<string, Array<{ id: string | number; content: string }>>> {
  try {
    const existing = await client.query<{
      id: string | number;
      path?: string;
      content?: string;
      projectId?: string;
    }>(
      "SwarmContent",
      { where: { projectId: { eq: projectId } } },
      { id: true, path: true, content: true, projectId: true },
    );
    const map = new Map<string, Array<{ id: string | number; content: string }>>();
    for (const row of Array.isArray(existing) ? existing : [existing]) {
      if (!row.path || row.projectId !== projectId) continue;
      const key = String(row.path);
      const entry = {
        id: row.id,
        content: String(row.content ?? ""),
      };
      const arr = map.get(key);
      if (arr) arr.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  } catch {
    // Type may not exist yet — no existing entities
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The markdown files `seedSwarmContent` stores as SwarmContent, with the same
 * paths (relative to the swarm dir, `/`-separated), for storing them as
 * sections too (context.sections). JSON content files are left out: they have
 * no headings to split at, and load whole.
 */
export async function listSwarmMarkdown(swarmDir: string): Promise<Array<{ path: string; content: string }>> {
  const swarmPath = resolve(swarmDir);
  const files: Array<{ path: string; content: string }> = [];
  // Unlike walkDir, a folder that exists but can't be read throws: an empty
  // answer would make the section sync delete what it has stored.
  const strictReaddir = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw err;
    }
  };
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await strictReaddir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) out.push(...(await walk(full)));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  };
  const topLevel = await strictReaddir(swarmPath);
  for (const dir of topLevel.filter((e) => e.isDirectory() && e.name in TIER_MAP)) {
    for (const filePath of await walk(join(swarmPath, dir.name))) {
      if (!filePath.endsWith(".md") || EXCLUDED_FILES.has(basename(filePath))) continue;
      const path = relative(swarmPath, filePath).replace(/\\/g, "/");
      if (!getTier(path)) continue;
      files.push({ path, content: await readFile(filePath, "utf-8") });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Seed swarm content from a .swarm/ directory into Substrate.
 * Deduplicates by key field — safe to call multiple times without duplicates.
 * New entities are added; existing entities (by key) are skipped.
 */
export async function seedSwarmContent(
  client: SubstrateClient,
  swarmDir: string,
  projectId: string,
): Promise<{ configs: number; content: number; routes: number }> {
  const swarmPath = resolve(swarmDir);
  const swarmJsonPath = join(swarmPath, "swarm.json");

  if (!existsSync(swarmJsonPath)) {
    console.warn(`[swarm] No swarm.json found at ${swarmJsonPath} — skipping seed.`);
    return { configs: 0, content: 0, routes: 0 };
  }

  const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8"));

  // --- SwarmConfig (dedup by "key" field) ---
  const existingConfigKeys = await getExistingKeys(client, "SwarmConfig", "key");
  const configEntities: Record<string, unknown>[] = [];
  const budget = swarmJson.context_budget;
  if (budget) {
    if (budget.default_max_tokens !== undefined && !existingConfigKeys.has("default_max_tokens")) {
      configEntities.push({
        key: "default_max_tokens",
        value: String(budget.default_max_tokens),
        category: "budget",
      });
    }
    for (const [model, tokens] of Object.entries(budget.model_overrides ?? {})) {
      const key = `model_override:${model}`;
      if (!existingConfigKeys.has(key)) {
        configEntities.push({ key, value: String(tokens), category: "budget" });
      }
    }
  }

  let configCount = 0;
  if (configEntities.length > 0) {
    const result = await client.ingest("SwarmConfig", configEntities, "extend");
    configCount = result?.accepted ?? 0;
  }

  // --- SwarmContent (content-aware dedup by "path" field) ---
  //
  // Previous behaviour skipped every file whose path was already present in
  // Substrate — even when the on-disk content had changed since the last sync.
  // That silently dropped goal edits, design-doc updates, skill bumps, etc.,
  // and was the root cause of the "I merged a change but swarm doesn't see
  // it" symptom. The fix below compares disk content to stored content:
  //   - identical content → skip (unchanged file, no work)
  //   - changed content   → delete every stale row for that path, then queue
  //                         the new row for insertion in the batch below
  //   - new path          → insert
  //
  // Deletes are tolerant: a delete failure logs a warning but does not abort
  // the sync. Worst case a duplicate row remains, which is the same surface
  // `seedSwarmContentForce` already produces. The runtime is therefore not
  // newly responsible for handling duplicates — it just sees fewer of them.
  //
  // Rows are keyed by (projectId, path). Several projects can share
  // one Substrate, so the sync reads, compares and deletes only this project's
  // rows, and writes every file — domain or not — under this project. Rows
  // other projects wrote, and the legacy rows older syncs wrote under
  // projectId "global", are left alone; the run-time readers prefer a
  // project's own row at a path and fall back to the legacy one
  // (selectProjectContent in @mnmal-ai/swarm-substrate-shared).
  const existingByPath = await getExistingSwarmContent(client, projectId);
  const contentEntities: Record<string, unknown>[] = [];
  const topLevelEntries = await readdir(swarmPath, { withFileTypes: true });
  const seedableDirs = topLevelEntries.filter(
    (e) => e.isDirectory() && e.name in TIER_MAP,
  );

  for (const dir of seedableDirs) {
    const dirPath = join(swarmPath, dir.name);
    const files = await walkDir(dirPath);

    for (const filePath of files) {
      const relPath = relative(swarmPath, filePath);
      if (!filePath.endsWith(".md") && !filePath.endsWith(".json")) continue;
      if (EXCLUDED_FILES.has(basename(filePath))) continue;

      const normalizedRelPath = relPath.replace(/\\/g, "/");
      const tier = getTier(normalizedRelPath);
      if (!tier) continue;

      const content = await readFile(filePath, "utf-8");

      const existingRows = existingByPath.get(normalizedRelPath) ?? [];
      if (existingRows.some((r) => r.content === content)) {
        // Identical content already in Substrate — nothing to do
        continue;
      }
      // Stale rows present (or fresh path). Delete every stale row first so
      // the inserted row isn't a new duplicate.
      for (const row of existingRows) {
        try {
          await client.mutate("deleteSwarmContent", { id: row.id }, { id: true });
        } catch (err) {
          console.warn(
            `[swarm] Could not delete stale SwarmContent row id=${row.id} for ${normalizedRelPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Continue — the new row will still be added; at worst a stale
          // duplicate remains, which is the existing seedSwarmContentForce
          // behaviour.
        }
      }

      const tokenEstimate = Math.ceil(content.length / 4);

      contentEntities.push({
        path: normalizedRelPath,
        tier,
        intent: "all",
        content,
        // A number: SwarmContent.tokenEstimate is field.number(), and Substrate refuses a string.
        tokenEstimate,
        lastReviewed: new Date().toISOString(),
        projectId,
      });
    }
  }

  let contentCount = 0;
  if (contentEntities.length > 0) {
    const result = await client.ingest("SwarmContent", contentEntities, "extend");
    contentCount = result?.accepted ?? 0;
  }

  // --- SwarmRoute (keyed by (projectId, intent)) ---
  //
  // Keyed per project: another project's route for the same
  // intent, or a legacy route written before routes carried a projectId, does
  // not stop this project registering its own. The run-time readers use a
  // project's own routes once it has any (selectProjectRoutes).
  //
  // A route this project already has is updated in place when swarm.json
  // changes its description, keywords or files, so an edited route takes
  // effect on the next sync instead of never.
  const existingRoutes = await getProjectRoutes(client, projectId);
  const routeEntities: Record<string, unknown>[] = [];
  let routesUpdated = 0;
  for (const route of existingRoutes === null ? [] : (swarmJson.routes ?? [])) {
    const contentPaths: string[] = [];
    for (const paths of Object.values(route.load ?? {})) {
      if (Array.isArray(paths)) contentPaths.push(...paths);
    }
    const fields = {
      description: route.description ?? "",
      keywords: JSON.stringify(route.keywords ?? []),
      contentPaths: JSON.stringify(contentPaths),
    };
    const existing = existingRoutes?.get(route.intent);
    if (existing === undefined) {
      routeEntities.push({ intent: route.intent, ...fields, projectId });
      continue;
    }
    const changed = (Object.keys(fields) as Array<keyof typeof fields>).some((k) => existing[k] !== fields[k]);
    if (!changed) continue;
    try {
      await client.mutate("updateSwarmRoute", { id: existing.id, ...fields }, { id: true });
      routesUpdated++;
    } catch (err) {
      console.warn(
        `[swarm] Could not update the '${route.intent}' route: ${err instanceof Error ? err.message : String(err)}. It keeps its previous files until the next sync.`,
      );
    }
  }

  let routeCount = routesUpdated;
  if (routeEntities.length > 0) {
    const result = await client.ingest("SwarmRoute", routeEntities, "extend");
    routeCount += result?.accepted ?? 0;
  }

  return { configs: configCount, content: contentCount, routes: routeCount };
}

/**
 * Force-seed: ingest ALL swarm content without dedup.
 * Uses "extend" mode which appends — caller must ensure the DB is clean
 * (e.g., via swarm db reset) before calling this, or duplicates will result.
 *
 * This exists because swarm's types have no upsert or delete-by-field, so the only
 * way to refresh modified content is to wipe and re-ingest.
 */
export async function seedSwarmContentForce(
  client: SubstrateClient,
  swarmDir: string,
  projectId: string,
): Promise<{ configs: number; content: number; routes: number }> {
  const swarmPath = resolve(swarmDir);
  const swarmJsonPath = join(swarmPath, "swarm.json");

  if (!existsSync(swarmJsonPath)) {
    console.warn(`[swarm] No swarm.json found at ${swarmJsonPath} — skipping seed.`);
    return { configs: 0, content: 0, routes: 0 };
  }

  const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8"));

  // --- SwarmConfig (no dedup) ---
  const configEntities: Record<string, unknown>[] = [];
  const budget = swarmJson.context_budget;
  if (budget) {
    if (budget.default_max_tokens !== undefined) {
      configEntities.push({
        key: "default_max_tokens",
        value: String(budget.default_max_tokens),
        category: "budget",
      });
    }
    for (const [model, tokens] of Object.entries(budget.model_overrides ?? {})) {
      configEntities.push({
        key: `model_override:${model}`,
        value: String(tokens),
        category: "budget",
      });
    }
  }

  let configCount = 0;
  if (configEntities.length > 0) {
    const result = await client.ingest("SwarmConfig", configEntities, "extend");
    configCount = result?.accepted ?? 0;
  }

  // --- SwarmContent (no dedup) ---
  const contentEntities: Record<string, unknown>[] = [];
  const topLevelEntries = await readdir(swarmPath, { withFileTypes: true });
  const seedableDirs = topLevelEntries.filter(
    (e) => e.isDirectory() && e.name in TIER_MAP,
  );

  for (const dir of seedableDirs) {
    const dirPath = join(swarmPath, dir.name);
    const files = await walkDir(dirPath);

    for (const filePath of files) {
      const relPath = relative(swarmPath, filePath);
      if (!filePath.endsWith(".md") && !filePath.endsWith(".json")) continue;
      if (EXCLUDED_FILES.has(basename(filePath))) continue;

      const normalizedRelPath = relPath.replace(/\\/g, "/");
      const tier = getTier(normalizedRelPath);
      if (!tier) continue;

      const content = await readFile(filePath, "utf-8");
      const tokenEstimate = Math.ceil(content.length / 4);

      contentEntities.push({
        path: normalizedRelPath,
        tier,
        intent: "all",
        content,
        // A number: SwarmContent.tokenEstimate is field.number(), and Substrate refuses a string.
        tokenEstimate,
        lastReviewed: new Date().toISOString(),
        projectId,
      });
    }
  }

  let contentCount = 0;
  if (contentEntities.length > 0) {
    const result = await client.ingest("SwarmContent", contentEntities, "extend");
    contentCount = result?.accepted ?? 0;
  }

  // --- SwarmRoute (no dedup) ---
  const routeEntities: Record<string, unknown>[] = [];
  for (const route of swarmJson.routes ?? []) {
    const contentPaths: string[] = [];
    for (const paths of Object.values(route.load ?? {})) {
      if (Array.isArray(paths)) contentPaths.push(...paths);
    }
    routeEntities.push({
      intent: route.intent,
      description: route.description ?? "",
      keywords: JSON.stringify(route.keywords ?? []),
      contentPaths: JSON.stringify(contentPaths),
      projectId,
    });
  }

  let routeCount = 0;
  if (routeEntities.length > 0) {
    const result = await client.ingest("SwarmRoute", routeEntities, "extend");
    routeCount = result?.accepted ?? 0;
  }

  return { configs: configCount, content: contentCount, routes: routeCount };
}
