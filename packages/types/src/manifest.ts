/**
 * swarm.json manifest types.
 *
 * These types map directly to the structure of the swarm.json routing manifest
 * in the swarm content repo.
 */

// ---------------------------------------------------------------------------
// swarm.json manifest types
// ---------------------------------------------------------------------------

export interface SwarmManifest {
  version: string;
  description: string;
  context_budget: ContextBudget;
  complexity?: ComplexityConfig;
  routes: Route[];
  fallback: FallbackRoute;
}

export interface ComplexityConfig {
  description?: string;
  simple_max: number;
  complex_min: number;
  escalation: {
    /** Share of the task token limit at which a running task escalates. */
    token_fraction: number;
    turn_fraction: number;
    timeout_fraction: number;
  };
}

export interface ContextBudget {
  description?: string;
  default_max_tokens: number;
  model_overrides: Record<string, number>;
  loading_priority: LoadingPriorityEntry[];
}

export interface LoadingPriorityEntry {
  tier: ContextTier;
  required: boolean;
  description?: string;
}

export type ContextTier =
  | "core"
  | "secrets"
  | "mode"
  | "oversight"
  | "capabilities"
  | "domain"
  | "skills_vetted"
  | "skills_community";

export interface Route {
  intent: string;
  description: string;
  load: Record<string, string[]>;
  keywords: string[];
}

export interface FallbackRoute {
  description: string;
  load: Record<string, string[]>;
}
