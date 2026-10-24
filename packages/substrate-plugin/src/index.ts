export {
  CONTRACT_VERSION,
  createSwarmSubstratePlugin,
  DEFAULT_CONTEXT_NAMESPACE,
  DEFAULT_DRAINSTOP_INTERVAL_MS,
  resolveSwarmPluginConfig,
} from "./plugin.js";
export type { SwarmPluginConfig, SwarmScope, ResolvedSwarmPluginConfig } from "./plugin.js";
export { buildNamespaces, metaNamespaceFor } from "./namespaces.js";
export { swarmTypes } from "./types/swarm-types.js";
export { swarmMetaTypes } from "./types/meta-types.js";
export { Observation } from "./types/observation.js";
export { swarmDocsTypes, DOCUMENT_SOURCES, EMBED_BODY_CHARS, sectionEmbedText } from "./types/docs-types.js";
export type { DocumentSource } from "./types/docs-types.js";
export { registerSwarmResolvers, withSwarmResolvers } from "./resolvers/register.js";
// The resolvers themselves, for consumers that test against them over a stub dataset.
export { classifyIntent } from "./resolvers/classify-intent.js";
export { loadContext } from "./resolvers/load-context.js";
export type { SwarmResolverDeps } from "./resolvers/register.js";
export { makeEngineDocsReader, makeEngineRecall, RECALL_HIT_KEY } from "./resolvers/engine-recall.js";
export type { SwarmRecallDeps, SemanticHit, SemanticRecall, SemanticSearchArgs, SemanticWhere } from "./resolvers/recall.js";
export type { DocsReader, DocsSource, DocsWhere } from "./resolvers/load-context.js";
export {
  ANCHOR_SEED_BODY,
  ANCHOR_SEED_TAGS,
  runDrainstopOnce,
  seedAnchorIfMissing,
} from "./drainstop/drainstop.js";
export type { DrainstopConfig, DrainstopResult } from "./drainstop/drainstop.js";
export {
  ageHours,
  DEFAULT_TTL_UNKNOWN_KIND_HOURS,
  DRAINSTOP_KIND_DEFAULTS,
  effectiveTtlHours,
  expireObservations,
  forEachObservationPage,
  isExpired,
  MAX_SCAN_PAGES,
  SCAN_PAGE_SIZE,
} from "./drainstop/expiry.js";
export type { ExpiryConfig, ObservationRow, ScanSummary } from "./drainstop/expiry.js";
export { DRAINSTOP_IDENTITY, FrameRefusedError, systemContext } from "./drainstop/frames.js";
export type { DrainstopFailure, Metric } from "./drainstop/frames.js";
export {
  AGENT_RULE_DEFAULT_CATEGORY,
  CONCERN_RECURRENCE_MIN_GROUP_SIZE,
  groupConcernsBySig,
  PROMOTION_AREA,
  PromotionWriteError,
  parseCategoryPrefix,
  RECURRENCE_TITLE_PREFIX,
  tagSignature,
  withStrictPromotions,
} from "./drainstop/promotion.js";
export {
  ANCHOR_CONFIDENCE_MAX,
  ANCHOR_RATCHET_STEP,
  runRejectPromotion,
} from "./drainstop/reject-promotion.js";
export type {
  PromotionTargetType,
  RejectPromotionConfig,
  RejectPromotionRequest,
  RejectPromotionResult,
} from "./drainstop/reject-promotion.js";
export { buildOnboardInstructions } from "./onboard.js";
export type { SwarmOnboardInstructions, OnboardOptions } from "./onboard.js";
export { createSerialRunner, registerSwarmRoutes, requestContext } from "./routes.js";
export {
  SWARM_ONBOARD_PATH,
  REJECT_PROMOTION_PATH,
  TRIGGER_DRAINSTOP_PATH,
} from "@mnmal-ai/swarm-substrate-shared";
