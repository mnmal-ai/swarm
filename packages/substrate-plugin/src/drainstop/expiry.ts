/**
 * TTL expiry for `Observation` rows.
 *
 * Observations used to live in a memory-backed store, so a restart dropped
 * them. In the swarm namespace they are durable, and this sweep is what keeps
 * them ephemeral: a row older than its TTL is deleted.
 *
 * TTL, in hours, per row: a positive finite `ttlHours` override, else the
 * kind's entry in {@link DRAINSTOP_KIND_DEFAULTS}, else
 * {@link DEFAULT_TTL_UNKNOWN_KIND_HOURS}. A zero, negative or non-finite
 * override falls through to the kind default. `Infinity` never expires, and
 * the calibration anchor (`isAnchor: true`) never expires whatever its age.
 *
 * `expireObservations` runs on the plugin's schedule by itself, and
 * `runDrainstopOnce` runs the same per-row rule after its promotions, on the
 * rows that were not promotion candidates.
 */
import type { EngineHandle, RequestContext } from "@mnmal-ai/substrate/sdk";
import { type DrainstopFailure, failureOf, type Metric, mutateOne, queryPage } from "./frames.js";

/**
 * Per-kind retention defaults, in hours. `Infinity` means the row leaves only
 * through promotion or a manual delete. Fold-back-candidate's 48h is a safety
 * net for a promotion that never happens; concern's 168h is the ceiling for
 * rows that never join a recurrence group. `kind` is a convention, not an
 * enum, so unknown kinds fall through to {@link DEFAULT_TTL_UNKNOWN_KIND_HOURS}.
 */
export const DRAINSTOP_KIND_DEFAULTS: Readonly<Record<string, number>> = {
  architectural: Number.POSITIVE_INFINITY,
  pattern: 168,
  concern: 168,
  "open-question": Number.POSITIVE_INFINITY,
  "user-framing": Number.POSITIVE_INFINITY,
  "fold-back-candidate": 48,
  rationale: 72,
};

export const DEFAULT_TTL_UNKNOWN_KIND_HOURS = 168;

/** Rows read per page of a sweep. */
export const SCAN_PAGE_SIZE = 1000;

/**
 * Pages one sweep reads at most (50,000 rows at the default page size). A
 * sweep that reaches it stops, reports `truncated`, and emits
 * `swarm_drainstop_truncated`; the next sweep starts from the oldest row again.
 */
export const MAX_SCAN_PAGES = 50;

const HOUR_MS = 3_600_000;

/** An `Observation` row as the drainstop reads it. */
export interface ObservationRow {
  id: string;
  ts: string;
  kind: string;
  body: string;
  context?: string | null;
  confidence?: number | null;
  tags?: string | null;
  ttlHours?: number | null;
  isAnchor?: boolean | null;
}

export const OBSERVATION_FIELDS = ["id", "ts", "kind", "body", "context", "confidence", "tags", "ttlHours", "isAnchor"] as const;

export interface ExpiryConfig {
  /** The namespace hosting `Observation` (the swarm namespace). */
  planeNamespace: string;
  /** The clock; default the wall clock. */
  now?: Date;
  /** The context every frame runs as; default the `swarm-drainstop` system envelope (`DRAINSTOP_IDENTITY`). */
  ctx?: Partial<RequestContext>;
  /** Metric sink; default none. */
  metric?: Metric;
  /** Rows per page; default {@link SCAN_PAGE_SIZE}. */
  pageSize?: number;
  /** Page cap per sweep; default {@link MAX_SCAN_PAGES}. */
  maxPages?: number;
}

export function effectiveTtlHours(obs: Pick<ObservationRow, "kind" | "ttlHours">): number {
  const override = obs.ttlHours;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return DRAINSTOP_KIND_DEFAULTS[obs.kind] ?? DEFAULT_TTL_UNKNOWN_KIND_HOURS;
}

/** Age in hours at `nowMs`; an unparseable `ts` counts as brand new. */
export function ageHours(obs: Pick<ObservationRow, "ts">, nowMs: number): number {
  const parsed = Date.parse(obs.ts);
  if (!Number.isFinite(parsed)) return 0;
  return (nowMs - parsed) / HOUR_MS;
}

