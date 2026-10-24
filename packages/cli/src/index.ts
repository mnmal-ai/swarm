// @mnmal-ai/swarm-cli — public exports
export { Scanner } from "./scanner/index.js";
export { DashboardServer } from "./server/index.js";
export { detectProject } from "./detect/index.js";
export type { ProjectInfo, EnvVarInfo } from "./detect/index.js";
export { startAnimation } from "./animation/index.js";
export {
  scaffold,
  getBackendPreset,
  type FillLevel,
  type RuntimeBackend,
  type GuidedAnswers,
  type ScaffoldConfig,
  type ScaffoldResult,
  type BackendPreset,
} from "./scaffold/index.js";
export { getSkillTemplate } from "./scaffold/skill-templates/index.js";
export { aggregateEvents, type AggregateOptions } from "./cli/grade-data.js";
export { evaluateSessionBudget } from "./cli/budget-guard.js";
export type {
  BudgetGuard,
  BudgetWarnState,
  BudgetDecision,
} from "./cli/budget-guard.js";
export { resolveSkillSlug } from "./cli/add.js";
export { VERSION, COMMIT_HASH } from "./version.js";
export { SUGGESTION_AXES } from "./scaffold/suggestions/types.js";
export type {
  SuggestionAxis,
  DetectionSignal,
  CatalogEntry,
} from "./scaffold/suggestions/types.js";
export {
  loadCatalog,
  detectEnvironment,
  matchSuggestions,
} from "./scaffold/suggestions/matcher.js";
export type { DetectionReport } from "./scaffold/suggestions/matcher.js";
export { buildSuggestionFlowBody } from "./scaffold/suggestions/flow-prompt.js";
export type {
  SuggestionsLog,
  SuggestionLogEntry,
  SuggestionsLogDetection,
} from "./scaffold/templates/suggestions-log-schema.js";
export { seedSwarmContent } from "./cli/seed.js";
