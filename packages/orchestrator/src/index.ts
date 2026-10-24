// Orchestrator core
export { Orchestrator, TaskTimeoutError } from "./orchestrator/index.js";
export type { OrchestratorConfig, ParallelDispatchOptions, ParallelDispatchResult } from "./orchestrator/index.js";

// Prerequisites
export { validatePrerequisites } from "./orchestrator/prerequisites.js";

// Discovery
export { runDiscovery } from "./orchestrator/discovery.js";
export type { DiscoveryCommand, DiscoveryResult, DiscoveryPhaseResult } from "./orchestrator/discovery.js";

// Replan
export { analyzeGoalResults, categorizeFailure, diagnoseEmptyOutput } from "./orchestrator/replan.js";
export type { ReplanTaskResult, ReplanDecision, ReplanSubtask, FailureCategory, EmptyOutputDiagnosis } from "./orchestrator/replan.js";

// Conflict history
export { loadConflictHistory, recordConflict, getSerializationFiles } from "./orchestrator/conflict-history.js";
export type { ConflictHistory, ConflictHistoryEntry } from "./orchestrator/conflict-history.js";

// Goal dependencies
export { getExecutableGoals } from "./orchestrator/goal-deps.js";

// DAG utilities
export {
  validateDAG,
  topologicalSort,
  getExecutableTasks,
  applySerializationConstraints,
  applySharedFileConstraints,
  applyCreateModifyConstraints,
  injectDynamicEdges,
  matchesGlob,
} from "./orchestrator/dag.js";
export type { DAGNode, DAGValidationResult, ExecutableTasksResult } from "./orchestrator/dag.js";

// Acceptance verifier
export {
  buildVerificationPrompt,
  createVerificationTask,
  createIntegrationTask,
  parseVerificationOutput,
} from "./orchestrator/acceptance-verifier.js";

// Functional validator
export { runFunctionalChecks } from "./orchestrator/functional-validator.js";
export type { FunctionalCheckResult } from "./orchestrator/functional-validator.js";

// DoD parser
export { parseFunctionalChecks } from "./orchestrator/dod-parser.js";

// Source control
export { SourceControlManager, leftForPersonSection } from "./source-control/index.js";
export type { CompletedGoal, MergeableGoal, MergeGoalOptions, MergeGoalResult, SourceControlManagerOptions, ConflictContext, ConflictResolver } from "./source-control/index.js";
export { GitHubCodeHost, GITHUB_BASE_MOVED_REFUSAL } from "./source-control/github-host.js";
export type { CodeHost, ChangeRequestView, Mergeability, PinnedMergeOutcome } from "./source-control/code-host.js";
export { isPublicationPending, pendingPublications, resumeStackHead, trackGoalPublications, mergeableFromPublication, completedFromPublication, RETRYABLE_LEFT_OPEN_KINDS, MERGE_PRS_MAX_ATTEMPTS } from "./source-control/publications.js";
export type { PublicationSettings, PublicationStore } from "./source-control/publications.js";
export { FileMergeQueue, repoKeyFromRemote, repoKeyFor, defaultMergeQueueDir } from "./source-control/merge-lock.js";
export type { MergeQueue, MergeTurn, MergeTurnRequest, MergeWaiting, FileMergeQueueOptions } from "./source-control/merge-lock.js";
export {
  MERGE_ELIGIBLE_VERDICTS,
  mergeEligibility,
  normalizeLabel,
  runMergeGate,
  redactGateOutput,
  tailLines,
  gateCwd,
} from "./source-control/merge.js";
export type { GateResult, MergeEligibility } from "./source-control/merge.js";
export {
  taskCommitSubject,
  mergeCommitMessage,
  initialCommitMessage,
  gitIdentityEnv,
  validateSourceControlConfig,
  MERGE_PRS_DEFAULT_SKIP_LABELS,
  MERGE_PRS_DEFAULT_GATE_TIMEOUT_MS,
  MERGE_PRS_DEFAULT_MAX_ROUNDS,
  MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS,
  CONVENTIONAL_COMMIT_SUBJECT,
} from "./source-control/commit-policy.js";
export { resolveStackBase, goalBranchName, STACK_PRS_DEFAULT, materializeGoalBranch } from "./source-control/stack.js";
export type { StackBaseInputs } from "./source-control/stack.js";

// Worktree
export { WorktreeManager } from "./worktree/index.js";

// Autonomy
export { deriveAutonomy, validateBudgetConfig, AUTONOMY_PRESETS } from "./autonomy/index.js";

// Conflict anticipation
export { getAnticipatedSerializations, detectFileOverlaps } from "./autonomy/conflict-anticipation.js";
export type { FileOverlap } from "./autonomy/conflict-anticipation.js";

// Complexity
export {
  estimateComplexity,
  createEscalationWatcher,
  subDecompose,
  configToThresholds,
  DEFAULT_COMPLEXITY_THRESHOLDS,
  getTimeoutForComplexity,
} from "./complexity/index.js";
export type { EscalationWatcher } from "./complexity/index.js";

// Decomposition policy
export {
  validateDecompositionConfig,
  effectiveDecomposition,
  describeDecomposition,
  foldTasksToCap,
  planTaskSplit,
  classifyTaskForDispatch,
  SUB_DECOMPOSE_MODES,
} from "./decomposition/index.js";
export type { EffectiveDecomposition, TaskSplitPlan } from "./decomposition/index.js";

// Learning
export { captureRunObservation, formatObservationMd, extractPatterns, extractFailures } from "./learning/capture.js";
export type { CaptureInput } from "./learning/capture.js";

// Goal/TaskExecution Substrate mirror (goal-9)
export {
  mirrorGoalStart,
  mirrorTaskExecutionStart,
  mirrorTaskExecutionEnd,
  linkTaskExecutionWorkerResult,
  readTaskExecutionCounts,
} from "./learning/task-execution-mirror.js";
export type {
  MirrorStatus,
  TaskExecutionEndStatus,
  MirrorGoalStartParams,
  MirrorTaskExecutionStartParams,
  MirrorTaskExecutionEndParams,
  ReadTaskExecutionCountsOptions,
  TaskExecutionCounts,
} from "./learning/task-execution-mirror.js";

// Rate limit gate
export { RateLimitGate } from "./rate-limit-gate.js";

// Ship-readiness gate
export {
  loadShipReadinessContract,
  gateAppliesToGoal,
  runShipReadinessGate,
  defaultCommandRunner,
  defaultFetch,
  buildShipReadinessFollowUpTask,
} from "./ship-readiness/index.js";
export type {
  ShipReadinessContract,
  ShipReadinessGate,
  ShipReadinessGateOutcome,
  ShipReadinessGateResult,
  SmokeEndpoint,
  FailedEndpoint,
  CommandRunner,
  CommandResult,
  Fetch,
  FetchResponse,
  RunShipReadinessGateOpts,
} from "./ship-readiness/index.js";