export function isExpired(obs: ObservationRow, nowMs: number): boolean {
  if (obs.isAnchor === true) return false;
  const ttl = effectiveTtlHours(obs);
  return Number.isFinite(ttl) && ageHours(obs, nowMs) > ttl;
}

/** What a paged sweep covered. */
export interface ScanSummary {
  pages: number;
  scanned: number;
  /** True when the sweep stopped at the page cap with rows left unread. */
  truncated: boolean;
}

/**
 * Visit every observation, a page at a time, oldest first, following the list
 * query's cursor until it runs out or the page cap is reached. The cursor is
 * keyset (the last row's `ts` and `id`), so `visit` may delete rows of the
 * page it is handed without shifting the next page.
 *
 * Reading the whole table matters because rows are durable: kinds that never
 * expire (architectural at or below 80, open-question, user-framing below 100)
 * accumulate, and a single oldest-N window would fill with them and starve
 * every newer row of promotion and expiry.
 */
export async function forEachObservationPage(
  engine: EngineHandle,
  cfg: ExpiryConfig,
  visit: (rows: ObservationRow[]) => Promise<void>,
): Promise<ScanSummary> {
  const pageSize = cfg.pageSize ?? SCAN_PAGE_SIZE;
  const maxPages = cfg.maxPages ?? MAX_SCAN_PAGES;
  let cursor: string | undefined;
  let pages = 0;
  let scanned = 0;
  do {
    if (pages === maxPages) {
      cfg.metric?.("swarm_drainstop_truncated", { namespace: cfg.planeNamespace, pages, scanned });
      return { pages, scanned, truncated: true };
    }
    const page = await queryPage<ObservationRow>(
      engine,
      cfg.planeNamespace,
      "Observation",
      { limit: pageSize, orderBy: [{ ts: "asc" }] },
      OBSERVATION_FIELDS,
      cfg.ctx,
      cursor,
    );
    pages++;
    scanned += page.rows.length;
    await visit(page.rows.map((row) => ({ ...row, id: String(row.id) })));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { pages, scanned, truncated: false };
}

export async function deleteObservation(
  engine: EngineHandle,
  planeNamespace: string,
  id: string,
  ctx: Partial<RequestContext> | undefined,
): Promise<void> {
  await mutateOne(engine, planeNamespace, "deleteObservation", { id }, ctx);
}

/**
 * Delete each expired row of `rows`. A failed delete is reported and the
 * sweep goes on.
 */
export async function expireRows(
  engine: EngineHandle,
  cfg: ExpiryConfig,
  rows: readonly ObservationRow[],
): Promise<{ expired: number; failures: DrainstopFailure[] }> {
  const nowMs = (cfg.now ?? new Date()).getTime();
  const failures: DrainstopFailure[] = [];
  let expired = 0;
  for (const obs of rows) {
    if (!isExpired(obs, nowMs)) continue;
    try {
      await deleteObservation(engine, cfg.planeNamespace, obs.id, cfg.ctx);
      expired++;
      cfg.metric?.("swarm_drainstop_expired", {
        sourceId: obs.id,
        sourceKind: obs.kind,
        ageHours: ageHours(obs, nowMs),
        ttlHours: effectiveTtlHours(obs),
      });
    } catch (err) {
      const failure = failureOf("expire", obs.id, err);
      failures.push(failure);
      cfg.metric?.("swarm_drainstop_error", failure);
    }
  }
  return { expired, failures };
}

/**
 * Delete every observation past its TTL, paging through the whole table.
 * Returns how many were deleted. Reads through the engine as `cfg.ctx`; a
 * refused page read throws.
 */
export async function expireObservations(engine: EngineHandle, cfg: ExpiryConfig): Promise<number> {
  let expired = 0;
  await forEachObservationPage(engine, cfg, async (rows) => {
    expired += (await expireRows(engine, cfg, rows)).expired;
  });
  return expired;
}
