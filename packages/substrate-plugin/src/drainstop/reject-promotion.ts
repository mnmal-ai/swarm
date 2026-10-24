/**
 * A human rejecting a promoted row: archive it, and ratchet the calibration
 * anchor up so later promotions face a stricter bar.
 *
 * Request: `{ targetType: "Todo" | "Decision" | "AgentRule", targetId }`.
 *
 *   1. Read the target in the context namespace (404 when it does not exist).
 *   2. Require the drainstop's lineage marker in its `notes` (Todo) or
 *      `rationale` (Decision, AgentRule); without it, `not_a_promotion` (400).
 *   3. Already archived: answer `alreadyRejected: true` with the current
 *      anchor score, without ratcheting again.
 *   4. Archive the target (`update<Type> { archived: true }`, reversible).
 *   5. Raise the anchor's confidence by {@link ANCHOR_RATCHET_STEP}, capped at
 *      {@link ANCHOR_CONFIDENCE_MAX}.
 *
 * Archive and ratchet are separate writes in two namespaces. The archive goes
 * first, so a failed ratchet followed by a retry lands on step 3: the anchor
 * is under-corrected at worst, never ratcheted twice for one rejection.
 *
 * Every frame runs as the caller, so with auth on the caller needs grants in
 * both namespaces.
 */
import {
  EngineQueryError,
  type EngineHandle,
  jsonResponse,
  type PluginRouter,
  type RequestContext,
  type SubstrateRequest,
  type SubstrateResponse,
} from "@mnmal-ai/substrate/sdk";
import { FrameRefusedError, mutateOne, queryRows } from "./frames.js";

export type PromotionTargetType = "Todo" | "Decision" | "AgentRule";

export interface RejectPromotionRequest {
  targetType: PromotionTargetType;
  targetId: string;
}

export interface RejectPromotionResult {
  ok: true;
  targetType: PromotionTargetType;
  targetId: string;
  targetArchived: boolean;
  alreadyRejected: boolean;
  anchorId: string | null;
  anchorConfidenceBefore: number | null;
  anchorConfidenceAfter: number | null;
}

export interface RejectPromotionError {
  error: string;
  code: string;
}

export interface RejectPromotionConfig {
  /** The namespace hosting `Observation` (and so the anchor). */
  planeNamespace: string;
  /** The namespace hosting the promoted rows. */
  contextNamespace: string;
}

/** Writers self-score 0–100, so the anchor stops at 100. */
export const ANCHOR_CONFIDENCE_MAX = 100;

/** How far one rejection raises the anchor. */
export const ANCHOR_RATCHET_STEP = 10;

/** The anchor's score when it has none. */
const ANCHOR_DEFAULT_CONFIDENCE = 50;

const TARGET_TYPES: ReadonlySet<string> = new Set<PromotionTargetType>(["Todo", "Decision", "AgentRule"]);

/** The field carrying the drainstop's lineage marker, per target type. */
const LINEAGE_FIELDS: Readonly<Record<PromotionTargetType, string>> = {
  Todo: "notes",
  Decision: "rationale",
  AgentRule: "rationale",
};

/**
 * Whether the row carries a drainstop lineage marker: a single-source
 * promotion's `<plane>/Observation id=…`, or a concern recurrence's
 * `<plane>/Observation records with tags …` (whose ids are on `- id=` lines).
 */
function hasLineage(row: Record<string, unknown>, type: PromotionTargetType, planeNamespace: string): boolean {
  const value = row[LINEAGE_FIELDS[type]];
  if (typeof value !== "string") return false;
  return value.includes(`${planeNamespace}/Observation id=`) || value.includes(`${planeNamespace}/Observation records with tags`);
}

/**
 * The reject flow, without HTTP. Refusals by the engine come back as
 * `{ error, code }` rather than throwing.
 */
export async function runRejectPromotion(
  engine: EngineHandle,
  cfg: RejectPromotionConfig,
  req: RejectPromotionRequest,
  ctx?: Partial<RequestContext>,
): Promise<RejectPromotionResult | RejectPromotionError> {
  try {
    return await rejectPromotion(engine, cfg, req, ctx);
  } catch (err) {
    if (err instanceof EngineQueryError || err instanceof FrameRefusedError) {
      return { error: err.message, code: err.code ?? "mutate_failed" };
    }
    throw err;
  }
}

