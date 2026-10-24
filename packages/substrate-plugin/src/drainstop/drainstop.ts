/**
 * The drainstop: one pass over `<plane>/Observation` that seeds the
 * calibration anchor, promotes high-signal observations into the cortext
 * context store, and expires the rest by TTL.
 *
 * Order of a run:
 *
 *   1. Seed the anchor if no `isAnchor: true` row exists.
 *   2. Page through the whole table, oldest first (`forEachObservationPage`).
 *      On each page: single-source promotions (see `./promotion.ts`), each
 *      copy-then-delete, then TTL expiry (see `./expiry.ts`) over the rows that
 *      were not promotion candidates. A candidate whose promotion failed is
 *      kept for the next run rather than expired in the same pass. Concerns
 *      are set aside, because a recurrence group may span pages.
 *   3. Concern recurrence over every concern read: concerns sharing a tag
 *      signature are appended to an open `Recurrent concern: <sig>` Todo when
 *      there is one, or promoted as a new one once the group reaches
 *      {@link CONCERN_RECURRENCE_MIN_GROUP_SIZE}; the sources are deleted. The
 *      concerns no recurrence took are then TTL-checked.
 *
 * Promotion writes run on {@link withStrictPromotions} over the context
 * namespace, so a refused write throws `PromotionWriteError`, the observation
 * stays, and the refusal is reported in {@link DrainstopResult.failures}.
 * Nothing here is atomic across namespaces: each create and delete is its own
 * transaction, and a run that wrote a target but failed its delete is healed
 * by the next run (idempotency-keyed create, then the delete again).
 *
 * The anchor is the reference for "what confidence = 50 means"; a human
 * rejecting a promotion walks it up (see `./reject-promotion.ts`). It is never
 * promoted and never expired.
 */
import type { DrainstopResult } from "@mnmal-ai/swarm-substrate-shared";
import type { EngineHandle } from "@mnmal-ai/substrate/sdk";
import {
  deleteObservation,
  type ExpiryConfig,
  expireRows,
  forEachObservationPage,
  type ObservationRow,
} from "./expiry.js";
import { failureOf, mutateOne, queryRows } from "./frames.js";
import {
  absorbIntoRecurrence,
  CONCERN_RECURRENCE_MIN_GROUP_SIZE,
  groupConcernsBySig,
  loadOpenRecurrences,
  type OpenRecurrence,
  type PromotionTarget,
  promoteConcernRecurrence,
  promoteToAgentRule,
  promoteToDecision,
  promoteToTodo,
  withStrictPromotions,
} from "./promotion.js";

export const ANCHOR_SEED_BODY =
  'Calibration anchor for observation-confidence scoring. This observation represents "what confidence = 50 looks like" — a neutral, unverified intuition. Writers compare their self-rating against this reference point. Human-rejected promotions ratchet this anchor UP by +10 via the swarm plugin\'s reject-promotion route, raising the bar for subsequent promotions.';

export const ANCHOR_SEED_TAGS = "anchor,calibration,plane-phase-2";

/** Single-source promotions: architectural observations promote above this confidence. */
const DECISION_CONFIDENCE_FLOOR = 80;

/** User-framing observations promote only at exactly this confidence. */
const AGENT_RULE_CONFIDENCE = 100;

export interface DrainstopConfig extends ExpiryConfig {
  /** The namespace hosting the promotion targets (`Todo`, `Decision`, `AgentRule`). */
  contextNamespace: string;
}

/** What one drainstop pass did. The shape lives in the shared package. */
export type { DrainstopResult };

/**
 * Write the calibration anchor if no `isAnchor: true` observation exists.
 * Returns true when this call wrote it.
 */
export async function seedAnchorIfMissing(engine: EngineHandle, cfg: ExpiryConfig): Promise<boolean> {
  const existing = await queryRows<{ id: string }>(
    engine,
    cfg.planeNamespace,
    "Observation",
    { where: { isAnchor: { eq: true } }, limit: 1 },
    ["id"],
    cfg.ctx,
  );
  if (existing.length > 0) return false;
  await mutateOne(
    engine,
    cfg.planeNamespace,
    "createObservation",
    {
      ts: (cfg.now ?? new Date()).toISOString(),
      kind: "user-framing",
      body: ANCHOR_SEED_BODY,
      context: "",
      confidence: 50,
      tags: ANCHOR_SEED_TAGS,
      ttlHours: null,
      isAnchor: true,
    },
    cfg.ctx,
    `swarm-anchor-seed:${cfg.planeNamespace}`,
  );
  return true;
}

type Kind = "todo" | "decision" | "agentRule";

/** Which single-source promotion an observation qualifies for, if any. */
function singleSourcePromotion(obs: ObservationRow): Kind | null {
  if (obs.kind === "fold-back-candidate") return "todo";
  if (obs.kind === "architectural" && (obs.confidence ?? 0) > DECISION_CONFIDENCE_FLOOR) return "decision";
  // Strict equality: 99 does not promote, and above 100 is a writer bug.
  if (obs.kind === "user-framing" && obs.confidence === AGENT_RULE_CONFIDENCE) return "agentRule";
  return null;
}

