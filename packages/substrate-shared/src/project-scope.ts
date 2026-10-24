/**
 * Which `SwarmContent` / `SwarmRoute` rows a project reads.
 *
 * Several swarm projects can share one Substrate. Each project's sync writes its
 * rows under its own `projectId`, so the readers have to pick the running
 * project's rows out of everyone's. Rows written before that change are the
 * "legacy" scope: content under `projectId: "global"` (every non-domain file
 * used to be written that way) and routes with no `projectId` at all. Legacy
 * rows stay readable, so a Substrate seeded by an older swarm keeps working
 * without a migration; a project's own row always wins over a legacy one.
 *
 * Pure functions, shared by the server-side resolvers, the client-side
 * `Loader` fallback and the CLI's display of a project's files.
 */

/** The `projectId` older syncs wrote on every non-domain `SwarmContent` row. */
export const LEGACY_GLOBAL_PROJECT_ID = "global";

/** Rows are typed loosely (a stored `Row`, a `SwarmContentEntity`, a client's
 *  own row shape), so fields are read off a plain object view. */
type Fields = { projectId?: unknown; path?: unknown };

function projectIdOf(row: object): string {
  const id = (row as Fields).projectId;
  return typeof id === "string" ? id : "";
}

/** True for a row in the shared legacy scope: `projectId` missing, empty or
 *  `"global"`. */
export function isLegacyScoped(row: object): boolean {
  const id = projectIdOf(row);
  return id === "" || id === LEGACY_GLOBAL_PROJECT_ID;
}

/**
 * The `SwarmContent` rows `projectId` reads: for each path, the project's own
 * rows if it has any, otherwise the legacy rows at that path. Another
 * project's rows are never returned. Without a `projectId` every row passes
 * through unchanged (callers that do not know the project keep the old
 * behaviour).
 */
export function selectProjectContent<T extends object>(
  rows: T[],
  projectId: string | undefined,
): T[] {
  if (!projectId) return rows;
  const pathOf = (r: T): string => String((r as Fields).path);
  const ownPaths = new Set(rows.filter((r) => projectIdOf(r) === projectId).map(pathOf));
  return rows.filter((r) =>
    projectIdOf(r) === projectId || (isLegacyScoped(r) && !ownPaths.has(pathOf(r))),
  );
}

/**
 * The `SwarmRoute` rows `projectId` reads: its own routes once it has synced
 * any, otherwise the legacy routes. Selection is by set, not per intent, so a
 * legacy route for an intent the project does not define (typically written
 * by whichever project synced first) cannot reach its classifier. Without a
 * `projectId` every row passes through unchanged.
 */
export function selectProjectRoutes<T extends object>(
  rows: T[],
  projectId: string | undefined,
): T[] {
  if (!projectId) return rows;
  const own = rows.filter((r) => projectIdOf(r) === projectId);
  return own.length > 0 ? own : rows.filter(isLegacyScoped);
}
