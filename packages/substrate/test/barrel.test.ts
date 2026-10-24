/**
 * Every name the consumers import from the Substrate barrel
 * (packages/<pkg>/src|tests, tests/ and scripts/) exists in this one. Values
 * are checked here; the type-only import below fails `tsc` if a type is
 * missing.
 *
 * Deliberately not exported (they live in the plugin or are gone): the
 * in-process host, relabel, the WebSocket push path, backfillEmbeddings, and
 * the plugin's own exports (createSwarmPlugin, createSwarmMetaPlugin,
 * createSwarmCombinedPlugin, the classifyIntent and loadContext resolver
 * functions, sectionEmbedText, SwarmRecallDeps).
 */
import { describe, expect, it } from "vitest";
import type {
  SwarmQueryClient,
  ClassifyIntentRequest,
  ClassifyIntentResponse,
  DrainstopResult,
  EnsureSubstrateReadyOptions,
  FieldSelection,
  IndexedDocument,
  IndexedSection,
  IngestResponse,
  LoadContextFile,
  LoadContextRequest,
  ObserveRequest,
  ObserveResponse,
  PersistTaskTelemetryRequest,
  ReviewVerdictInput,
  SessionEventInput,
  SidecarSpec,
  SourceFile,
  SubscribeArgs,
  SubscribeMessage,
  SubscribeMessageHandler,
  SubscribeOrPollHandle,
  SyncOptions,
  SyncProgress,
  SyncReport,
  SynopsisWriter,
  TranscriptEntryInput,
  WorkerResultInput,
} from "../src/index.js";
import * as barrel from "../src/index.js";

/** Referenced so the type-only import above is checked, not elided as unused. */
export type ConsumerTypes = [
  SwarmQueryClient,
  ClassifyIntentRequest,
  ClassifyIntentResponse,
  DrainstopResult,
  EnsureSubstrateReadyOptions,
  FieldSelection,
  IndexedDocument,
  IndexedSection,
  IngestResponse,
  LoadContextFile,
  LoadContextRequest,
  ObserveRequest,
  ObserveResponse,
  PersistTaskTelemetryRequest,
  ReviewVerdictInput,
  SessionEventInput,
  SidecarSpec,
  SourceFile,
  SubscribeArgs,
  SubscribeMessage,
  SubscribeMessageHandler,
  SubscribeOrPollHandle,
  SyncOptions,
  SyncProgress,
  SyncReport,
  SynopsisWriter,
  TranscriptEntryInput,
  WorkerResultInput,
];

const CONSUMER_VALUES = [
  "SWARM_DOCS_NAMESPACE",
  "SWARM_META_TYPE_NAMES",
  "SWARM_TYPE_NAMES",
  "DEFAULT_CONTEXT_NAMESPACE",
  "DEFAULT_EMBED_TIMEOUT_MS",
  "SubstrateClient",
  "KNOWN_EMBEDDING_DIMENSIONS",
  "LocalOnlyViolation",
  "MAX_SYNC_CONCURRENCY",
  "RECALL_CONFIG_CATEGORY",
  "RECALL_SIMILARITY_THRESHOLD_DEFAULT",
  "RECALL_SIMILARITY_THRESHOLD_KEY",
  "SIDECAR_SPECS",
  "TRIGGER_DRAINSTOP_PATH",
  "TaskTelemetryBuffer",
  "assertLocalOnly",
  "coerceSimilarityThreshold",
  "ensureAllSidecars",
  "ensureSubstrateReady",
  "ensurePostgres",
  "ensureTypesRegistered",
  "fallbackSynopsis",
  "findRepoRoot",
  "substrateDocsStore",
  "isLocalOnlyEnv",
  "isLoopbackHost",
  "probeNamespaceSchema",
  "probePostgresReachable",
  "resolveLocalOnlyTargets",
  "selectProjectContent",
  "subscribeOrPoll",
  "syncDocuments",
];

describe("the package barrel", () => {
  it("exports every value consumers import from the Substrate barrel", () => {
    const exported = barrel as Record<string, unknown>;
    const missing = CONSUMER_VALUES.filter((n) => exported[n] === undefined);
    expect(missing).toEqual([]);
  });

  it("re-exports the shared values consumers need", () => {
    expect(barrel.TRIGGER_DRAINSTOP_PATH).toBe("/substrate/v1/plugins/swarm/trigger-drainstop");
    expect(barrel.coerceSimilarityThreshold("0.4")).toBe(0.4);
    expect(typeof barrel.fallbackSynopsis).toBe("function");
    expect(typeof barrel.selectProjectContent).toBe("function");
  });
});