const PHASE: Record<Kind, string> = { todo: "promote_todo", decision: "promote_decision", agentRule: "promote_agent_rule" };

/**
 * Run one drainstop pass. Throws only when the plane namespace itself refuses
 * the anchor check or a page read; every promotion or delete failure is
 * reported in the result and leaves its observation in place.
 */
export async function runDrainstopOnce(engine: EngineHandle, cfg: DrainstopConfig): Promise<DrainstopResult> {
  const now = cfg.now ?? new Date();
  const run: DrainstopConfig = { ...cfg, now };
  const metric = cfg.metric;
  const anchorSeeded = await seedAnchorIfMissing(engine, run);
  if (anchorSeeded) metric?.("swarm_drainstop_anchor_seeded", { namespace: cfg.planeNamespace });

  const result: DrainstopResult = {
    promoted: { todos: 0, decisions: 0, agentRules: 0 },
    absorbed: 0,
    expired: 0,
    anchorSeeded,
    failures: [],
    truncated: false,
  };
  const fail = (phase: string, observationId: string | null, err: unknown): void => {
    const failure = failureOf(phase, observationId, err);
    result.failures.push(failure);
    metric?.("swarm_drainstop_error", failure);
  };
  const expire = async (rows: readonly ObservationRow[]): Promise<void> => {
    const expiry = await expireRows(engine, run, rows);
    result.expired += expiry.expired;
    result.failures.push(...expiry.failures);
  };
  const target: PromotionTarget = {
    engine: withStrictPromotions(engine, [cfg.contextNamespace]),
    planeNamespace: cfg.planeNamespace,
    contextNamespace: cfg.contextNamespace,
    ctx: cfg.ctx,
  };
  const deleteSource = (id: string) => deleteObservation(engine, cfg.planeNamespace, id, cfg.ctx);

  // Single-source promotions and expiry, a page at a time; concerns set aside.
  const concerns: ObservationRow[] = [];
  const scan = await forEachObservationPage(engine, run, async (rows) => {
    const rest: ObservationRow[] = [];
    for (const obs of rows) {
      // Anchor immunity: never promoted, never expired, whatever its kind, confidence or TTL.
      if (obs.isAnchor === true) continue;
      if (obs.kind === "concern") {
        concerns.push(obs);
        continue;
      }
      const kind = singleSourcePromotion(obs);
      if (kind === null) {
        rest.push(obs);
        continue;
      }
      try {
        if (kind === "todo") await promoteToTodo(target, obs);
        else if (kind === "agentRule") await promoteToAgentRule(target, obs);
        else await promoteToDecision(target, obs);
      } catch (err) {
        fail(PHASE[kind], obs.id, err);
        continue;
      }
      if (kind === "todo") result.promoted.todos++;
      else if (kind === "agentRule") result.promoted.agentRules++;
      else result.promoted.decisions++;
      metric?.("swarm_drainstop_promoted", { target: kind, sourceId: obs.id, sourceKind: obs.kind });
      try {
        await deleteSource(obs.id);
      } catch (err) {
        fail("delete", obs.id, err);
      }
    }
    await expire(rest);
  });
  result.truncated = scan.truncated;

  // Concern recurrence over every concern read, then expiry of the ones it left.
  const handled = new Set<string>();
  const groups = groupConcernsBySig(concerns);
  let open: Map<string, OpenRecurrence> | null = null;
  if (groups.size > 0) {
    try {
      open = await loadOpenRecurrences(target);
    } catch (err) {
      fail("load_open_recurrences", null, err);
    }
  }
  for (const [tagSig, group] of open === null ? [] : groups) {
    const existing = open?.get(tagSig);
    if (existing === undefined && group.length < CONCERN_RECURRENCE_MIN_GROUP_SIZE) continue;
    for (const o of group) handled.add(o.id);
    const phase = existing === undefined ? "promote_concern_recurrence" : "absorb_concern_recurrence";
    try {
      if (existing === undefined) await promoteConcernRecurrence(target, tagSig, group);
      else result.absorbed += (await absorbIntoRecurrence(target, tagSig, existing, group)).length;
    } catch (err) {
      for (const o of group) fail(phase, o.id, err);
      continue;
    }
    if (existing === undefined) {
      result.promoted.todos++;
      metric?.("swarm_drainstop_promoted", { target: "Todo", reason: "concern_recurrence", tagSig, sourceIds: group.map((o) => o.id) });
    }
    for (const o of group) {
      try {
        await deleteSource(o.id);
      } catch (err) {
        fail("delete", o.id, err);
      }
    }
  }
  await expire(concerns.filter((o) => !handled.has(o.id)));

  metric?.("swarm_drainstop_scan", {
    scanned: scan.scanned,
    pages: scan.pages,
    truncated: scan.truncated,
    promoted: result.promoted,
    absorbed: result.absorbed,
    expired: result.expired,
    failures: result.failures.length,
  });
  return result;
}
