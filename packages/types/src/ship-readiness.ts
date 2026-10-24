/**
 * Ship-readiness contract types.
 *
 * The base shape (`platform`, `target`, `schemaVersion`, `gates`, `promoteCommand`)
 * mirrors the ship-readiness.json templates authored by the goal-6a suggestion flow
 * at packages/cli/src/scaffold/suggestions/templates/*-deploy/ship-readiness.json.
 * The orchestrator-consumed fields (`goalIds`, `smokeEndpoints`) are additive and
 * optional so those existing catalog templates still validate against this shape.
 */

/** A single gate in the ship-readiness checklist. Matches the template JSON exactly. */
export interface ShipReadinessGate {
  id: string;
  description: string;
  required: boolean;
}

/**
 * A smoke endpoint the orchestrator polls after running the deploy command.
 * Only `url` is required; the assertion fields narrow what counts as a pass.
 */
export interface SmokeEndpoint {
  url: string;
  /** Expected HTTP status. Defaults to 200 when omitted. */
  expectStatus?: number;
  /** JSONPath into the response body to extract a value for comparison. */
  jsonPath?: string;
  /** Value the extracted `jsonPath` result must deep-equal. */
  expectEquals?: unknown;
}

/**
 * Ship-readiness contract.
 *
 * REUSES the goal-6a suggestion-flow schema (the first five fields, which the
 * catalog JSON templates serialize) and EXTENDS it with the orchestrator-consumed
 * fields the presence gate needs. The extended fields are optional so the existing
 * catalog templates — which do not set them — still satisfy this interface.
 */
export interface ShipReadinessContract {
  /** Comment marker present in scaffolded templates (e.g. "$comment"). */
  $comment?: string;
  platform: string;
  target: string;
  schemaVersion: string;
  gates: ShipReadinessGate[];
  promoteCommand: string;

  // --- Orchestrator-consumed extensions (additive, optional) ---

  /** Goal IDs this contract gates. Absent in base catalog templates. */
  goalIds?: string[];
  /** Endpoints polled after deploy to confirm the release is healthy. */
  smokeEndpoints?: SmokeEndpoint[];
}

/** Outcome of running the presence-triggered ship-readiness gate. */
export type ShipReadinessGateOutcome = "passed" | "deploy-failed" | "smoke-failed";

/**
 * A smoke endpoint that did not pass, with enough detail to triage.
 *
 * Part of the public ship-readiness gate-result shape: a downstream consumer
 * (review UI, log analyzer, post-mortem tool) inspecting a `smoke-failed`
 * result needs the same per-endpoint detail the orchestrator produces.
 */
export interface FailedEndpoint {
  url: string;
  /** Expected HTTP status (from the contract; 200 when the contract omits it). */
  expectedStatus: number;
  /** Status actually returned, or null when the request itself failed. */
  actualStatus: number | null;
  /** Human-readable cause: status mismatch, JSON assertion mismatch, or network error. */
  reason: string;
}

/**
 * Result of running the presence-triggered ship-readiness gate.
 *
 * Discriminated union keyed on `outcome` so each failure mode carries exactly
 * the evidence a reviewer needs to act on it — a smoke-test failure can never
 * be mistaken for (or mask) a deploy-step failure. This is the same shape the
 * orchestrator's gate runner produces at runtime; importing this type from
 * `@mnmal-ai/swarm-types` gives downstream consumers the actual runtime
 * shape, not a phantom interface.
 */
export type ShipReadinessGateResult =
  | { outcome: "passed" }
  | { outcome: "deploy-failed"; deployExitCode: number; deployStderr: string }
  | { outcome: "smoke-failed"; failedEndpoints: FailedEndpoint[] };
