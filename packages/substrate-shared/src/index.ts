/**
 * `@mnmal-ai/swarm-substrate-shared`: the pure pieces the swarm's Substrate
 * plugin and its client share — resolver request/response shapes, section
 * splitting, project scoping and the namespace constants. No runtime
 * dependencies.
 */
export {
  SWARM_DOCS_NAMESPACE,
  SWARM_META_NAMESPACE,
  SWARM_META_TYPE_NAMES,
  SWARM_NAMESPACE,
  SWARM_ONBOARD_PATH,
  SWARM_PLUGIN_NAME,
  SWARM_PLUGIN_ROUTE_PREFIX,
  SWARM_TYPE_NAMES,
  docsNamespaceFor,
  metaNamespaceFor,
  REJECT_PROMOTION_PATH,
  TRIGGER_DRAINSTOP_PATH,
} from "./constants.js";
export type { SwarmMetaTypeName, SwarmTypeName } from "./constants.js";
export type { DrainstopFailure, DrainstopResult } from "./drainstop.js";
export {
  SWARM_CONTENT_TYPE,
  coerceSimilarityThreshold,
  DEFAULT_RANK_LIMIT,
  OBSERVE_FIELDS,
  OBSERVE_OP_KEY,
  RECALL_CONFIG_CATEGORY,
  RECALL_SIMILARITY_THRESHOLD_DEFAULT,
  RECALL_SIMILARITY_THRESHOLD_KEY,
  RECALL_TOP_K,
} from "./resolver-types.js";
export type {
  SwarmContentEntity,
  ClassifyConfidence,
  ClassifyIntentRequest,
  ClassifyIntentResponse,
  ContextTier,
  IndexedDocument,
  IndexedSection,
  LoadContextFile,
  LoadContextRequest,
  LoadContextResponse,
  LoadedFile,
  LoadingPriorityEntry,
  LoadResult,
  ObserveRequest,
  ObserveResponse,
  OmittedFile,
  PersistTaskTelemetryRequest,
  PersistTaskTelemetryResponse,
  PrepareTaskRequest,
  PrepareTaskResponse,
  ReviewVerdictInput,
  RouteLike,
  RouteMatched,
  SectionRanking,
  SessionEventInput,
  TranscriptEntryInput,
  WorkerResultInput,
} from "./resolver-types.js";
export {
  capSynopsis,
  estimateTokens,
  fallbackSynopsis,
  MAX_FALLBACK_SYNOPSIS,
  MIN_SECTION_TOKENS,
  sectionLineRanges,
  SPLIT_LEVEL3_OVER,
  splitSections,
  synopsisOverride,
} from "./split.js";
export type { SplitSection } from "./split.js";
export {
  isLegacyScoped,
  LEGACY_GLOBAL_PROJECT_ID,
  selectProjectContent,
  selectProjectRoutes,
} from "./project-scope.js";
