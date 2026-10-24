// Re-export everything from @mnmal-ai/swarm-core
export {
  Swarm,
  resolvePreReadConfig,
  selectReviewerFiles,
  Router,
  Loader,
  AnthropicProvider,
  OpenAIProvider,
  createProvider,
  BUILTIN_TOOLS,
  getBuiltinTools,
  executeTool,
  SkillFetcher,
} from "@mnmal-ai/swarm-core";
export type { SwarmDeps } from "@mnmal-ai/swarm-core";

// Re-export from other extracted packages
export { Telemetry } from "@mnmal-ai/swarm-telemetry";
export { SwarmEventBus } from "@mnmal-ai/swarm-events";
export { formatTokens, matchesGlob } from "@mnmal-ai/swarm-types";
export { ClaimRegistry, computeClaimAccuracy } from "@mnmal-ai/swarm-telemetry";
export {
  LocalTaskBackend,
  GitHubTaskBackend,
  createTaskBackend,
} from "@mnmal-ai/swarm-task-backends";
export {
  resolveWorkerBackend,
  detectAvailableBackends,
  ApiWorkerBackend,
  ClaudeCodeBackend,
} from "@mnmal-ai/swarm-worker-backends";

// Re-export from @mnmal-ai/swarm-oversight
export { Oversight, validateWorkerOutput, captureGitDiff } from "@mnmal-ai/swarm-oversight";

// Re-export from @mnmal-ai/swarm-benchmark
export { BenchmarkRunner } from "@mnmal-ai/swarm-benchmark";

// Re-export from @mnmal-ai/swarm-orchestrator
export {
  Orchestrator,
  TaskTimeoutError,
  validatePrerequisites,
  SourceControlManager,
  runDiscovery,
  estimateComplexity,
  createEscalationWatcher,
  subDecompose,
  configToThresholds,
  DEFAULT_COMPLEXITY_THRESHOLDS,
  loadConflictHistory,
  recordConflict,
  getSerializationFiles,
} from "@mnmal-ai/swarm-orchestrator";
export type {
  OrchestratorConfig,
  ParallelDispatchOptions,
  ParallelDispatchResult,
  DiscoveryCommand,
  DiscoveryResult,
  DiscoveryPhaseResult,
  ConflictHistory,
  ConflictHistoryEntry,
} from "@mnmal-ai/swarm-orchestrator";

// Re-export from @mnmal-ai/swarm-cli
export { Scanner, DashboardServer, aggregateEvents } from "@mnmal-ai/swarm-cli";

// Re-export all types
export type * from "@mnmal-ai/swarm-types";
