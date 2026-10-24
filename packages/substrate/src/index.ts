/**
 * `@mnmal-ai/swarm-substrate`: the swarm's client for its Substrate sidecars
 * (an HTTP client for the swarm, swarm-docs and swarm_meta namespaces) and the
 * sidecar lifecycle (Node runtime, stack directories, spawn, stop, readiness).
 */

// --- Client ---
export { HEALTH_TIMEOUT_MS, SubstrateClient, SubstrateFrameError } from "./client.js";
export type {
  BatchMutateOperation,
  SwarmQueryClient,
  FieldSelection,
  IngestResponse,
  SubstrateClientOptions,
  SubstrateNamespaceSchema,
  SubstrateSchema,
} from "./client.js";
export { DEFAULT_REQUEST_TIMEOUT_MS, SubstrateHttpError, SubstrateTimeoutError } from "./transport/http-transport.js";
export type { SubstrateEnvelopeError, SubstrateResponseEnvelope } from "./transport/types.js";
export { TaskTelemetryBuffer } from "./task-telemetry-buffer.js";
export { subscribeOrPoll } from "./subscribe-or-poll.js";
export type {
  SubscribeArgs,
  SubscribeMessage,
  SubscribeMessageHandler,
  SubscribeOrPollHandle,
  SubscribeOrPollOptions,
} from "./subscribe-or-poll.js";

// --- Documents ---
export {
  DEFAULT_SYNC_CONCURRENCY,
  documentTitle,
  MAX_SYNC_CONCURRENCY,
  SYNOPSIS_BATCH_BYTES,
  SYNOPSIS_BATCH_SECTIONS,
  substrateDocsStore,
  syncDocuments,
} from "./sections/sync.js";
export type {
  DocsStore,
  DocumentSource,
  SectionRecord,
  SourceFile,
  StoredDocument,
  SyncOptions,
  SyncProgress,
  SyncReport,
  SynopsisRequest,
  SynopsisWriter,
} from "./sections/sync.js";

// --- Embedder ---
export {
  DEFAULT_EMBED_TIMEOUT_MS,
  KNOWN_EMBEDDING_DIMENSIONS,
  resolveEmbedderSettings,
  resolveOllamaUrl,
} from "./embedder-settings.js";
export type { EmbedderKind, EmbedderSettings } from "./embedder-settings.js";

// --- local_only ---
export {
  collectLocalOnlyViolations,
  isLocalOnlyEnv,
  isLoopbackHost,
  LOCAL_ONLY_ENV,
  LocalOnlyViolation,
  loopbackViolation,
  postgresLoopbackViolation,
} from "./local-only.js";
export type { LocalOnlyTargets } from "./local-only.js";

// --- Lifecycle ---
export {
  DEFAULT_META_PORT,
  DEFAULT_META_POSTGRES_URL,
  DEFAULT_POSTGRES_URL,
  DEFAULT_SUBSTRATE_PORT,
  resolveSidecarSpecs,
  SIDECAR_SPECS,
  sidecarUrl,
  specFor,
} from "./lifecycle/specs.js";
export type { SidecarSpec } from "./lifecycle/specs.js";
export {
  assertLocalOnly,
  swarmConfigPath,
  resolveLocalOnlyTargets,
  resolveMetaEndpoint,
  resolveMetaEndpointWithSource,
  resolveSubstrateEndpoint,
  resolveSubstrateEndpointWithSource,
} from "./lifecycle/endpoint.js";
export type { ResolvedEndpoint } from "./lifecycle/endpoint.js";
export {
  CORTEXT_VERSION,
  defaultRuntimeDir,
  ensureRuntimeInstalled,
  findInstalledRuntime,
  NODE_VERSION_FLOOR,
  NodeVersionError,
  npmFor,
  PLUGIN_PACKAGE_NAME,
  RuntimeInstallError,
  resolveNode,
  SUBSTRATE_VERSION,
  substrateBinFor,
  substrateHome,
} from "./lifecycle/runtime.js";
export type { EnsureRuntimeOptions, ResolvedNode, RuntimeInfo } from "./lifecycle/runtime.js";
export { ensureStackDir, stackDirFor, stacksRoot, WRITE_EMBED_TIMEOUT_MS } from "./lifecycle/stacks.js";
export type { EnsureStackDirOptions } from "./lifecycle/stacks.js";
export {
  ensureSidecar,
  processInfo,
  readSidecarPid,
  SIDECAR_BOOT_TIMEOUT_MS,
  SidecarStartError,
  sidecarEnv,
  sidecarHealthy,
  stopSidecar,
  systemActorFor,
} from "./lifecycle/sidecar.js";
export type { EnsureSidecarOptions, SidecarStatus, StopSidecarOptions, StopSidecarResult } from "./lifecycle/sidecar.js";
export {
  ensureDedicatedPostgres,
  ensurePostgres,
  findRepoRoot,
  infrastructureDir,
  isMemoryStore,
  isSubstrateComposeDir,
  probePostgresReachable,
  resolveComposeDir,
} from "./lifecycle/postgres.js";
export type { DedicatedPostgres } from "./lifecycle/postgres.js";
export {
  SWARM_DOCS_TYPE_NAMES,
  SWARM_MUTATION_OPS,
  SWARM_QUERY_OPS,
  DEFAULT_CONTEXT_NAMESPACE,
  ensureAllSidecars,
  ensureSubstrateReady,
  ensureTypesRegistered,
  isManagedEndpoint,
  probeNamespaceSchema,
  SubstrateRuntimeMissingError,
} from "./lifecycle/ready.js";
export type { EnsureAllSidecarsOptions, EnsureSubstrateReadyOptions } from "./lifecycle/ready.js";

// --- From the shared package, for consumers that imported them from the old client ---
export {
  SWARM_DOCS_NAMESPACE,
  SWARM_META_NAMESPACE,
  SWARM_META_TYPE_NAMES,
  SWARM_NAMESPACE,
  SWARM_ONBOARD_PATH,
  SWARM_TYPE_NAMES,
  coerceSimilarityThreshold,
  DEFAULT_RANK_LIMIT,
  docsNamespaceFor,
  estimateTokens,
  fallbackSynopsis,
  isLegacyScoped,
  LEGACY_GLOBAL_PROJECT_ID,
  metaNamespaceFor,
  OBSERVE_OP_KEY,
  RECALL_CONFIG_CATEGORY,
  RECALL_SIMILARITY_THRESHOLD_DEFAULT,
  RECALL_SIMILARITY_THRESHOLD_KEY,
  RECALL_TOP_K,
  REJECT_PROMOTION_PATH,
  selectProjectContent,
  selectProjectRoutes,
  splitSections,
  synopsisOverride,
  TRIGGER_DRAINSTOP_PATH,
} from "@mnmal-ai/swarm-substrate-shared";
export type {
  SwarmMetaTypeName,
  SwarmTypeName,
  ClassifyConfidence,
  ClassifyIntentRequest,
  ClassifyIntentResponse,
  DrainstopFailure,
  DrainstopResult,
  IndexedDocument,
  IndexedSection,
  LoadContextFile,
  LoadContextRequest,
  LoadContextResponse,
  ObserveRequest,
  ObserveResponse,
  PersistTaskTelemetryRequest,
  PersistTaskTelemetryResponse,
  PrepareTaskRequest,
  PrepareTaskResponse,
  ReviewVerdictInput,
  RouteMatched,
  SectionRanking,
  SessionEventInput,
  SplitSection,
  TranscriptEntryInput,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate-shared";