async function rejectPromotion(
  engine: EngineHandle,
  cfg: RejectPromotionConfig,
  req: RejectPromotionRequest,
  ctx: Partial<RequestContext> | undefined,
): Promise<RejectPromotionResult | RejectPromotionError> {
  if (!TARGET_TYPES.has(req.targetType)) {
    return { error: `targetType must be one of: ${[...TARGET_TYPES].join(", ")}`, code: "bad_target_type" };
  }
  const lineageField = LINEAGE_FIELDS[req.targetType];
  const [target] = await queryRows<Record<string, unknown>>(
    engine,
    cfg.contextNamespace,
    req.targetType,
    { id: req.targetId },
    ["id", "archived", lineageField],
    ctx,
  );
  if (target === undefined) return { error: `${req.targetType} id=${req.targetId} not found`, code: "not_found" };
  if (!hasLineage(target, req.targetType, cfg.planeNamespace)) {
    return {
      error: `${req.targetType} id=${req.targetId} carries no drainstop lineage; nothing to reject`,
      code: "not_a_promotion",
    };
  }

  const [anchor] = await queryRows<{ id: string; confidence?: number | null }>(
    engine,
    cfg.planeNamespace,
    "Observation",
    { where: { isAnchor: { eq: true } }, limit: 1 },
    ["id", "confidence"],
    ctx,
  );
  const anchorId = anchor === undefined ? null : String(anchor.id);
  const before = anchor?.confidence ?? null;

  if (target.archived === true) {
    return {
      ok: true,
      targetType: req.targetType,
      targetId: req.targetId,
      targetArchived: true,
      alreadyRejected: true,
      anchorId,
      anchorConfidenceBefore: before,
      anchorConfidenceAfter: before,
    };
  }

  await mutateOne(engine, cfg.contextNamespace, `update${req.targetType}`, { id: req.targetId, archived: true }, ctx);

  let after: number | null = null;
  if (anchorId !== null) {
    after = Math.min(ANCHOR_CONFIDENCE_MAX, (before ?? ANCHOR_DEFAULT_CONFIDENCE) + ANCHOR_RATCHET_STEP);
    await mutateOne(engine, cfg.planeNamespace, "updateObservation", { id: anchorId, confidence: after }, ctx);
  }

  return {
    ok: true,
    targetType: req.targetType,
    targetId: req.targetId,
    targetArchived: true,
    alreadyRejected: false,
    anchorId,
    anchorConfidenceBefore: before,
    anchorConfidenceAfter: after,
  };
}

/** Parse the request body; a string naming the problem when it is unusable. */
export function parseRejectBody(req: SubstrateRequest): RejectPromotionRequest | string {
  const text = req.body === null ? "" : req.body.toString("utf8");
  if (text.trim().length === 0) return "request body required";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return err instanceof Error ? err.message : "invalid JSON";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "body must be a JSON object";
  const { targetType, targetId } = parsed as Record<string, unknown>;
  if (typeof targetType !== "string") return "targetType must be a string";
  if (typeof targetId !== "string" && typeof targetId !== "number") return "targetId must be a string or number";
  return { targetType: targetType as PromotionTargetType, targetId: String(targetId) };
}

/** Mount `POST /reject-promotion`; `ctxOf` turns the request into the caller's context. */
export function registerRejectPromotionRoute(
  router: PluginRouter,
  engine: EngineHandle,
  cfg: RejectPromotionConfig,
  ctxOf: (req: SubstrateRequest) => Partial<RequestContext>,
): void {
  router.post("/reject-promotion", async (req): Promise<SubstrateResponse> => {
    const parsed = parseRejectBody(req);
    if (typeof parsed === "string") return jsonResponse(400, { code: "bad_request", message: parsed });
    const result = await runRejectPromotion(engine, cfg, parsed, ctxOf(req));
    if ("error" in result) {
      return jsonResponse(result.code === "not_found" ? 404 : 400, { code: result.code, message: result.error });
    }
    return jsonResponse(200, result);
  });
}
